import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  WASocket,
  proto,
  AnyMessageContent,
  MessageUpsertType
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import EventEmitter from 'events';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { Level } from 'level';

// ─────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────

export interface SubBotConfig {
  commandsPath?: string;
  owners?: string[];
  prefix?: string | string[];
  info?: Record<string, any>;
  printQR?: boolean;
  sessionDir?: string;
}

export interface SubBotInstance {
  uid: string;
  sock: WASocket | null;
  connected: boolean;
  pairingCode?: string;
  number?: string;
}

export interface CommandSystem {
  handle?: (sock: WASocket, msg: proto.IWebMessageInfo, uid?: string) => Promise<void>;
}

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────

const SESSIONS_DIR = './sessions';
const DB_DIR = './sub_db';

// ─────────────────────────────────────────────
//  Logger (silent for library use)
// ─────────────────────────────────────────────

const logger = pino({ level: 'silent' });

// ─────────────────────────────────────────────
//  [4] Temp/Cache Cleanup Helpers
// ─────────────────────────────────────────────

/**
 * Deletes files inside a directory that are older than maxAgeMs.
 * The directory itself is never removed.
 */
function _cleanDirectory(dir: string, maxAgeMs: number = 0): void {
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs >= maxAgeMs) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

/**
 * Starts a periodic cleanup for the given directory.
 * Defaults: runs every hour, removes files older than 1 hour.
 * Returns the interval handle so it can be stopped on shutdown.
 */
function _startAutoCleanup(
  dir: string,
  intervalMs: number = 60 * 60 * 1000,
  maxAgeMs: number = 60 * 60 * 1000
): NodeJS.Timeout {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return setInterval(() => _cleanDirectory(dir, maxAgeMs), intervalMs);
}

// ─────────────────────────────────────────────
//  Shared body extractor
// ─────────────────────────────────────────────

