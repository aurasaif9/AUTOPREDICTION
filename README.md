# Telegram Bot — Render Web Service

Sudhu 2 ta file: `index.js` + `package.json`. Plain JavaScript, no build step.

## Render settings
- **Service type:** Web Service
- **Root Directory:** `bot`
- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Env:** `TELEGRAM_BOT_TOKEN` = BotFather token (required)
- (optional) `CONFIG_PATH` = `/tmp/bot-config.json`

Port `process.env.PORT` auto bind hoy — health check `/` returns JSON status.

## Local run
```bash
cd bot
npm install
export TELEGRAM_BOT_TOKEN=xxxxx
npm start
```
