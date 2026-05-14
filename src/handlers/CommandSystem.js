/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import { readdirSync, statSync, watch as fsWatch } from 'fs';
import { resolve, extname, basename } from 'path';
import { pathToFileURL } from 'url';
import { EscanorLogger } from '../utils/Logger.js';

const log = new EscanorLogger('CommandSystem');

// ─────────────────────────────────────────────
//  CommandSystem
// ─────────────────────────────────────────────

export class CommandSystem {
  constructor() {
    /** @type {Map<string, object>} command name → definition */
    this._registry = new Map();

    /** @type {Map<string, string[]>} file path → list of command names it registered */
    this._fileMap  = new Map();

    /** @type {Function[]} middleware stack */
    this._middleware = [];

    /** @type {Function[]} before-command hooks */
    this._before = [];

    /** @type {Function[]} after-command hooks */
    this._after  = [];

    /** @type {Map<string, Map<string, number>>} userId → (commandName → expiry ts) */
    this._cooldowns = new Map();

    /** file watcher handle */
    this._watcher = null;
  }

  // ─── Registration ───────────────────────────

  /**
   * Register a single command definition object.
   * @param {object} def
   * @param {string|string[]} def.command  - command name(s) / aliases
   * @param {Function}        def.execute  - async (msg, ctx, bot) => void
   */
  register(def, filePath = null) {
    if (!def || typeof def.execute !== 'function') {
      log.warn('Skipping invalid command definition (missing execute function)', def?.command);
      return;
    }

    // Normalise to array of names
    const names = _normaliseNames(def);

    for (const name of names) {
      if (this._registry.has(name)) {
        log.debug(`Overwriting command: ${name}`);
      }
      this._registry.set(name, { ...def, _primaryName: names[0] });
    }

    if (filePath) {
      const existing = this._fileMap.get(filePath) ?? [];
      this._fileMap.set(filePath, [...new Set([...existing, ...names])]);
    }

    log.debug(`Registered command(s): ${names.join(', ')}`);
  }

  /**
   * Unregister a command by name.
   * @param {string} name
   */
  unregister(name) {
    const lower = name.toLowerCase();
    if (this._registry.has(lower)) {
      this._registry.delete(lower);
      log.debug(`Unregistered command: ${lower}`);
      return true;
    }
    return false;
  }

  // ─── Middleware & Hooks ──────────────────────

  /**
   * Add middleware that runs before every command.
   * Signature: async (msg, next) => void
   * Call next() to proceed to the command.
   */
  use(middleware) {
    if (typeof middleware !== 'function') throw new TypeError('Middleware must be a function');
    this._middleware.push(middleware);
  }

  /** Register a before-command hook. Signature: async (msg) => boolean|void */
  before(handler) {
    this._before.push(handler);
  }

  /** Register an after-command hook. Signature: async (msg, result) => void */
  after(handler) {
    this._after.push(handler);
  }

  // ─── Lookup ─────────────────────────────────

  /**
   * Find a command definition by name (case-insensitive).
   * @param {string} name
   * @returns {object|undefined}
   */
  find(name) {
    return this._registry.get(name?.toLowerCase());
  }

  /** Return all registered command definitions (deduped by primary name). */
  getAll() {
    const seen = new Set();
    const out  = [];
    for (const def of this._registry.values()) {
      if (!seen.has(def._primaryName)) {
        seen.add(def._primaryName);
        out.push(def);
      }
    }
    return out;
  }

  /** Return commands grouped by category. */
  getByCategory() {
    const map = new Map();
    for (const def of this.getAll()) {
      const cat = def.category ?? 'General';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(def);
    }
    return Object.fromEntries(map);
  }

  // ─── Cooldowns ──────────────────────────────

  /**
   * Check and set cooldown for a user+command pair.
   * @returns {{ ok: boolean, remaining: number }}
   */
  checkCooldown(userId, commandName, cooldownSeconds) {
    if (!cooldownSeconds || cooldownSeconds <= 0) return { ok: true, remaining: 0 };

    const now       = Date.now();
    const userCools = this._cooldowns.get(userId) ?? new Map();
    const expiry    = userCools.get(commandName) ?? 0;

    if (now < expiry) {
      return { ok: false, remaining: Math.ceil((expiry - now) / 1000) };
    }

    userCools.set(commandName, now + cooldownSeconds * 1000);
    this._cooldowns.set(userId, userCools);
    return { ok: true, remaining: 0 };
  }

  clearCooldowns(userId = null) {
    if (userId) {
      this._cooldowns.delete(userId);
    } else {
      this._cooldowns.clear();
    }
  }

  // ─── Process incoming message ────────────────

