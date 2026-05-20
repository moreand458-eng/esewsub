// esewsub — Type Definitions
// بحقوق 𝐄𝐒𝐂𝐀𝐍𝛩𝐑 | github:moreand458-eng/esewsub

import { WASocket, proto, AnyMessageContent } from '@whiskeysockets/baileys';
import { EventEmitter } from 'events';

// ─────────────────────────────────────────────
//  Shared Types
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
//  SubBots Events
// ─────────────────────────────────────────────

export interface SubBotsEvents {
  ready: [uid: string, sock: WASocket];
  pair: [uid: string, code: string];
  message: [uid: string, msg: proto.IWebMessageInfo, sock: WASocket];
  error: [uid: string, error: Error];
  close: [uid: string];
  badSession: [uid: string];
  groupParticipantsUpdate: [uid: string, update: any, sock: WASocket];
}

// ─────────────────────────────────────────────
//  SubBots Class
// ─────────────────────────────────────────────

export declare class SubBots extends EventEmitter {
  constructor(commandSystem?: CommandSystem);

  /** Set the default pairing code for all sub bots */
  static pariCode(code: string): void;

  /** Configure the sub bots system */
  setConfig(cfg: SubBotConfig): Promise<void>;

  /** Load previously saved sub bots from disk */
  load(): Promise<number>;

  /** Get a specific sub bot by uid */
  get(uid: string): SubBotInstance | undefined;

  /** Get all sub bots */
  getAll(): SubBotInstance[];

  /** Add a new sub bot by phone number */
  add(number: string): Promise<string>;

  /** Remove a sub bot and its session */
  remove(uid: string): Promise<void>;

  /** Request pairing code for a sub bot */
  requestPairingCode(uid: string): Promise<string | null>;

  on<K extends keyof SubBotsEvents>(event: K, listener: (...args: SubBotsEvents[K]) => void): this;
  once<K extends keyof SubBotsEvents>(event: K, listener: (...args: SubBotsEvents[K]) => void): this;
  emit<K extends keyof SubBotsEvents>(event: K, ...args: SubBotsEvents[K]): boolean;
  off<K extends keyof SubBotsEvents>(event: K, listener: (...args: SubBotsEvents[K]) => void): this;
}

// ─────────────────────────────────────────────
//  EsewBot Types
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
  reply(content: string | AnyMessageContent): Promise<void>;
  react(emoji: string): Promise<void>;
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
//  EsewBot Events
// ─────────────────────────────────────────────

export interface EsewBotEvents {
  ready: [sock: WASocket];
  pair: [code: string];
  logout: [];
  message: [ctx: MessageContext];
  commandNotFound: [ctx: MessageContext];
  commandError: [ctx: MessageContext, error: Error, command: Command];
}

// ─────────────────────────────────────────────
//  EsewBot Class
// ─────────────────────────────────────────────

export declare class EsewBot extends EventEmitter {
  constructor(config: BotConfig);

  /** Register one or more command names with a handler */
  registerCommand(names: string[], handler: CommandHandler, meta?: Partial<Command>): void;

  /** Get all registered commands */
  getCommands(): Map<string, Command>;

  /** Start the bot (connect to WhatsApp) */
  start(): Promise<void>;

  on<K extends keyof EsewBotEvents>(event: K, listener: (...args: EsewBotEvents[K]) => void): this;
  once<K extends keyof EsewBotEvents>(event: K, listener: (...args: EsewBotEvents[K]) => void): this;
  emit<K extends keyof EsewBotEvents>(event: K, ...args: EsewBotEvents[K]): boolean;
  off<K extends keyof EsewBotEvents>(event: K, listener: (...args: EsewBotEvents[K]) => void): this;
}

// ─────────────────────────────────────────────
//  Default Export
// ─────────────────────────────────────────────

declare const _default: {
  EsewBot: typeof EsewBot;
  SubBots: typeof SubBots;
};

export default _default;
