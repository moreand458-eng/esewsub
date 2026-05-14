/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import {
  downloadMediaMessage,
  getContentType,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';

// ─────────────────────────────────────────────
//  Internal helpers
// ─────────────────────────────────────────────

/**
 * Walk the Baileys message object and return the inner content node,
 * unwrapping ephemeral / view-once wrappers transparently.
 */
function unwrapMessage(raw) {
  if (!raw?.message) return null;
  let msg = raw.message;

  if (msg.ephemeralMessage)   msg = msg.ephemeralMessage.message;
  if (msg.viewOnceMessage)    msg = msg.viewOnceMessage.message;
  if (msg.viewOnceMessageV2)  msg = msg.viewOnceMessageV2.message;
  if (msg.documentWithCaptionMessage)
    msg = msg.documentWithCaptionMessage.message;

  return msg;
}

/** Extract plain text from whatever content type the message carries */
function extractText(msg) {
  if (!msg) return '';

  return (
    msg.conversation                                        ??
    msg.extendedTextMessage?.text                          ??
    msg.imageMessage?.caption                              ??
    msg.videoMessage?.caption                              ??
    msg.documentMessage?.caption                           ??
    msg.buttonsResponseMessage?.selectedButtonId           ??
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ??
    msg.templateButtonReplyMessage?.selectedId             ??
    msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ??
    ''
  );
}

/** Return the Baileys content-type key of the unwrapped message */
function getType(msg) {
  if (!msg) return 'unknown';
  return getContentType(msg) ?? 'unknown';
}

/** Pull the quoted context from extendedTextMessage */
function extractQuoted(msg) {
  const ctx = msg?.extendedTextMessage?.contextInfo;
  if (!ctx?.quotedMessage) return null;

  return {
    id:      ctx.stanzaId    ?? null,
    sender:  ctx.participant ?? null,
    message: ctx.quotedMessage,
    text:
      ctx.quotedMessage.conversation ??
      ctx.quotedMessage.extendedTextMessage?.text ??
      ctx.quotedMessage.imageMessage?.caption ??
      ctx.quotedMessage.videoMessage?.caption ??
      '',
    type: getType(ctx.quotedMessage),
  };
}

/** Detect the media type from a message object */
function detectMediaType(msg) {
  const type = getType(msg);
  const MEDIA_TYPES = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'voiceMessage',
  ];
  if (MEDIA_TYPES.includes(type)) return type.replace('Message', '');
  return null;
}

// ─────────────────────────────────────────────
//  Input sanitisation
// ─────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /javascript:/gi,
  /data:text\/html/gi,
  /eval\s*\(/gi,
  /on\w+\s*=/gi,   // onclick=, onerror= …
];

/**
 * Sanitise a command string before processing.
 * Returns the cleaned string or null if it looks malicious.
 */
export function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  let out = text.trim();
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(out)) return '';   // reject completely
  }
  // Strip null-bytes and control characters (except \n \t)
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return out;
}

// ─────────────────────────────────────────────
//  Main parser
// ─────────────────────────────────────────────

/**
 * Transform a raw Baileys WAMessage into a clean, ergonomic `msg` object.
 *
 * @param {import('@whiskeysockets/baileys').WAMessage} raw
 * @param {import('@whiskeysockets/baileys').WASocket}  sock
 * @param {object} config   - ESCANOR-WS config object
 * @returns {object|null}   - parsed message or null if it should be ignored
 */
