/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

// ─────────────────────────────────────────────
//  Config Types & Defaults
//  No external schema library — pure JS for zero-bloat.
// ─────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  /** Phone number (with country code, no +) for pairing code flow. '' = QR mode */
  phoneNumber: '',
  /** Path where session files are stored.  NEVER logged, never sent externally. */
  sessionPath: './sessions',
  /** Prefix string or array of strings that trigger commands */
  prefix: ['.', '!', '/'],
  /** Array of owner objects { jid, name? } */
  owners: [],
  /** Path to folder containing command files */
  commandsPath: './commands',
  /** Bot display name for logging */
  botName: 'ESCANOR-BOT',
  /** Auto-reconnect on disconnect */
  autoReconnect: true,
  /** Initial delay in ms before reconnect (doubles each attempt) */
  reconnectDelay: 3000,
  /** Maximum reconnect attempts before giving up (0 = unlimited) */
  maxReconnectAttempts: 10,
  /** Print QR to terminal (true) or use pairing code (false when phoneNumber is set) */
  printQR: true,
  /** Whether to auto-read messages (send read receipts) */
  autoRead: false,
  /** Whether to process messages sent by the bot itself */
  fromMe: false,
  /** Show verbose pino logs */
  showLogs: false,
  /** Lifecycle callbacks */
  onConnected: null,
  onDisconnected: null,
  onError: null,
};

/**
 * Merge user config with defaults and do light validation.
 * @param {Partial<typeof DEFAULT_CONFIG>} userConfig
 * @returns {typeof DEFAULT_CONFIG}
 */
export function buildConfig(userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };

  // Normalise prefix to always be an array
  if (typeof cfg.prefix === 'string') {
    cfg.prefix = [cfg.prefix];
  }
  if (!Array.isArray(cfg.prefix) || cfg.prefix.length === 0) {
    cfg.prefix = ['.'];
  }

  // Normalise phoneNumber: strip spaces / dashes / +
  if (cfg.phoneNumber) {
    cfg.phoneNumber = String(cfg.phoneNumber).replace(/[\s\-+]/g, '');
  }

  // owners must be array of { jid, name? }
  if (!Array.isArray(cfg.owners)) cfg.owners = [];
  cfg.owners = cfg.owners.map((o) => {
    if (typeof o === 'string') return { jid: o, name: undefined };
    return o;
  });

  return cfg;
}

/**
 * Check if a JID belongs to a configured owner.
 * @param {string} jid
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {boolean}
 */
export function isOwner(jid, config) {
  const bare = jid.split(':')[0].split('@')[0];
  return config.owners.some((o) => {
    const obare = (o.jid || '').split(':')[0].split('@')[0];
    return obare && obare === bare;
  });
}