  /**
   * Route a parsed message to the matching command.
   * Returns true if a command was matched and executed.
   *
   * @param {object} msg  - parsed message from Parser.js
   * @param {object} bot  - Client instance
   */
  async process(msg, bot) {
    if (!msg.isCommand || !msg.command) return false;

    const def = this.find(msg.command);
    if (!def || def.disabled) return false;

    // ── Permission checks ──────────────────────
    if (def.owner    && !msg.isOwner)    { await msg.reply('⚠️ This command is for owners only.'); return true; }
    if (def.group    && !msg.isGroup)    { await msg.reply('⚠️ This command can only be used in groups.'); return true; }
    if (def.private  &&  msg.isGroup)    { await msg.reply('⚠️ This command can only be used in private chat.'); return true; }
    if (def.admin    && !msg.isAdmin)    { await msg.reply('⚠️ You need to be a group admin to use this command.'); return true; }
    if (def.botAdmin && !msg.isBotAdmin) { await msg.reply('⚠️ I need admin privileges to run this command.'); return true; }

    // ── Cooldown ───────────────────────────────
    if (def.cooldown) {
      const cd = this.checkCooldown(msg.sender, def._primaryName, def.cooldown);
      if (!cd.ok) {
        await msg.reply(`⏳ Please wait ${cd.remaining}s before using this command again.`);
        return true;
      }
    }

    // ── Build context ──────────────────────────
    const ctx = {
      text:    msg.text.slice((msg.prefix?.length ?? 0) + msg.command.length).trim(),
      args:    msg.args,
      command: msg.command,
      prefix:  msg.prefix,
      conn:    bot.sock,
      bot,
    };

    // ── Run middleware chain ───────────────────
    let middlewareAborted = false;
    const runMiddleware = async (index) => {
      if (index >= this._middleware.length) return;
      await this._middleware[index](msg, () => runMiddleware(index + 1));
    };

    // ── Before hooks ──────────────────────────
    for (const hook of this._before) {
      const result = await _safeRun(() => hook(msg, ctx, bot), 'before-hook');
      if (result === false) { middlewareAborted = true; break; }
    }
    if (middlewareAborted) return true;

    await runMiddleware(0);

    // ── Command's own before handler ──────────
    if (typeof def.before === 'function') {
      const result = await _safeRun(() => def.before(msg, ctx, bot), `${def._primaryName}:before`);
      if (result === false) return true;
    }

    // ── Execute ───────────────────────────────
    let result;
    try {
      result = await def.execute(msg, ctx, bot);
    } catch (err) {
      log.error(`Error in command "${def._primaryName}": ${err.message}`);
      await msg.reply(`❌ An error occurred while running \`${def._primaryName}\`.`).catch(() => {});
    }

    // ── Command's own after handler ───────────
    if (typeof def.after === 'function') {
      await _safeRun(() => def.after(msg, ctx, bot), `${def._primaryName}:after`);
    }

    // ── After hooks ───────────────────────────
    for (const hook of this._after) {
      await _safeRun(() => hook(msg, result), 'after-hook');
    }

    return true;
  }

  // ─── Dynamic loading ─────────────────────────

  /**
   * Load a single command file.
   * The file must have a default export that is either:
   *  - a command definition object, or
   *  - an array of command definition objects
   */
  async loadFile(filePath) {
    const absPath = resolve(filePath);
    const ext     = extname(absPath);
    if (!['.js', '.mjs', '.cjs'].includes(ext)) return;

    // Unload old registrations from this file first
    this._unloadFile(absPath);

    try {
      // Cache-bust with timestamp so hot-reload works
      const url = `${pathToFileURL(absPath).href}?t=${Date.now()}`;
      const mod = await import(url);
      const defs = mod.default ?? mod;

      const list = Array.isArray(defs) ? defs : [defs];
      for (const def of list) {
        this.register(def, absPath);
      }

      log.info(`Loaded: ${basename(absPath)}`);
    } catch (err) {
      log.error(`Failed to load ${basename(absPath)}: ${err.message}`);
    }
  }

  /** Load all .js files from a directory (non-recursive). */
  async loadDirectory(dirPath) {
    let files;
    try {
      files = readdirSync(dirPath).filter((f) => ['.js', '.mjs'].includes(extname(f)));
    } catch {
      log.warn(`Commands directory not found: ${dirPath}`);
      return;
    }

    log.info(`Loading ${files.length} command file(s) from ${dirPath}`);
    for (const f of files) {
      await this.loadFile(resolve(dirPath, f));
    }
  }

  // ─── File watcher for hot-reload ─────────────

  startWatching(dirPath) {
    if (this._watcher) return;
    const abs = resolve(dirPath);
    try {
      this._watcher = fsWatch(abs, { persistent: false }, async (event, filename) => {
        if (!filename || !['.js', '.mjs'].includes(extname(filename))) return;
        const filePath = resolve(abs, filename);
        log.info(`File changed: ${filename} — reloading…`);
        // Small debounce
        clearTimeout(this._watchTimer);
        this._watchTimer = setTimeout(() => this.loadFile(filePath), 200);
      });
      log.info(`Watching ${abs} for command changes`);
    } catch (err) {
      log.warn(`Could not start file watcher: ${err.message}`);
    }
  }

  stopWatching() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
  }

  _unloadFile(absPath) {
    const names = this._fileMap.get(absPath) ?? [];
    for (const name of names) {
      this._registry.delete(name);
    }
    this._fileMap.delete(absPath);
  }

  /** Stats summary for logging. */
  stats() {
    return {
      total:      this.getAll().length,
      files:      this._fileMap.size,
      middleware: this._middleware.length,
    };
  }
}

// ─────────────────────────────────────────────
//  Private helpers
// ─────────────────────────────────────────────

function _normaliseNames(def) {
  const primary = def.command ?? def.name ?? '';
  const names   = Array.isArray(primary) ? primary : [primary];
  const aliases  = Array.isArray(def.aliases) ? def.aliases : [];
  return [...new Set([...names, ...aliases])].map((n) => n.toLowerCase()).filter(Boolean);
}

async function _safeRun(fn, label) {
  try {
    return await fn();
  } catch (err) {
    log.warn(`Error in ${label}: ${err.message}`);
    return undefined;
  }
}
