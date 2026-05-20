// esewsub — SubBots & EsewBot Framework
// بحقوق 𝐄𝐒𝐂𝐀𝐍𝛩𝐑 | github:moreand458-eng/esewsub
// Build: ESM (index.mjs)

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────

const SESSIONS_DIR = './sessions';
const DB_DIR = './sub_db';
const logger = pino({ level: 'silent' });

// ─────────────────────────────────────────────
//  Simple JSON-file storage (no LevelDB dep)
// ─────────────────────────────────────────────

class SubStorage {
  #file;
  #data = {};

  constructor() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    this.#file = path.join(DB_DIR, 'subs.json');
    this.#load();
  }

  #load() {
    try {
      if (fs.existsSync(this.#file)) {
        this.#data = JSON.parse(fs.readFileSync(this.#file, 'utf-8'));
      }
    } catch { this.#data = {}; }
  }

  #persist() {
    try { fs.writeFileSync(this.#file, JSON.stringify(this.#data, null, 2)); } catch {}
  }

  save(uid, data) { this.#data[uid] = { ...(this.#data[uid] || {}), ...data }; this.#persist(); }
  load() { return Object.entries(this.#data).map(([uid, v]) => ({ uid, sock: null, connected: false, ...v })); }
  delete(uid) { delete this.#data[uid]; this.#persist(); }
  has(uid) { return uid in this.#data; }
}

// ─────────────────────────────────────────────
//  SubBots
// ─────────────────────────────────────────────

class SubBots extends EventEmitter {
  #commandSystem;
  #config = {};
  #bots = new Map();
  #storage;
  static #defaultPairingCode = 'ESCANOR1';

  constructor(commandSystem) {
    super();
    this.#commandSystem = commandSystem || {};
    this.#storage = new SubStorage();
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  static pariCode(code) { SubBots.#defaultPairingCode = code; }

  async setConfig(cfg) { this.#config = { ...this.#config, ...cfg }; }

  async load() {
    const saved = this.#storage.load();
    let count = 0;
    for (const bot of saved) {
      if (bot.number) { await this.#connect(bot.uid, bot.number); count++; }
    }
    return count;
  }

  get(uid) { return this.#bots.get(uid); }
  getAll() { return Array.from(this.#bots.values()); }

  async add(number) {
    const uid = `sub_${number.replace(/[^0-9]/g, '')}_${Date.now()}`;
    this.#storage.save(uid, { uid, number });
    await this.#connect(uid, number);
    return uid;
  }

  async remove(uid) {
    const bot = this.#bots.get(uid);
    if (bot?.sock) { try { bot.sock.end(undefined); } catch {} }
    this.#bots.delete(uid);
    this.#storage.delete(uid);
    const sp = path.join(SESSIONS_DIR, uid);
    if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
  }

  async requestPairingCode(uid) {
    const bot = this.#bots.get(uid);
    if (!bot?.sock) return null;
    try {
      const code = await bot.sock.requestPairingCode(bot.number?.replace(/[^0-9]/g, '') || '');
      bot.pairingCode = code;
      this.emit('pair', uid, code);
      return code;
    } catch { return null; }
  }

  async #connect(uid, number) {
    const sp = path.join(SESSIONS_DIR, uid);
    if (!fs.existsSync(sp)) fs.mkdirSync(sp, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sp);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: this.#config.printQR ?? false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true
    });

    const instance = { uid, sock, connected: false, number };
    this.#bots.set(uid, instance);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        try {
          const code = await sock.requestPairingCode(number.replace(/[^0-9]/g, ''));
          instance.pairingCode = code;
          this.emit('pair', uid, code);
        } catch {}
      }

      if (connection === 'open') {
        instance.connected = true;
        this.#storage.save(uid, { uid, number });
        saveCreds();
        this.emit('ready', uid, sock);
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        instance.connected = false;
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden) {
          this.emit('badSession', uid);
          await this.remove(uid);
          return;
        }
        this.emit('close', uid);
        setTimeout(() => this.#connect(uid, number), 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        this.emit('message', uid, msg, sock);
        if (this.#commandSystem?.handle) {
          try { await this.#commandSystem.handle(sock, msg, uid); }
          catch (e) { this.emit('error', uid, e); }
        }
      }
    });

    sock.ev.on('group-participants.update', (update) => {
      this.emit('groupParticipantsUpdate', uid, update, sock);
    });
  }
}

// ─────────────────────────────────────────────
//  EsewBot — single-bot class
// ─────────────────────────────────────────────

class EsewBot extends EventEmitter {
  #config;
  #commands = new Map();
  #sock = null;

  constructor(config) {
    super();
    this.#config = config;
  }

  registerCommand(names, handler, meta = {}) {
    const cmd = { handler, name: names, ...meta };
    for (const name of names) this.#commands.set(name.toLowerCase(), cmd);
  }

  getCommands() { return this.#commands; }

  async start() {
    const sp = this.#config.sessionPath || './session';
    if (!fs.existsSync(sp)) fs.mkdirSync(sp, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sp);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: this.#config.printQR ?? false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true
    });

    this.#sock = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !state.creds.registered) {
        try {
          const code = await sock.requestPairingCode(this.#config.number.replace(/[^0-9]/g, ''));
          this.emit('pair', code);
          console.log(`\n🔐 كود الربط: ${code}\n`);
        } catch {}
      }
      if (connection === 'open') this.emit('ready', sock);
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden) {
          this.emit('logout'); return;
        }
        setTimeout(() => this.start(), 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        await this.#handleMessage(sock, msg);
      }
    });
  }

  async #handleMessage(sock, msg) {
    const body = this.#extractBody(msg);
    const sender = msg.key.participant || msg.key.remoteJid || '';
    const chat = msg.key.remoteJid || '';
    const isGroup = chat.endsWith('@g.us');
    const owners = this.#config.owners || [];
    const isOwner = owners.includes(sender.split('@')[0]) || owners.includes(sender);

    const prefixes = Array.isArray(this.#config.prefix)
      ? this.#config.prefix : [this.#config.prefix || '!'];

    let usedPrefix = '', command = '', args = [], text = '';
    for (const p of prefixes) {
      if (body.startsWith(p)) {
        usedPrefix = p;
        const parts = body.slice(p.length).trim().split(/\s+/);
        command = (parts.shift() || '').toLowerCase();
        args = parts; text = parts.join(' '); break;
      }
    }

    let groupMetadata = null, isAdmin = false, isBotAdmin = false;
    if (isGroup) {
      try {
        groupMetadata = await sock.groupMetadata(chat);
        const admins = groupMetadata.participants.filter(p => p.admin).map(p => p.id);
        isAdmin = admins.includes(sender);
        isBotAdmin = admins.includes((sock.user?.id?.replace(/:\d+/, '') || '') + '@s.whatsapp.net');
      } catch {}
    }

    const ctx = {
      sock, msg, sender, chat, isGroup,
      name: msg.pushName || sender.split('@')[0],
      body, prefix: usedPrefix, command, args, text,
      quoted: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
        ? { message: msg.message.extendedTextMessage.contextInfo.quotedMessage, key: { id: msg.message.extendedTextMessage.contextInfo.stanzaId, remoteJid: chat, fromMe: false, participant: msg.message.extendedTextMessage.contextInfo.participant } }
        : null,
      reply: async (content) => {
        if (typeof content === 'string') await sock.sendMessage(chat, { text: content }, { quoted: msg });
        else await sock.sendMessage(chat, content, { quoted: msg });
      },
      react: async (emoji) => sock.sendMessage(chat, { react: { text: emoji, key: msg.key } }),
      isOwner, isAdmin, isBotAdmin, groupMetadata
    };

    this.emit('message', ctx);
    if (!command) return;

    const cmd = this.#commands.get(command);
    if (!cmd) { this.emit('commandNotFound', ctx); return; }

    try {
      if (cmd.ownerOnly && !isOwner) { await ctx.reply('❌ هذا الأمر للمطور فقط!'); return; }
      if (cmd.groupOnly && !isGroup) { await ctx.reply('❌ هذا الأمر يعمل في المجموعات فقط!'); return; }
      if (cmd.privateOnly && isGroup) { await ctx.reply('❌ هذا الأمر يعمل في المحادثات الخاصة فقط!'); return; }
      if (cmd.adminOnly && !isAdmin) { await ctx.reply('❌ هذا الأمر للأدمنز فقط!'); return; }
      if (cmd.botAdminOnly && !isBotAdmin) { await ctx.reply('❌ أنا محتاج صلاحية أدمن!'); return; }
      await cmd.handler(ctx);
    } catch (err) { this.emit('commandError', ctx, err, cmd); }
  }

  #extractBody(msg) {
    const m = msg.message;
    if (!m) return '';
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.listResponseMessage?.singleSelectReply?.selectedRowId ||
      m.templateButtonReplyMessage?.selectedDisplayText ||
      ''
    );
  }
}

export { EsewBot, SubBots };
export default { EsewBot, SubBots };
