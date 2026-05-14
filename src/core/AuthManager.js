/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import { useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join }  from 'path';
import { EscanorLogger } from '../utils/Logger.js';

const log = new EscanorLogger('AuthManager');

// ─────────────────────────────────────────────
//  AuthManager
// ─────────────────────────────────────────────

export class AuthManager {
  /**
   * @param {string} sessionPath - Directory for auth files
   */
  constructor(sessionPath = './sessions') {
    this.sessionPath = sessionPath;
    this._state      = null;
    this._saveCreds  = null;
  }

  /** Ensure session directory exists, then load or create credentials. */
  async load() {
    if (!existsSync(this.sessionPath)) {
      mkdirSync(this.sessionPath, { recursive: true });
      log.info(`Created session directory: ${this.sessionPath}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
    this._state     = state;
    this._saveCreds = saveCreds;

    log.debug(`Auth state loaded from ${this.sessionPath}`);
    return { state, saveCreds };
  }

  /** Get the loaded auth state object (must call load() first). */
  get state() {
    if (!this._state) throw new Error('[ESCANOR-WS] AuthManager.load() must be called before accessing state');
    return this._state;
  }

  /** The Baileys saveCreds callback. */
  get saveCreds() {
    if (!this._saveCreds) throw new Error('[ESCANOR-WS] AuthManager.load() must be called before accessing saveCreds');
    return this._saveCreds;
  }

  /**
   * Wipe all session data. Use with care.
   * Will prompt a fresh QR / pairing code on next start.
   */
  clearSession() {
    if (existsSync(this.sessionPath)) {
      rmSync(this.sessionPath, { recursive: true, force: true });
      log.warn(`Session cleared: ${this.sessionPath}`);
    }
  }

  /**
   * Check whether a saved session exists (i.e. creds.json present).
   */
  hasSession() {
    return existsSync(join(this.sessionPath, 'creds.json'));
  }
}
