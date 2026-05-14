/* Copyright (c) 2026 ESCANOR - Cyber Dev. All rights reserved. Built for ESCANOR Academy. */

import chalk from 'chalk';

// ─────────────────────────────────────────────
//  Log levels
// ─────────────────────────────────────────────
export const LogLevel = Object.freeze({
  DEBUG: 0,
  INFO:  1,
  WARN:  2,
  ERROR: 3,
  NONE:  4,
});

// Brand colours
const BRAND   = chalk.bold.hex('#FF6B00');   // orange — ESCANOR accent
const TAG     = chalk.bgHex('#FF6B00').bold.black;
const DIM     = chalk.dim;

const LEVEL_STYLES = {
  debug: chalk.cyan,
  info:  chalk.green,
  warn:  chalk.yellow,
  error: chalk.red,
};

const LEVEL_ICONS = {
  debug: '⚙',
  info:  '✔',
  warn:  '⚠',
  error: '✖',
};

// ─────────────────────────────────────────────
//  Timestamp helper
// ─────────────────────────────────────────────
function timestamp() {
  return DIM(new Date().toISOString().replace('T', ' ').split('.')[0]);
}

// ─────────────────────────────────────────────
//  EscanorLogger class
// ─────────────────────────────────────────────
export class EscanorLogger {
  /**
   * @param {string}  context  - e.g. 'Client', 'CommandSystem'
   * @param {number}  level    - minimum log level (LogLevel.*)
   */
  constructor(context = 'ESCANOR-WS', level = LogLevel.INFO) {
    this.context = context;
    this.level   = level;
  }

  setLevel(level) {
    this.level = level;
  }

  // Internal print method — never leaks creds
  _print(levelName, message, data) {
    if (LogLevel[levelName.toUpperCase()] < this.level) return;

    const style = LEVEL_STYLES[levelName] ?? chalk.white;
    const icon  = LEVEL_ICONS[levelName]  ?? '·';

    const prefix = [
      timestamp(),
      TAG(` ESCANOR-WS `),
      BRAND(`[${this.context}]`),
      style(`${icon} ${levelName.toUpperCase()}`),
    ].join(' ');

    // Guard: never print anything that looks like creds / session tokens
    const safeMsg = _sanitizeForLog(message);

    if (data !== undefined) {
      const safeData = _sanitizeForLog(
        typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)
      );
      console.log(`${prefix}  ${safeMsg}\n${DIM(safeData)}`);
    } else {
      console.log(`${prefix}  ${safeMsg}`);
    }
  }

  debug(message, data) { this._print('debug', message, data); }
  info (message, data) { this._print('info',  message, data); }
  warn (message, data) { this._print('warn',  message, data); }
  error(message, data) { this._print('error', message, data); }

  /** Print a branded banner at startup */
  static banner() {
    console.log(
      chalk.bold(`\n${chalk.hex('#FF6B00')('███████╗███████╗ ██████╗ █████╗ ███╗   ██╗ ██████╗ ██████╗ ')}\n` +
      chalk.hex('#FF6B00')('██╔════╝██╔════╝██╔════╝██╔══██╗████╗  ██║██╔═══██╗██╔══██╗') + '\n' +
      chalk.hex('#FF8C00')('█████╗  ███████╗██║     ███████║██╔██╗ ██║██║   ██║██████╔╝') + '\n' +
      chalk.hex('#FFA500')('██╔══╝  ╚════██║██║     ██╔══██║██║╚██╗██║██║   ██║██╔══██╗') + '\n' +
      chalk.hex('#FFB732')('███████╗███████║╚██████╗██║  ██║██║ ╚████║╚██████╔╝██║  ██║') + '\n' +
      chalk.hex('#FFC864')('╚══════╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝') + '\n') +
      chalk.dim('  WhatsApp Bot Framework  ') +
      chalk.hex('#FF6B00').bold('v1.0.0') +
      chalk.dim('  |  Copyright © 2026 ESCANOR - Cyber Dev\n')
    );
  }
}

// ─────────────────────────────────────────────
//  Security: redact credential-like patterns
// ─────────────────────────────────────────────
const REDACT_PATTERNS = [
  /("privateKey"\s*:\s*")[^"]+"/gi,
  /("signedIdentityKey"\s*:\s*")[^"]+"/gi,
  /("signedPreKey"\s*:\s*")[^"]+"/gi,
  /("registrationId"\s*:\s*)\d+/gi,
  /"(password|token|secret|apiKey|api_key)"\s*:\s*"[^"]+"/gi,
];

function _sanitizeForLog(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const pat of REDACT_PATTERNS) {
    out = out.replace(pat, '[REDACTED]');
  }
  return out;
}

// Convenience: a default shared logger instance
export const logger = new EscanorLogger('Core');
