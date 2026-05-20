'use strict';

// esewsub — SubBots & EsewBot Framework
// بحقوق 𝐄𝐒𝐂𝐀𝐍𝛩𝐑 | github:moreand458-eng/esewsub
// Build: CJS (index.cjs)

Object.defineProperty(exports, '__esModule', { value: true });

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const pino = require('pino');

const SESSIONS_DIR = './sessions';
const DB_DIR = './sub_db';
const logger = pino({ level: 'silent' });

// ── Storage ──

class SubStorage {
  constructor() {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    this._file = path.join(DB_DIR, 'subs.json');
    this._data = {};
    this._load();
  }
  _load() {
    try {
      if (fs.existsSync(this._file)) {
        this._data = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
      }
    } catch { this._data = {}; }
  }
  _persist() {
    try { fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2)); } catch {}
  }
  save(uid, data) { this._data[uid] = { ...(this._data[uid] || {}), ...data }; this._persist(); }
  load() { return Object.entries(this._data).map(([uid, v]) => ({ uid, sock: null, connected: false, ...v })); }
  delete(uid) { delete this._data[uid]; this._persist(); }
  has(uid) { return uid in this._data; }
}

// ── SubBots ──

class SubBots extends EventEmitter {
  constructor(commandSystem) {
    super();
    this._commandSystem = commandSystem || {};
    this._config = {};
    this._bots = new Map();
    this._storage = new SubStorage();
    SubBots._defaultPairingCode = SubBots._defaultPairingCode || 'ESCANOR1';
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  static pariCode(code) { SubBots._defaultPairingCode = code; }

  async setConfig(cfg) { this._config = { ...this._config, ...cfg }; }

  async load() {
    const saved = this._storage.load();
    let count = 0;
    for (const bot of saved) {
      if (bot.number) { await this._connect(bot.uid, bot.number); count++; }
    }
    return count;
  }

  get(uid) { return this._bots.get(uid); }
  getAll() { return Array.from(this._bots.values()); }

  async add(number) {
    const uid = `sub_${number.replace(/[^0-9]/g, '')}_${Date.now()}`;
    this._storage.save(uid, { uid, number });
    await this._connect(uid, number);
    return uid;
  }

  async remove(uid) {
    const bot = this._bots.get(uid);
    if (bot && bot.sock) { try { bot.sock.end(undefined); } catch {} }
    this._bots.delete(uid);
    this._storage.delete(uid);
    const sp = path.join(SESSIONS_DIR, uid);
    if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
  }

  async requestPairingCode(uid) {
    const bot = this._bots.get(uid);
    if (!bot || !bot.sock) return null;
    try {
      const code = await bot.sock.requestPairingCode(bot.number ? bot.number.replace(/[^0-9]/g, '') : '');
      bot.pairingCode = code;
      this.emit('pair', uid, code);
      return code;
    } catch { return null; }
  }

  async _connect(uid, number) {
    const sp = path.join(SESSIONS_DIR, uid);
    if (!fs.existsSync(sp)) fs.mkdirSync(sp, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sp);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: this._config.printQR !== undefined ? this._config.printQR : false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true
    });

    const instance = { uid, sock, connected: false, number };
    this._bots.set(uid, instance);

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
        this._storage.save(uid, { uid, number });
        saveCreds();
        this.emit('ready', uid, sock);
      }

      if (connection === 'close') {
        const reason = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : undefined;
        instance.connected = false;
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden) {
          this.emit('badSession', uid);
          await this.remove(uid);
          return;
        }
        this.emit('close', uid);
        setTimeout(() => this._connect(uid, number), 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        this.emit('message', uid, msg, sock);
        if (this._commandSystem && this._commandSystem.handle) {
          try { await this._commandSystem.handle(sock, msg, uid); }
          catch (e) { this.emit('error', uid, e); }
        }
      }
    });

    sock.ev.on('group-participants.update', (update) => {
      this.emit('groupParticipantsUpdate', uid, update, sock);
    });
  }
}

// ── EsewBot ──

class EsewBot extends EventEmitter {
  constructor(config) {
    super();
    this._config = config;
    this._commands = new Map();
    this._sock = null;
  }

  registerCommand(names, handler, meta) {
    meta = meta || {};
    const cmd = { handler, name: names, ...meta };
    for (const name of names) this._commands.set(name.toLowerCase(), cmd);
  }

  getCommands() { return this._commands; }

  async start() {
    const sp = this._config.sessionPath || './session';
    if (!fs.existsSync(sp)) fs.mkdirSync(sp, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sp);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: this._config.printQR !== undefined ? this._config.printQR : false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true
    });

    this._sock = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !state.creds.registered) {
        try {
          const code = await sock.requestPairingCode(this._config.number.replace(/[^0-9]/g, ''));
          this.emit('pair', code);
          console.log('\n🔐 كود الربط: ' + code + '\n');
        } catch {}
      }
      if (connection === 'open') this.emit('ready', sock);
      if (connection === 'close') {
        const reason = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
          ? lastDisconnect.error.output.statusCode : undefined;
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
        await this._handleMessage(sock, msg);
      }
    });
  }

  async _handleMessage(sock, msg) {
    const body = this._extractBody(msg);
    const sender = msg.key.participant || msg.key.remoteJid || '';
    const chat = msg.key.remoteJid || '';
    const isGroup = chat.endsWith('@g.us');
    const owners = this._config.owners || [];
    const isOwner = owners.includes(sender.split('@')[0]) || owners.includes(sender);

    const prefixes = Array.isArray(this._config.prefix)
      ? this._config.prefix : [this._config.prefix || '!'];

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
        isBotAdmin = admins.includes(((sock.user && sock.user.id) ? sock.user.id.replace(/:\d+/, '') : '') + '@s.whatsapp.net');
      } catch {}
    }

    const ctx = {
      sock, msg, sender, chat, isGroup,
      name: msg.pushName || sender.split('@')[0],
      body, prefix: usedPrefix, command, args, text,
      quoted: null,
      reply: async (content) => {
        if (typeof content === 'string') await sock.sendMessage(chat, { text: content }, { quoted: msg });
        else await sock.sendMessage(chat, content, { quoted: msg });
      },
      react: async (emoji) => sock.sendMessage(chat, { react: { text: emoji, key: msg.key } }),
      isOwner, isAdmin, isBotAdmin, groupMetadata
    };

    this.emit('message', ctx);
    if (!command) return;

    const cmd = this._commands.get(command);
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

  _extractBody(msg) {
    const m = msg.message;
    if (!m) return '';
    return (
      m.conversation ||
      (m.extendedTextMessage && m.extendedTextMessage.text) ||
      (m.imageMessage && m.imageMessage.caption) ||
      (m.videoMessage && m.videoMessage.caption) ||
      (m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText) ||
      (m.listResponseMessage && m.listResponseMessage.singleSelectReply && m.listResponseMessage.singleSelectReply.selectedRowId) ||
      (m.templateButtonReplyMessage && m.templateButtonReplyMessage.selectedDisplayText) ||
      ''
    );
  }
}

exports.EsewBot = EsewBot;
exports.SubBots = SubBots;
exports.default = { EsewBot, SubBots };
