/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import { EventEmitter }       from 'events';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom }               from '@hapi/boom';
import pino                   from 'pino';

import { AuthManager }        from './AuthManager.js';
import { CommandSystem }      from '../handlers/CommandSystem.js';
import { EventHandler }       from '../handlers/EventHandler.js';
import { MediaSender }        from '../utils/Media.js';
import { EscanorLogger, LogLevel } from '../utils/Logger.js';
import { buildConfig }        from '../utils/Config.js';

// ─────────────────────────────────────────────
//  Client — the heart of ESCANOR-WS
// ─────────────────────────────────────────────

export class Client extends EventEmitter {
  /**
   * @param {import('../utils/Config.js').DEFAULT_CONFIG} userConfig
   */
  constructor(userConfig = {}) {
    super();

    // Merge user config with defaults
    this.config = buildConfig(userConfig);

    this._log    = new EscanorLogger('Client');
    this._auth   = new AuthManager(this.config.sessionPath);

    /** The live Baileys socket (null until connected) */
    this.sock    = null;

    /** Typed access to media helpers */
    this.media   = null;

    /** Command system */
    this.commandSystem = new CommandSystem();

    // Internal handler arrays
    this._messageHandlers    = [];
    this._groupEventHandlers = [];

    // Reconnection state
    this._reconnectAttempts = 0;
    this._reconnecting      = false;
    this._stopped           = false;
  }

  // ─────────────────────────────────────────────
  //  Public API: event handlers
  // ─────────────────────────────────────────────

  /**
   * Register a handler for every incoming message.
   * Called only when NO command matched.
   * @param {(msg: object) => Promise<void>} handler
   */
  onMessage(handler) {
    if (typeof handler !== 'function') throw new TypeError('onMessage: handler must be a function');
    this._messageHandlers.push(handler);
  }

  /**
   * Register a handler for group participant changes (add/remove/promote/demote).
   * @param {(event: object) => Promise<void>} handler
   */
  onGroupEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('onGroupEvent: handler must be a function');
    this._groupEventHandlers.push(handler);
  }

  // ─────────────────────────────────────────────
  //  Command delegation helpers
  // ─────────────────────────────────────────────

  /** Register a command definition object. */
  registerCommand(def) {
    this.commandSystem.register(def);
  }

  /** Unregister a command by name. */
  unregisterCommand(name) {
    return this.commandSystem.unregister(name);
  }

  /** Get a command definition by name. */
  getCommand(name) {
    return this.commandSystem.find(name);
  }

  /** Get all registered commands. */
  getAllCommands() {
    return this.commandSystem.getAll();
  }

  /** Add middleware (runs before every matched command). */
  useMiddleware(fn) {
    this.commandSystem.use(fn);
  }

  /** Add a before-command hook. */
  onBeforeCommand(fn) {
    this.commandSystem.before(fn);
  }

  /** Add an after-command hook. */
  onAfterCommand(fn) {
    this.commandSystem.after(fn);
  }

  // ─────────────────────────────────────────────
  //  Lifecycle
  // ─────────────────────────────────────────────

  /**
   * Start the bot: load auth, connect to WhatsApp, load commands.
   */
  async start() {
    this._stopped = false;
    this._log.info('Starting ESCANOR-WS…');

    // Load auth state
    await this._auth.load();

    // Dynamically load commands folder if configured
    if (this.config.commandsPath) {
      await this.commandSystem.loadDirectory(this.config.commandsPath);
    }

    await this._connect();
  }

  /** Gracefully stop the bot. */
  async stop() {
    this._stopped = true;
    this._log.info('Stopping ESCANOR-WS…');
    this.commandSystem.stopWatching();
    if (this.sock) {
      await this.sock.logout().catch(() => {});
      this.sock = null;
    }
    this.emit('stopped');
  }

  /**
   * Restart the bot without re-loading auth from disk.
   */
  async restart() {
    this._log.info('Restarting…');
    if (this.sock) {
      await this.sock.end(new Error('Manual restart')).catch(() => {});
      this.sock = null;
    }
    this._reconnectAttempts = 0;
    await this._connect();
  }

  /** Is the socket currently open? */
  isConnected() {
    return this.sock?.ws?.readyState === 1; // WebSocket.OPEN === 1
  }

  // ─────────────────────────────────────────────
  //  Internal: create Baileys socket
  // ─────────────────────────────────────────────

  async _connect() {
    const { version } = await fetchLatestBaileysVersion();
    this._log.debug(`Baileys version: ${version.join('.')}`);

    // Use a silent pino logger unless showLogs is true
    const pinoLogger = pino({
      level: this.config.showLogs ? 'info' : 'silent',
    });

    const { state } = this._auth;

    this.sock = makeWASocket({
      version,
      logger:       pinoLogger,
      auth: {
        creds: state.creds,
        keys:  makeCacheableSignalKeyStore(state.keys, pinoLogger),
      },
      browser:         ['ESCANOR-WS', 'Chrome', '124.0.0'],
      printQRInTerminal: false, // We handle QR ourselves in EventHandler
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
    });

    // Attach media helper
    this.media = new MediaSender(this.sock);

    // Attach event handlers
    const events = new EventHandler(this.sock, this);
    events.attach();

    // Pairing code flow (if phoneNumber provided and no session)
    if (this.config.phoneNumber && !this._auth.hasSession()) {
      await this._requestPairingCode();
    }

    this._log.info(`Command system ready — ${this.commandSystem.stats().total} command(s) loaded`);
  }

  /** Request a pairing code for the configured phone number. */
  async _requestPairingCode() {
    // Small delay for socket to stabilise
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const code = await this.sock.requestPairingCode(this.config.phoneNumber);
      this._log.info(`Pairing code for ${this.config.phoneNumber}: ${code}`);
      this.emit('pairing_code', code);
    } catch (err) {
      this._log.warn(`Could not request pairing code: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────
  //  Reconnection logic (exponential backoff)
  // ─────────────────────────────────────────────

  /**
   * Called by EventHandler when connection.update fires with connection='close'.
   * @param {number|undefined} statusCode - Baileys DisconnectReason code
   */
  async _onConnectionClose(statusCode) {
    if (this._stopped) return;
    if (!this.config.autoReconnect) return;

    // 401 = logged out — clear session and do NOT reconnect automatically
    if (statusCode === DisconnectReason.loggedOut) {
      this._log.warn('Logged out from WhatsApp. Clearing session. Please restart.');
      this._auth.clearSession();
      this.emit('logged_out');
      return;
    }

    const max = this.config.maxReconnectAttempts;
    if (max > 0 && this._reconnectAttempts >= max) {
      this._log.error(`Max reconnect attempts (${max}) reached. Giving up.`);
      this.emit('max_reconnect');
      return;
    }

    this._reconnectAttempts++;
    // Exponential backoff: delay doubles each attempt, capped at 60 s
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this._reconnectAttempts - 1),
      60_000
    );

    this._log.info(
      `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts}${max ? `/${max}` : ''})…`
    );

    await new Promise((r) => setTimeout(r, delay));
    if (!this._stopped) {
      await this._connect().catch((err) =>
        this._log.error(`Reconnect failed: ${err.message}`)
      );
    }
  }
}