function _extractBody(msg: proto.IWebMessageInfo): string {
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

// ─────────────────────────────────────────────
//  Storage helper (LevelDB)
// ─────────────────────────────────────────────

class SubStorage {
  private db: Level;

  constructor() {
    this.db = new Level(path.join(DB_DIR, 'subs'), { valueEncoding: 'json' });
  }

  async save(uid: string, data: Partial<SubBotInstance>): Promise<void> {
    await this.db.put(uid, data);
  }

  async load(): Promise<SubBotInstance[]> {
    const bots: SubBotInstance[] = [];
    try {
      for await (const [key, value] of this.db.iterator()) {
        bots.push({ uid: key, sock: null, connected: false, ...(value as any) });
      }
    } catch {}
    return bots;
  }

  async delete(uid: string): Promise<void> {
    try {
      await this.db.del(uid);
    } catch {}
  }

  async has(uid: string): Promise<boolean> {
    try {
      await this.db.get(uid);
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────
//  Command interfaces (shared by EsewBot & SubBots)
// ─────────────────────────────────────────────

export interface MessageContext {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  sender: string;
  chat: string;
  isGroup: boolean;
  name: string;
  body: string;
  prefix: string;
  command: string;
  args: string[];
  text: string;
  quoted: proto.IWebMessageInfo | null;
  reply: (content: string | AnyMessageContent) => Promise<void>;
  react: (emoji: string) => Promise<void>;
  isOwner: boolean;
  isAdmin: boolean;
  isBotAdmin: boolean;
  groupMetadata?: any;
}

export type CommandHandler = (ctx: MessageContext) => Promise<void>;

export interface Command {
  handler: CommandHandler;
  name: string[];
  description?: string;
  category?: string;
  ownerOnly?: boolean;
  groupOnly?: boolean;
  privateOnly?: boolean;
  adminOnly?: boolean;
  botAdminOnly?: boolean;
}

// ─────────────────────────────────────────────
//  [1] Shared folder-based command loader
// ─────────────────────────────────────────────

/**
 * Reads all .js / .mjs / .cjs files in `dir` using fs.readdir,
 * dynamically imports each one (supports ES modules), and registers
 * them in the provided commands Map.
 *
 * Each file should export a default object with:
 *   command : string | string[]     — trigger name(s)
 *   handler(ctx): Promise<void>     — execution function
 *   ...optional meta fields (description, ownerOnly, adminOnly, etc.)
 */
async function _loadCommandsFromFolder(
  dir: string,
  commands: Map<string, Command>,
  onError?: (file: string, err: unknown) => void
): Promise<void> {
  if (!fs.existsSync(dir)) return;

  const entries = await fs.promises.readdir(dir);
  const validFiles = entries.filter(f =>
    f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')
  );

  for (const file of validFiles) {
    try {
      const fullPath = path.resolve(dir, file);
      // Dynamic import() works for both CJS and ESM files
      const mod = await import(fullPath);
      const exported = mod.default ?? mod;

      if (exported && exported.command) {
        const names: string[] = Array.isArray(exported.command)
          ? exported.command
          : [exported.command];

        const cmd: Command = {
          name: names,
          handler: exported.handler ?? exported,
          description: exported.description,
          category: exported.category,
          ownerOnly: exported.ownerOnly,
          groupOnly: exported.groupOnly,
          privateOnly: exported.privateOnly,
          adminOnly: exported.adminOnly,
          botAdminOnly: exported.botAdminOnly,
        };

        for (const name of names) {
          commands.set(name.toLowerCase(), cmd);
        }
      }
    } catch (err: unknown) {
      if (onError) onError(file, err);
    }
  }
}

// ─────────────────────────────────────────────
//  SubBots Class
// ─────────────────────────────────────────────

export class SubBots extends EventEmitter {
  private commandSystem: CommandSystem;
  private config: SubBotConfig = {};
  private bots: Map<string, SubBotInstance> = new Map();
  private storage: SubStorage;
  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Internal command registry populated by loadCommandsFromFolder(). */
  private _commands: Map<string, Command> = new Map();

  private static defaultPairingCode: string = 'ESCANOR1';

  constructor(commandSystem?: CommandSystem) {
    super();
    this.commandSystem = commandSystem || {};
    this.storage = new SubStorage();

    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

    // [4] Start hourly cleanup of the ./tmp directory
    this.cleanupInterval = _startAutoCleanup('./tmp');
  }

  static pariCode(code: string): void {
    SubBots.defaultPairingCode = code;
  }

  async setConfig(cfg: SubBotConfig): Promise<void> {
    this.config = { ...this.config, ...cfg };

    // [1] Auto-load commands from commandsPath when config is updated
    if (cfg.commandsPath) {
      await this.loadCommandsFromFolder(cfg.commandsPath);
    }
  }

  /**
   * [1] Folder-based Command Handler for SubBots.
   * Call this (or set commandsPath in setConfig) to load command files
   * automatically instead of wiring a CommandSystem manually.
   */
  async loadCommandsFromFolder(dir: string): Promise<void> {
    await _loadCommandsFromFolder(
      dir,
      this._commands,
      (file, err) => this.emit('error', 'system', new Error(`Failed to load ${file}: ${err}`))
    );

    // Wire the internal command dispatcher into commandSystem once
    if (this._commands.size > 0 && !this.commandSystem.handle) {
      this.commandSystem.handle = (sock, msg, uid) =>
        this._dispatchSubCommand(sock, msg, uid);
    }
  }

  private async _dispatchSubCommand(
    sock: WASocket,
    msg: proto.IWebMessageInfo,
    uid?: string
  ): Promise<void> {
    const body = _extractBody(msg);
    const sender = msg.key.participant || msg.key.remoteJid || '';
    const chat = msg.key.remoteJid || '';
    const isGroup = chat.endsWith('@g.us');
    const owners = this.config.owners || [];
    const isOwner = owners.includes(sender.split('@')[0]) || owners.includes(sender);

    const prefixes = Array.isArray(this.config.prefix)
      ? this.config.prefix
      : [this.config.prefix || '!'];

    let usedPrefix = '';
    let command = '';
    let args: string[] = [];
    let text = '';

    for (const p of prefixes) {
      if (body.startsWith(p)) {
        usedPrefix = p;
        const parts = body.slice(p.length).trim().split(/\s+/);
        command = (parts.shift() || '').toLowerCase();
        args = parts;
        text = parts.join(' ');
        break;
      }
    }

    if (!command) return;

    const cmd = this._commands.get(command);
    if (!cmd) return;

    let groupMetadata: any = null;
    let isAdmin = false;
    let isBotAdmin = false;

    if (isGroup) {
      try {
        groupMetadata = await sock.groupMetadata(chat);
        const admins = groupMetadata.participants
          .filter((p: any) => p.admin)
          .map((p: any) => p.id);
        isAdmin = admins.includes(sender);
        isBotAdmin = admins.includes(
          sock.user?.id?.replace(/:\d+/, '') + '@s.whatsapp.net'
        );
      } catch {}
    }

    const ctx: MessageContext = {
      sock, msg, sender, chat, isGroup,
      name: msg.pushName || sender.split('@')[0],
      body, prefix: usedPrefix, command, args, text,
      quoted: (msg.message as any)?.extendedTextMessage?.contextInfo?.quotedMessage
        ? {
            message: (msg.message as any).extendedTextMessage.contextInfo.quotedMessage,
            key: {
              id: (msg.message as any).extendedTextMessage.contextInfo.stanzaId,
              remoteJid: chat,
              fromMe: false,
              participant: (msg.message as any).extendedTextMessage.contextInfo.participant,
            },
          }
        : null,
      reply: async (content) => {
        if (typeof content === 'string') {
          await sock.sendMessage(chat, { text: content }, { quoted: msg });
        } else {
          await sock.sendMessage(chat, content, { quoted: msg });
        }
      },
      react: async (emoji) => {
        await sock.sendMessage(chat, { react: { text: emoji, key: msg.key } });
      },
      isOwner, isAdmin, isBotAdmin, groupMetadata,
    };

    try {
      if (cmd.ownerOnly && !isOwner) { await ctx.reply('❌ هذا الأمر للمطور فقط!'); return; }
      if (cmd.groupOnly && !isGroup) { await ctx.reply('❌ هذا الأمر يعمل في المجموعات فقط!'); return; }
      if (cmd.privateOnly && isGroup) { await ctx.reply('❌ هذا الأمر يعمل في المحادثات الخاصة فقط!'); return; }
      if (cmd.adminOnly && !isAdmin) { await ctx.reply('❌ هذا الأمر للأدمنز فقط!'); return; }
      if (cmd.botAdminOnly && !isBotAdmin) { await ctx.reply('❌ أنا محتاج صلاحية أدمن عشان أنفذ الأمر ده!'); return; }
      await cmd.handler(ctx);
    } catch (err: any) {
      this.emit('commandError', uid, err, cmd);
      // [2] Reply to the user so the command never hangs silently
      await ctx.reply('❌ حدث خطأ غير متوقع أثناء تنفيذ هذا الأمر. يرجى المحاولة لاحقاً.').catch(() => {});
    }
  }

  async load(): Promise<number> {
    const saved = await this.storage.load();
    let count = 0;
    for (const bot of saved) {
      if (bot.number) {
        await this.connect(bot.uid, bot.number);
        count++;
      }
    }
    return count;
  }

  get(uid: string): SubBotInstance | undefined {
    return this.bots.get(uid);
  }

  getAll(): SubBotInstance[] {
    return Array.from(this.bots.values());
  }

  async add(number: string): Promise<string> {
    const uid = `sub_${number.replace(/[^0-9]/g, '')}_${Date.now()}`;
    await this.storage.save(uid, { uid, number });
    await this.connect(uid, number);
    return uid;
  }

  async remove(uid: string): Promise<void> {
    const bot = this.bots.get(uid);
    if (bot?.sock) {
      try { bot.sock.end(undefined); } catch {}
    }
    this.bots.delete(uid);
    // [3] Remove from DB and delete session folder
    await this.storage.delete(uid);
    const sessionPath = path.join(SESSIONS_DIR, uid);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  async requestPairingCode(uid: string): Promise<string | null> {
    const bot = this.bots.get(uid);
    if (!bot?.sock) return null;
    try {
      const number = bot.number?.replace(/[^0-9]/g, '') || '';
      const code = await bot.sock.requestPairingCode(number);
      bot.pairingCode = code;
      this.emit('pair', uid, code);
      return code;
    } catch (e) {
      return null;
    }
  }

  private async connect(uid: string, number: string): Promise<void> {
    const sessionPath = path.join(SESSIONS_DIR, uid);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: this.config.printQR ?? false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true
    });

    const instance: SubBotInstance = { uid, sock, connected: false, number };
    this.bots.set(uid, instance);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        try {
          const cleanNumber = number.replace(/[^0-9]/g, '');
          const code = await sock.requestPairingCode(cleanNumber);
          instance.pairingCode = code;
          this.emit('pair', uid, code);
        } catch {}
      }

      if (connection === 'open') {
        instance.connected = true;
        await this.storage.save(uid, { uid, number });
        saveCreds();
        this.emit('ready', uid, sock);
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        instance.connected = false;

        // [3] Logout: delete session folder + DB entry immediately,
        //     do NOT reconnect — prevents the infinite error loop.
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden) {
          this.emit('badSession', uid);
          await this.remove(uid);
          return;
        }

        this.emit('close', uid);
        // Reconnect only for non-logout disconnections
        setTimeout(() => this.connect(uid, number), 5000);
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }: { messages: proto.IWebMessageInfo[]; type: MessageUpsertType }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        this.emit('message', uid, msg, sock);

        if (this.commandSystem?.handle) {
          try {
            await this.commandSystem.handle(sock, msg, uid);
          } catch (e: any) {
            this.emit('error', uid, e);
          }
        }
      }
    });

    sock.ev.on('group-participants.update', (update) => {
      this.emit('groupParticipantsUpdate', uid, update, sock);
    });
  }

  /** Stop the auto-cleanup interval (call on graceful shutdown). */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// ─────────────────────────────────────────────
