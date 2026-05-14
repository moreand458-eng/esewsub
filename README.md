# ESCANOR-WS

> **A clean, high-performance WhatsApp Bot Framework built on `@whiskeysockets/baileys`.**
> Zero obfuscation. 100% transparent code. All session data stays local.

Copyright © 2026 ESCANOR - Cyber Dev. Built for ESCANOR Academy.

---

## ✨ Features

- **Zero obfuscation** — no `eval()`, no `atob()`, no hex-encoded strings
- **Multi-device auth** — QR code *or* Pairing Code via `useMultiFileAuthState`
- **Modular command system** — dynamic file loading, aliases, cooldowns, permissions
- **Clean message parser** — ergonomic `msg` object (`msg.text`, `msg.sender`, `msg.quoted`, …)
- **Middleware support** — before/after hooks for logging, anti-spam, analytics
- **Media helpers** — send images, video, audio, documents, stickers, buttons, lists
- **Event emitter** — `bot.on('message', …)`, `bot.on('ready', …)`, etc.
- **Exponential backoff reconnection** — survives network drops gracefully
- **Branded logger** — `[ESCANOR-WS]` console output with chalk colours
- **Security-first** — input sanitisation, credential redaction in logs, no external pings

---

## 📁 File Structure

```
escanor-ws/
├── src/
│   ├── core/
│   │   ├── Client.js          ← Main Client class (heart of the framework)
│   │   └── AuthManager.js     ← Multi-device auth, QR / Pairing Code
│   ├── handlers/
│   │   ├── CommandSystem.js   ← Command registry, loader, middleware, cooldowns
│   │   └── EventHandler.js    ← Bridges Baileys events to ESCANOR-WS API
│   ├── utils/
│   │   ├── Logger.js          ← Branded EscanorLogger + security redaction
│   │   ├── Config.js          ← Config builder & owner check helper
│   │   ├── Parser.js          ← Transforms WAMessage → clean msg object
│   │   └── Media.js           ← Image / video / doc / button / list senders
│   └── index.js               ← Public exports
├── example/
│   ├── bot.js                 ← Full example bot
│   └── commands/
│       ├── ping.js
│       ├── info.js
│       ├── help.js
│       └── owner.js
├── sessions/                  ← Auto-created; all auth stays local
├── package.json
└── README.md
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure your bot (`example/bot.js`)

```js
import { Client, EscanorLogger } from './src/index.js';

EscanorLogger.banner();

const bot = new Client({
  sessionPath:  './sessions/main',
  phoneNumber:  '',          // set your number for pairing code, or leave '' for QR
  prefix:       ['.', '!'],
  commandsPath: './commands',
  owners:       [{ jid: '1234567890', name: 'Admin' }],
});

bot.start();
```

### 3. Run

```bash
node example/bot.js
```

Scan the QR (or enter the pairing code) and you're live.

---

## 📝 Writing Commands

Create a `.js` file in your `commands/` folder with a default export:

```js
// commands/greet.js
export default {
  command:     'greet',
  aliases:     ['hi', 'hello'],
  description: 'Send a greeting.',
  category:    'Fun',
  cooldown:    10,            // seconds
  // owner: true              // owner-only
  // group: true              // group-only
  // admin: true              // group-admin-only

  async execute(msg, ctx, bot) {
    await msg.reply(`👋 Hello, ${msg.name}!`);
  },
};
```

Export an **array** to put multiple commands in one file:

```js
export default [ commandA, commandB ];
```

---

## 🧩 Middleware

```js
bot.useMiddleware(async (msg, next) => {
  console.log(`[LOG] ${msg.sender} → ${msg.command}`);
  await next();   // call next() to continue to the command
});
```

---

## 📸 Sending Media

```js
// Inside a command execute() or event handler:
await bot.media.sendImage(msg.chat, './photo.jpg', { caption: 'Look!', quoted: msg.raw });
await bot.media.sendVideo(msg.chat, 'https://example.com/clip.mp4');
await bot.media.sendDocument(msg.chat, './report.pdf', { filename: 'Report.pdf' });
await bot.media.sendButtons(msg.chat, {
  text:    'Choose an option:',
  buttons: [{ id: 'opt1', text: 'Option 1' }, { id: 'opt2', text: 'Option 2' }],
});
```

---

## 🔒 Security Notes

- `creds.json` is **never** printed to logs (automatic redaction in `Logger.js`).
- All incoming command text is run through `sanitizeInput()` which strips dangerous patterns.
- The framework makes **zero external HTTP calls** — your session stays 100% local.
- Dependencies are minimal and well-known: `baileys`, `pino`, `chalk`, `qrcode-terminal`.

---

## 📋 Client Events

| Event           | Payload                | When                              |
|-----------------|------------------------|-----------------------------------|
| `ready`         | `sock`                 | Connection established            |
| `disconnected`  | `statusCode`           | Connection closed                 |
| `logged_out`    | —                      | WhatsApp logged out the session   |
| `max_reconnect` | —                      | Hit max reconnect attempts        |
| `message`       | `msg`                  | Every incoming message            |
| `group_update`  | `event`                | Group participant change          |
| `pairing_code`  | `code`                 | Pairing code issued               |

---

## ⚙️ Config Reference

| Key                   | Type              | Default            | Description                              |
|-----------------------|-------------------|--------------------|------------------------------------------|
| `phoneNumber`         | `string`          | `''`               | Phone for pairing code (empty = QR)      |
| `sessionPath`         | `string`          | `'./sessions'`     | Where auth files are stored              |
| `prefix`              | `string\|string[]`| `['.','!','/']`    | Command prefix(es)                       |
| `owners`              | `object[]`        | `[]`               | `[{ jid, name? }]`                       |
| `commandsPath`        | `string`          | `'./commands'`     | Folder auto-loaded on start              |
| `autoReconnect`       | `boolean`         | `true`             | Reconnect on drop                        |
| `reconnectDelay`      | `number`          | `3000`             | Initial backoff delay (ms)               |
| `maxReconnectAttempts`| `number`          | `10`               | 0 = unlimited                            |
| `autoRead`            | `boolean`         | `false`            | Send read receipts automatically         |
| `fromMe`              | `boolean`         | `false`            | Process self-sent messages               |
| `showLogs`            | `boolean`         | `false`            | Verbose pino socket logs                 |
| `onConnected`         | `async function`  | `null`             | Called when connection opens             |
| `onDisconnected`      | `async function`  | `null`             | Called on close                          |
| `onError`             | `function`        | `null`             | Called on processing errors              |
