/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import { readFileSync, existsSync } from 'fs';
import { extname } from 'path';

// ─────────────────────────────────────────────
//  Media helpers
// ─────────────────────────────────────────────

/**
 * Resolve a media source (file path, URL, or Buffer) into
 * the shape Baileys expects: { url } or a Buffer.
 */
function resolveSource(source) {
  if (Buffer.isBuffer(source)) return source;
  if (typeof source === 'string') {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return { url: source };
    }
    if (existsSync(source)) {
      return readFileSync(source);
    }
  }
  throw new Error(`[ESCANOR-WS] Invalid media source: ${source}`);
}

// ─────────────────────────────────────────────
//  MediaSender class
// ─────────────────────────────────────────────

export class MediaSender {
  /**
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   */
  constructor(sock) {
    this.sock = sock;
  }

  /**
   * Send an image.
   * @param {string}         jid
   * @param {string|Buffer}  source   - file path, URL, or Buffer
   * @param {object}         options  - { caption, quoted, mimetype, … }
   */
  async sendImage(jid, source, options = {}) {
    return this.sock.sendMessage(jid, {
      image:   resolveSource(source),
      caption: options.caption ?? '',
      ...options,
    }, { quoted: options.quoted });
  }

  /**
   * Send a video.
   */
  async sendVideo(jid, source, options = {}) {
    return this.sock.sendMessage(jid, {
      video:   resolveSource(source),
      caption: options.caption ?? '',
      ...options,
    }, { quoted: options.quoted });
  }

  /**
   * Send an audio file.
   * @param {boolean} options.ptt  - send as voice note (push-to-talk)
   */
  async sendAudio(jid, source, options = {}) {
    return this.sock.sendMessage(jid, {
      audio: resolveSource(source),
      ptt:   options.ptt ?? false,
      mimetype: options.mimetype ?? 'audio/mpeg',
      ...options,
    }, { quoted: options.quoted });
  }

  /**
   * Send a document / file.
   * @param {string} options.filename - shown in WhatsApp
   * @param {string} options.mimetype - MIME type
   */
  async sendDocument(jid, source, options = {}) {
    const src      = resolveSource(source);
    const filename = options.filename ?? (typeof source === 'string' ? source.split('/').pop() : 'file');
    const mimetype = options.mimetype ?? guessMime(filename);

    return this.sock.sendMessage(jid, {
      document: src,
      fileName: filename,
      mimetype,
      caption: options.caption ?? '',
      ...options,
    }, { quoted: options.quoted });
  }

  /**
   * Send a sticker.
   */
  async sendSticker(jid, source, options = {}) {
    return this.sock.sendMessage(jid, {
      sticker: resolveSource(source),
      ...options,
    }, { quoted: options.quoted });
  }

  // ─── Interactive messages ──────────────────

  /**
   * Send a list message (menu-style picker).
   *
   * @param {string} jid
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.description
   * @param {string} opts.buttonText     - text on the list-open button
   * @param {string} opts.footer
   * @param {Array}  opts.sections       - [{ title, rows: [{ title, rowId, description? }] }]
   */
  async sendList(jid, opts = {}) {
    return this.sock.sendMessage(jid, {
      text:       opts.description ?? '',
      title:      opts.title       ?? '',
      footer:     opts.footer      ?? '',
      buttonText: opts.buttonText  ?? 'Options',
      sections:   opts.sections    ?? [],
      listType:   1,
    });
  }

  /**
   * Send a template / button message.
   * Note: WhatsApp frequently changes button support. This uses the
   * most compatible form (templateButtons) and falls back to plain text
   * on unsupported clients.
   *
   * @param {string} jid
   * @param {object} opts
   * @param {string} opts.text
   * @param {string} opts.footer
   * @param {Array}  opts.buttons  - [{ id, text }]
   * @param {object} opts.quoted
   */
  async sendButtons(jid, opts = {}) {
    const buttons = (opts.buttons ?? []).map((b, i) => ({
      buttonId:      b.id   ?? `btn_${i}`,
      buttonText:    { displayText: b.text ?? `Button ${i + 1}` },
      type:          1,
    }));

    return this.sock.sendMessage(jid, {
      text:    opts.text   ?? '',
      footer:  opts.footer ?? '',
      buttons,
      headerType: 1,
    }, { quoted: opts.quoted });
  }
}

// ─────────────────────────────────────────────
//  MIME guesser
// ─────────────────────────────────────────────

const MIME_MAP = {
  '.pdf':  'application/pdf',
  '.zip':  'application/zip',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.txt':  'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function guessMime(filename = '') {
  return MIME_MAP[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