//  EsewBot – Main single-bot class
// ─────────────────────────────────────────────

export interface BotConfig {
  number: string;
  prefix?: string | string[];
  owners?: string[];
  commandsPath?: string;
  sessionPath?: string;
  printQR?: boolean;
  info?: {
    name?: string;
    version?: string;
    description?: string;
  };
}

export class EsewBot extends EventEmitter {
  private config: BotConfig;
  private commands: Map<string, Command> = new Map();
  private sock: WASocket | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: BotConfig) {
    super();
    this.config = config;

    // [4] Start hourly cleanup of the ./tmp directory
    this.cleanupInterval = _startAutoCleanup('./tmp');
  }

  registerCommand(names: string[], handler: CommandHandler, meta: Partial<Command> = {}): void {
    const cmd: Command = { handler, name: names, ...meta };
    for (const name of names) {
      this.commands.set(name.toLowerCase(), cmd);
    }
  }

  /**
   * [1] Folder-based Command Handler
   * Async — uses fs.readdir + dynamic import() so ES module files
   * are fully supported. Call this directly or set commandsPath in
   * BotConfig to trigger it automatically at startup.
   *
   * Each file should export a default object with:
   *   command : string | string[]     — trigger name(s)
   *   handler(ctx): Promise<void>     — execution function
   *   ...optional meta fields (ownerOnly, adminOnly, etc.)
   */
  async loadCommands(dir: string): Promise<void> {
    await _loadCommandsFromFolder(
      dir,
      this.commands,
      (file, err) => this.emit('loadError', new Error(`Failed to load ${file}: ${err}`))
    );
  }

  getCommands(): Map<string, Command> {
    return this.commands;
  }

  async start(): Promise<void> {
    const sessionPath = this.config.sessionPath || './session';
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    // [1] Auto-load commands from commandsPath before connecting
    if (this.config.commandsPath) {
      await this.loadCommands(this.config.commandsPath);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: this.config.printQR ?? false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true
    });

    this.sock = sock;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !state.creds.registered) {
        const cleanNumber = this.config.number.replace(/[^0-9]/g, '');
        try {
          const code = await sock.requestPairingCode(cleanNumber);
          this.emit('pair', code);
          console.log(`\n🔐 كود الربط: ${code}\n`);
        } catch {}
      }

      if (connection === 'open') {
        this.emit('ready', sock);
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

        // [3] Logout: delete the session folder immediately, then stop.
        //     Do NOT reconnect — prevents the infinite error loop.
        if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden) {
          const sp = this.config.sessionPath || './session';
          try {
            if (fs.existsSync(sp)) fs.rmSync(sp, { recursive: true, force: true });
          } catch {}
          this.emit('logout');
          return;
        }

        // Reconnect only for non-logout disconnections
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

  private async _handleMessage(sock: WASocket, msg: proto.IWebMessageInfo): Promise<void> {
    const body = _extractBody(msg);
    const sender = msg.key.participant || msg.key.remoteJid || '';
    const chat = msg.key.remoteJid || '';
    const isGroup = chat.endsWith('@g.us');
    const owners = this.config.owners || [];
    const isOwner = owners.includes(sender.split('@')[0]) || owners.includes(sender);

    const prefixes = Array.isArray(this.config.prefix)
      ? this.config.prefix
      : [this.config.prefix || '!'];

    let usedPrefix = '';
    let command = '';
    let args: string[] = [];
    let text = '';

    for (const p of prefixes) {
      if (body.startsWith(p)) {
        usedPrefix = p;
        const parts = body.slice(p.length).trim().split(/\s+/);
        command = (parts.shift() || '').toLowerCase();
        args = parts;
        text = parts.join(' ');
        break;
      }
    }

    let groupMetadata: any = null;
    let isAdmin = false;
    let isBotAdmin = false;

    if (isGroup) {
      try {
        groupMetadata = await sock.groupMetadata(chat);
        const admins = groupMetadata.participants.filter((p: any) => p.admin).map((p: any) => p.id);
        isAdmin = admins.includes(sender);
        isBotAdmin = admins.includes(sock.user?.id?.replace(/:\d+/, '') + '@s.whatsapp.net');
      } catch {}
    }

    const ctx: MessageContext = {
      sock,
      msg,
      sender,
      chat,
      isGroup,
      name: msg.pushName || sender.split('@')[0],
      body,
      prefix: usedPrefix,
      command,
      args,
      text,
      quoted: (msg.message as any)?.extendedTextMessage?.contextInfo?.quotedMessage
        ? {
            message: (msg.message as any).extendedTextMessage.contextInfo.quotedMessage,
            key: {
              id: (msg.message as any).extendedTextMessage.contextInfo.stanzaId,
              remoteJid: chat,
              fromMe: false,
              participant: (msg.message as any).extendedTextMessage.contextInfo.participant,
            },
          }
        : null,
      reply: async (content) => {
        if (typeof content === 'string') {
          await sock.sendMessage(chat, { text: content }, { quoted: msg });
        } else {
          await sock.sendMessage(chat, content, { quoted: msg });
        }
      },
      react: async (emoji) => {
        await sock.sendMessage(chat, { react: { text: emoji, key: msg.key } });
      },
      isOwner,
      isAdmin,
      isBotAdmin,
      groupMetadata
    };

    this.emit('message', ctx);

    if (!command) return;

    const cmd = this.commands.get(command);
    if (!cmd) {
      this.emit('commandNotFound', ctx);
      return;
    }

    try {
      if (cmd.ownerOnly && !isOwner) {
        await ctx.reply('❌ هذا الأمر للمطور فقط!');
        return;
      }
      if (cmd.groupOnly && !isGroup) {
        await ctx.reply('❌ هذا الأمر يعمل في المجموعات فقط!');
        return;
      }
      if (cmd.privateOnly && isGroup) {
        await ctx.reply('❌ هذا الأمر يعمل في المحادثات الخاصة فقط!');
        return;
      }
      if (cmd.adminOnly && !isAdmin) {
        await ctx.reply('❌ هذا الأمر للأدمنز فقط!');
        return;
      }
      if (cmd.botAdminOnly && !isBotAdmin) {
        await ctx.reply('❌ أنا محتاج صلاحية أدمن عشان أنفذ الأمر ده!');
        return;
      }
      await cmd.handler(ctx);
    } catch (err: any) {
      this.emit('commandError', ctx, err, cmd);
      // [2] Notify the user — the command must never hang silently
      await ctx.reply('❌ حدث خطأ غير متوقع أثناء تنفيذ هذا الأمر. يرجى المحاولة لاحقاً.').catch(() => {});
    }
  }

  /** Stop the auto-cleanup interval (call on graceful shutdown). */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

export default { EsewBot, SubBots };
