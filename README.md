# EsewSub

> A professional and powerful WhatsApp bot framework built on Baileys.

[![npm version](https://badge.fury.io/js/EsewSub.svg)](https://badge.fury.io/js/EsewSub)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ Features

- 🤖 Single bot (`EsewBot`) and multi-bot (`SubBots`) support
- 🔐 Pairing code authentication (no QR needed)
- 💾 Persistent session storage with LevelDB
- 🔄 Auto-reconnect on disconnect
- 📡 Event-driven architecture
- 📋 Built-in command routing, middleware, and permissions
- 🌐 ESM + CJS dual format

## 📦 Installation

```bash
npm install esewsub
# or
npm install github:moreand458-eng/esewsub
```

## 🚀 Quick Start — Single Bot

```js
import { EsewBot } from 'esewsub';

const bot = new EsewBot({
  number: '201012345678',
  prefix: ['.', '!'],
  owners: ['201012345678'],
  pairingCode: 'ESCANOR1'
});

bot.on('pair', (code) => console.log('Pairing code:', code));
bot.on('ready', (sock) => console.log('Bot connected!'));

// Register a command
bot.registerCommand(['ping', 'سرعة'], async (ctx) => {
  await ctx.reply('🏓 Pong!');
});

bot.start();
```

## 🤖 SubBots — Multiple Bots

```js
import { SubBots } from 'esewsub';

SubBots.pariCode('ESCANOR1');

const subBots = new SubBots();

await subBots.setConfig({
  owners: ['201012345678'],
  prefix: '.',
  printQR: false
});

// Add a new sub-bot
const uid = await subBots.add('201087654321');

subBots.on('pair', (uid, code) => {
  console.log(`SubBot ${uid} pairing code: ${code}`);
});

subBots.on('ready', (uid, sock) => {
  console.log(`SubBot ${uid} connected!`);
});

subBots.on('message', (uid, msg, sock) => {
  // Handle messages
});

await subBots.load(); // Load saved bots
```

## 📚 API Reference

### EsewBot

| Method | Description |
|--------|-------------|
| `new EsewBot(config)` | Create a new bot instance |
| `bot.start()` | Connect to WhatsApp |
| `bot.registerCommand(names, handler, meta)` | Register a command |
| `bot.on(event, handler)` | Listen to events |

### SubBots

| Method | Description |
|--------|-------------|
| `new SubBots(commandSystem?)` | Create SubBots manager |
| `SubBots.pariCode(code)` | Set default pairing code |
| `subBots.setConfig(config)` | Set configuration |
| `subBots.add(number)` | Add a new sub-bot |
| `subBots.remove(uid)` | Remove a sub-bot |
| `subBots.load()` | Load saved bots |
| `subBots.get(uid)` | Get a bot instance |
| `subBots.getAll()` | Get all bot instances |

### MessageContext (ctx)

| Property | Description |
|----------|-------------|
| `ctx.sock` | Baileys socket |
| `ctx.msg` | Raw message |
| `ctx.sender` | Sender JID |
| `ctx.chat` | Chat JID |
| `ctx.isGroup` | Is group chat |
| `ctx.body` | Message text |
| `ctx.command` | Parsed command |
| `ctx.args` | Command arguments |
| `ctx.text` | Arguments as string |
| `ctx.isOwner` | Is owner |
| `ctx.isAdmin` | Is group admin |
| `ctx.reply(text)` | Send reply |
| `ctx.react(emoji)` | React to message |

## 👨‍💻 Author

**Escanor** — [GitHub](https://github.com/moreand458-eng)

## 📜 License

MIT — © Escanor
