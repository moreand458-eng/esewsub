/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import { parseMessage } from '../utils/Parser.js';
import { EscanorLogger } from '../utils/Logger.js';

const log = new EscanorLogger('EventHandler');

// ─────────────────────────────────────────────
//  EventHandler
//
//  Bridges raw Baileys socket events to the
//  ESCANOR-WS user-facing API (.onMessage, etc.)
// ─────────────────────────────────────────────

export class EventHandler {
  /**
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {import('../core/Client.js').Client}         client
   */
  constructor(sock, client) {
    this.sock   = sock;
    this.client = client;
    this.config = client.config;
  }

  /** Attach all listeners to the Baileys socket. */
  attach() {
    this._handleConnectionUpdate();
    this._handleCredsUpdate();
    this._handleMessages();
    this._handleGroupParticipants();
    log.debug('Event listeners attached');
  }

  // ─── connection.update ────────────────────

  _handleConnectionUpdate() {
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr, pairingCode } = update;

      if (qr && this.config.printQR) {
        log.info('QR code ready — scan with WhatsApp:');
        const qrTerminal = await import('qrcode-terminal').then(m => m.default ?? m);
        qrTerminal.generate(qr, { small: true });
      }

      if (pairingCode) {
        log.info(`Pairing code: ${pairingCode}`);
        this.client.emit('pairing_code', pairingCode);
      }

      if (connection === 'open') {
        log.info('[ESCANOR-WS] | Connection: Open ✔');
        this.client.emit('ready', this.sock);
        if (typeof this.config.onConnected === 'function') {
          await this.config.onConnected(this.sock).catch((e) =>
            log.warn(`onConnected callback error: ${e.message}`)
          );
        }
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        log.warn(`Connection closed (reason: ${reason})`);
        this.client.emit('disconnected', reason);
        if (typeof this.config.onDisconnected === 'function') {
          await this.config.onDisconnected(reason).catch(() => {});
        }
        // Reconnect logic is managed by Client (with exponential backoff)
        this.client._onConnectionClose(reason);
      }

      if (connection === 'connecting') {
        log.info('Connecting to WhatsApp…');
      }
    });
  }

  // ─── creds.update ─────────────────────────

  _handleCredsUpdate() {
    this.sock.ev.on('creds.update', this.client._auth.saveCreds);
  }

  // ─── messages.upsert ──────────────────────

  _handleMessages() {
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const raw of messages) {
        try {
          const msg = await parseMessage(raw, this.sock, this.config);
          if (!msg) continue;

          // Auto-read
          if (this.config.autoRead) {
            await this.sock.readMessages([raw.key]).catch(() => {});
          }

          // Emit to user handlers
          this.client.emit('message', msg);

          // Run through command system
          const handled = await this.client.commandSystem.process(msg, this.client);

          if (!handled) {
            // Fire user-defined onMessage callback if no command matched
            for (const handler of this.client._messageHandlers) {
              await _safeCall(() => handler(msg), 'messageHandler');
            }
          }
        } catch (err) {
          log.error(`Message processing error: ${err.message}`);
          if (typeof this.config.onError === 'function') {
            this.config.onError(err);
          }
        }
      }
    });
  }

  // ─── group-participants.update ────────────

  _handleGroupParticipants() {
    this.sock.ev.on('group-participants.update', async (event) => {
      /*
       * event: { id, participants, action, author? }
       * action: 'add' | 'remove' | 'promote' | 'demote'
       */
      const groupEvent = {
        chat:         event.id,
        participants: event.participants,
        action:       event.action,
        author:       event.author ?? null,
        timestamp:    new Date(),
      };

      this.client.emit('group_update', groupEvent);

      for (const handler of this.client._groupEventHandlers) {
        await _safeCall(() => handler(groupEvent), 'groupEventHandler');
      }
    });
  }
}

// ─────────────────────────────────────────────
async function _safeCall(fn, label) {
  try {
    await fn();
  } catch (err) {
    log.warn(`Error in ${label}: ${err.message}`);
  }
}