export async function parseMessage(raw, sock, config) {
  if (!raw?.key) return null;

  const inner = unwrapMessage(raw);
  if (!inner) return null;

  // ── Basic identity ─────────────────────────
  const fromMe  = raw.key.fromMe ?? false;
  const isGroup = raw.key.remoteJid?.endsWith('@g.us') ?? false;
  const chat    = raw.key.remoteJid ?? '';
  const sender  = isGroup
    ? (raw.key.participant ?? raw.participant ?? chat)
    : chat;

  // ── Ignore bot-self messages unless config says otherwise ──
  if (fromMe && !config.fromMe) return null;

  // ── Text & sanitisation ────────────────────
  const rawText = extractText(inner);
  const text    = sanitizeInput(rawText);

  // ── Prefix / command detection ─────────────
  let prefix  = null;
  let command = null;
  let args    = [];

  for (const p of config.prefix) {
    if (text.startsWith(p)) {
      prefix  = p;
      const parts = text.slice(p.length).trim().split(/\s+/);
      command = parts[0]?.toLowerCase() ?? '';
      args    = parts.slice(1);
      break;
    }
  }

  // ── Permission flags ───────────────────────
  const senderBare = sender.split(':')[0].split('@')[0];
  const isOwner    = config.owners.some((o) => {
    const bare = (o.jid ?? '').split(':')[0].split('@')[0];
    return bare && bare === senderBare;
  });

  // Admin detection (populated later by Client when group metadata is fetched)
  let isAdmin    = false;
  let isBotAdmin = false;

  if (isGroup && sock) {
    try {
      const meta   = await sock.groupMetadata(chat).catch(() => null);
      const parts  = meta?.participants ?? [];
      const myJid  = sock.user?.id ?? '';

      const myBare   = myJid.split(':')[0];
      const sndrBare = sender.split(':')[0];

      isAdmin    = parts.some((p) =>
        p.id.split(':')[0] === sndrBare &&
        (p.admin === 'admin' || p.admin === 'superadmin')
      );
      isBotAdmin = parts.some((p) =>
        p.id.split(':')[0] === myBare &&
        (p.admin === 'admin' || p.admin === 'superadmin')
      );
    } catch { /* non-fatal */ }
  }

  // ── Quoted message ─────────────────────────
  const quoted = extractQuoted(inner);

  // ── Media ──────────────────────────────────
  const mediaType = detectMediaType(inner);

  // ── Timestamp ──────────────────────────────
  const timestamp = raw.messageTimestamp
    ? new Date(Number(raw.messageTimestamp) * 1000)
    : new Date();

  // ── Reply helpers ──────────────────────────
  const reply = async (content, options = {}) => {
    if (typeof content === 'string') {
      return sock.sendMessage(chat, { text: content, ...options }, { quoted: raw });
    }
    return sock.sendMessage(chat, { ...content, ...options }, { quoted: raw });
  };

  const react = (emoji) =>
    sock.sendMessage(chat, {
      react: { text: emoji, key: raw.key },
    });

  const deleteMsg = () =>
    sock.sendMessage(chat, { delete: raw.key });

  const forward = (targetJid, options = {}) =>
    sock.sendMessage(targetJid, { forward: raw, ...options });

  const download = async () => {
    if (!mediaType) return null;
    try {
      return await downloadMediaMessage(raw, 'buffer', {}, {
        logger: { level: 'silent', child: () => ({ level: 'silent', info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {} }) },
        reuploadRequest: sock.updateMediaMessage,
      });
    } catch {
      return null;
    }
  };

  const typing = async (duration = 3000) => {
    await sock.sendPresenceUpdate('composing', chat);
    return new Promise((res) => setTimeout(async () => {
      await sock.sendPresenceUpdate('paused', chat).catch(() => {});
      res();
    }, duration));
  };

  const recording = async (duration = 3000) => {
    await sock.sendPresenceUpdate('recording', chat);
    return new Promise((res) => setTimeout(async () => {
      await sock.sendPresenceUpdate('paused', chat).catch(() => {});
      res();
    }, duration));
  };

  // ── Final clean object ─────────────────────
  return {
    // Identity
    id:        raw.key.id,
    from:      sender,
    sender,
    chat,
    pushName:  raw.pushName ?? null,
    name:      raw.pushName ?? null,

    // Content
    text,
    body:      text,
    type:      getType(inner),
    mediaType,
    hasMedia:  mediaType !== null,

    // Flags
    isGroup,
    fromMe,
    isOwner,
    isAdmin,
    isBotAdmin,

    // Command parsing
    prefix,
    command,
    args,
    isCommand: command !== null,

    // Timestamps
    timestamp,

    // Quoted
    quoted,
    hasQuoted: quoted !== null,

    // Raw data (for advanced use)
    key:     raw.key,
    message: inner,
    raw,

    // Actions (bound to this message's context)
    reply,
    react,
    delete:    deleteMsg,
    download,
    forward,
    typing,
    recording,
  };
}
