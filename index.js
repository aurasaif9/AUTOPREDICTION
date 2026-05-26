import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.CONFIG_PATH ?? path.join(__dirname, "../bot-config.json");

function defaultConfig() {
  return {
    channelId: "",
    bigImageFileId: "",
    smallImageFileId: "",
    winStickerFileId: "",
    lossStickerFileId: "",
    seasonStartStickerFileId: "",
    seasonEndStickerFileId: "",
    seasons: [],
    teamName: "DeSh Club",
    isRunning: false,
    adminIds: [],
    sessionHistory: []
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
      const saved = JSON.parse(raw);
      const merged = { ...defaultConfig(), ...saved };
      if (!merged.seasons) merged.seasons = [];
      if (!merged.sessionHistory) merged.sessionHistory = [];
      if (merged.seasons.length === 0 && (saved.sessionStart || saved.sessionEnd)) {
        merged.seasons = [{ start: saved.sessionStart || "09:00", end: saved.sessionEnd || "22:00" }];
      }
      return merged;
    }
  } catch {}
  return defaultConfig();
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  } catch (e) {
    console.error("Config save error:", e);
  }
}

// ─── PREDICTION LOGIC ─────────────────────────────────────────────────────────
const strategies = [
  (h) => h[0].n >= 5 ? "BIG" : "SMALL",
  (h) => h[0].n >= 5 ? "SMALL" : "BIG",
  (h) => h.slice(0, 3).reduce((a, b) => a + b.n, 0) % 2 === 0 ? "SMALL" : "BIG",
  (h) => h.slice(0, 5).filter((x) => x.n >= 5).length >= 3 ? "BIG" : "SMALL",
  (h) => (h[1] || h[0]).n >= 5 ? "SMALL" : "BIG",
  (h) => h.slice(0, 4).filter((x) => x.n >= 5).length <= 1 ? "BIG" : "SMALL",
  (h) => {
    const n = h[0].n;
    return n >= 8 ? "SMALL" : n <= 1 ? "BIG" : n >= 5 ? "BIG" : "SMALL";
  },
  (h) => h.slice(0, 5).reduce((a, b) => a + b.n, 0) / 5 >= 4.5 ? "BIG" : "SMALL",
  (h) => {
    const t = h[0].n >= 5 ? "BIG" : "SMALL";
    let cnt = 0;
    for (let i = 0; i < Math.min(5, h.length); i++) {
      if ((h[i].n >= 5 ? "BIG" : "SMALL") === t) cnt++;
      else break;
    }
    return cnt >= 3 ? (t === "BIG" ? "SMALL" : "BIG") : t;
  },
  (h) => {
    const t = h[0].n >= 5 ? "BIG" : "SMALL";
    return h.length > 1 && (h[1].n >= 5 ? "BIG" : "SMALL") === t ? t : (t === "BIG" ? "SMALL" : "BIG");
  },
  (h) => {
    const bigs = h.slice(0, 10).filter((x) => x.n >= 5).length;
    return bigs < 4 ? "BIG" : bigs > 6 ? "SMALL" : (h[0].n >= 5 ? "BIG" : "SMALL");
  },
  (h) => {
    const w = [3, 2, 1];
    let score = 0, total = 0;
    for (let i = 0; i < Math.min(3, h.length); i++) {
      score += (h[i].n >= 5 ? 1 : 0) * w[i];
      total += w[i];
    }
    return score / total >= 0.5 ? "BIG" : "SMALL";
  },
  (h) => {
    if (h.length < 4) return "BIG";
    const p = [h[3], h[2], h[1], h[0]].map((x) => x.n >= 5 ? "BIG" : "SMALL");
    if (p[0] === p[1] && p[1] !== p[2]) return p[2];
    return (h[0].n >= 5 ? "BIG" : "SMALL") === "BIG" ? "SMALL" : "BIG";
  },
  (h) => {
    const sorted = [...h.slice(0, 5).map((x) => x.n)].sort((a, b) => a - b);
    return sorted[2] >= 5 ? "BIG" : "SMALL";
  }
];

function multiVote(hist) {
  if (!hist || hist.length < 3) return { pred: "BIG", bigPct: 50, smallPct: 50, confidence: 50 };
  const scores = strategies.map((fn, idx) => {
    let score = 0, tested = 0;
    for (let j = 0; j < Math.min(12, hist.length - 2); j++) {
      const slice = hist.slice(j + 1, j + 8);
      if (slice.length < 2) continue;
      try {
        if (fn(slice) === (hist[j].n >= 5 ? "BIG" : "SMALL")) score++;
        tested++;
      } catch {}
    }
    return { idx, rate: tested > 0 ? score / tested : 0.5 };
  }).sort((a, b) => b.rate - a.rate);

  let bigW = 0, smallW = 0;
  for (const s of scores.slice(0, 8)) {
    try {
      const pred = strategies[s.idx](hist);
      const w = Math.max(0.1, s.rate);
      if (pred === "BIG") bigW += w;
      else smallW += w;
    } catch {}
  }
  const total = bigW + smallW;
  const bigPct = Math.round(bigW / total * 100);
  const margin = Math.abs(bigPct - 50);
  const bestRate = Math.round((scores[0]?.rate ?? 0.5) * 100);
  return {
    pred: bigW >= smallW ? "BIG" : "SMALL",
    bigPct,
    smallPct: 100 - bigPct,
    confidence: Math.round(margin * 0.55 + bestRate * 0.45)
  };
}

function jackpotNums(pred, nextPeriod) {
  const ps = Number(BigInt(nextPeriod) % 3n);
  if (pred === "BIG") return ps === 0 ? [5, 7] : ps === 1 ? [6, 8] : [7, 9];
  return ps === 0 ? [0, 2] : ps === 1 ? [1, 3] : [2, 4];
}
// ─────────────────────────────────────────────────────────────────────────────

const WINGO_ENDPOINTS = [
  { ip: "144.217.68.82", host: "auraxsaif.top", path: "/api/wingo/1m.php" }
];

function fetchFromEndpoint(ep) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ep.ip,
      port: 443,
      path: ep.path,
      method: "GET",
      headers: {
        "Host": ep.host,
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      },
      rejectUnauthorized: false
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const list = json.data?.list ?? json.list ?? (Array.isArray(json) ? json : []);
          const items = list.map((i) => ({
            period: String(i.issueNumber ?? "0"),
            n: parseInt(String(i.number ?? "0"))
          })).filter((i) => !isNaN(i.n) && i.period !== "0");
          if (items.length === 0) reject(new Error("Empty list"));
          else resolve(items);
        } catch {
          reject(new Error("Parse error"));
        }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.end();
  });
}

async function fetchWingo() {
  for (const ep of WINGO_ENDPOINTS) {
    try {
      const items = await fetchFromEndpoint(ep);
      if (items.length > 0) {
        console.log(`✅ API OK [${ep.host}] — latest period: ${items[0].period}`);
        return { items, live: true };
      }
    } catch (e) {
      console.log(`⚠️  API failed [${ep.host}]: ${e.message}`);
    }
  }
  return { items: [], live: false };
}

function generateFallbackHistory() {
  const now = new Date();
  const bd = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
  const ymd = `${bd.getFullYear()}${String(bd.getMonth() + 1).padStart(2, "0")}${String(bd.getDate()).padStart(2, "0")}`;
  const minuteOfDay = bd.getHours() * 60 + bd.getMinutes();
  const baseSeq = 10000 + minuteOfDay;
  const hash = (n) => (n * 2654435761 >>> 0) % 10;
  return Array.from({ length: 20 }, (_, i) => ({
    period: `${ymd}0${String(baseSeq - i).padStart(5, "0")}`,
    n: hash(minuteOfDay - i)
  }));
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN missing!");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: { interval: 1000, autoStart: true, params: { timeout: 10 } } });
let cfg = loadConfig();
const adminStates = new Map();
const seasonBuildState = new Map();
let lastPred = null;
let lastSentPeriod = "";
let signalInterval = null;
let seasonWatchInterval = null;
let lastInSession = false;

function mainMenuKb() {
  return {
    inline_keyboard: [
      [{ text: "⚙️ Settings", callback_data: "menu_settings" }, { text: "📊 Status", callback_data: "menu_status" }],
      [{ text: "▶️ Start Bot", callback_data: "menu_start" }, { text: "⏹ Stop Bot", callback_data: "menu_stop" }],
      [{ text: "🧪 Test Signal", callback_data: "menu_test" }]
    ]
  };
}

function settingsKb() {
  return {
    inline_keyboard: [
      [{ text: "📢 Set Channel", callback_data: "set_channel" }],
      [{ text: "🟢 BIG Image", callback_data: "set_big_image" }, { text: "🔴 SMALL Image", callback_data: "set_small_image" }],
      [{ text: "✅ WIN Sticker", callback_data: "set_win_sticker" }, { text: "❌ LOSS Sticker", callback_data: "set_loss_sticker" }],
      [{ text: "🚀 Season START Sticker", callback_data: "set_season_start_sticker" }],
      [{ text: "🏁 Season END Sticker", callback_data: "set_season_end_sticker" }],
      [{ text: "⏰ Set Sessions (4 max)", callback_data: "set_seasons" }],
      [{ text: "👥 Team Name", callback_data: "set_team_name" }],
      [{ text: "🔙 Back", callback_data: "menu_main" }]
    ]
  };
}

function backKb() {
  return { inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu_main" }]] };
}

function isAdmin(uid) {
  return cfg.adminIds.length === 0 || cfg.adminIds.includes(uid);
}

function getBDTime() {
  const now = new Date();
  const bd = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
  return { h: bd.getHours(), m: bd.getMinutes(), dateStr: bd.toLocaleDateString("en-US") };
}

function isInSession() {
  if (cfg.seasons.length === 0) return true;
  const { h, m } = getBDTime();
  const cur = h * 60 + m;
  return cfg.seasons.some((s) => {
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    return cur >= sh * 60 + sm && cur < eh * 60 + em;
  });
}

function canSendSignal() {
  return cfg.isRunning && !!cfg.channelId && isInSession();
}

function seasonsText() {
  if (cfg.seasons.length === 0) return "  No restriction (sends anytime)";
  return cfg.seasons.map((s, i) => `  Season ${i + 1}: ${s.start} – ${s.end}`).join("\n");
}

function statusText() {
  const { h, m } = getBDTime();
  const nowStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `📊 *Bot Status*
━━━━━━━━━━━━━━━
🤖 Bot: ${cfg.isRunning ? "🟢 RUNNING" : "🔴 STOPPED"}
📢 Channel: \`${cfg.channelId || "Not set"}\`
👥 Team: *${cfg.teamName} AI BOT*

⏰ *Sessions (BD Time):*
${seasonsText()}

📍 Now: \`${nowStr}\` BD — ${isInSession() ? "✅ In Session" : "⏸ Out of Session"}
🟢 BIG Img: ${cfg.bigImageFileId ? "✅" : "❌"} | 🔴 SMALL Img: ${cfg.smallImageFileId ? "✅" : "❌"}
✅ Win: ${cfg.winStickerFileId ? "✅" : "❌"} | ❌ Loss: ${cfg.lossStickerFileId ? "✅" : "❌"}
🚀 Season Start: ${cfg.seasonStartStickerFileId ? "✅" : "❌"} | 🏁 Season End: ${cfg.seasonEndStickerFileId ? "✅" : "❌"}
━━━━━━━━━━━━━━━`;
}

function confidenceBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

function predCaption(pred, period, nums, conf) {
  const signalIcon = pred === "BIG" ? "🟢 BIG" : "🔴 SMALL";
  const bar = confidenceBar(conf);
  return `🤖 *${cfg.teamName} AI BOT*
━━━━━━━━━━━━━━━━━━━━
🎮 WIN GO \\- 1 MINUTE
📌 PERIOD:  \`${period}\`
🎯 SIGNAL:  *${signalIcon}*
💎 JACKPOT:  *${nums.join(" • ")}*
📊 ${bar}  *${conf}%*
━━━━━━━━━━━━━━━━━━━━
✅ 5 STEPS FOLLOW PROFIT 100%
🖥 SERVER: ${cfg.teamName.toUpperCase()} API`;
}

function resultCaption(p) {
  const actualLabel = (p.actual ?? 0) >= 5 ? "BIG" : "SMALL";
  const winText = p.win ? "✅ WIN" : "❌ LOSS";
  const jackpotText = p.jackpot ? "✅ YES" : "❌ NO";
  return `💀 *PERIOD RESULT*
━━━━━━━━━━━━━━━━━━━━
📌 PERIOD RESULT:  \`${p.period}\`
🎲 OUTCOME:  *${actualLabel}*  \\(${p.actual}\\)
🎯 PREDICTION:  *${p.pred}*
📊 Result:  *${winText}*
💎 JACKPOT:  *${jackpotText}*
━━━━━━━━━━━━━━━━━━━━`;
}

function escapeMd(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => "\\" + m);
}

function sessionSummaryText(history, sessionLabel) {
  const total = history.length;
  const header = `🏁 *SEASON ENDED*${sessionLabel ? `  \\(${escapeMd(sessionLabel)}\\)` : ""}`;
  if (total === 0) {
    return `${header}
━━━━━━━━━━━━━━━━━━━━
No predictions were made this season\\.`;
  }
  const finished = history.filter((h) => h.win !== undefined);
  const wins = finished.filter((h) => h.win === true).length;
  const losses = finished.filter((h) => h.win === false).length;
  const jackpots = finished.filter((h) => h.jackpot === true).length;
  const finCount = finished.length;
  const winPct = finCount > 0 ? Math.round(wins / finCount * 100) : 0;
  const rows = history.map((h, i) => {
    const status = h.win === undefined ? "⏳" : h.win ? "✅ WIN" : "❌ LOSS";
    const jp = h.jackpot ? " 💎" : "";
    return `${i + 1}\\. \`${h.period}\` → ${h.pred} → ${status}${jp}`;
  }).join("\n");
  return `${header}
━━━━━━━━━━━━━━━━━━━━
📊 *Season Summary*

Total Signals: *${total}*
✅ WIN: *${wins}* \\(${winPct}%\\)
❌ LOSS: *${losses}* \\(${finCount > 0 ? 100 - winPct : 0}%\\)
💎 JACKPOT: *${jackpots}*

*Full History:*
${rows}
━━━━━━━━━━━━━━━━━━━━`;
}

async function sendToChannel(text) {
  if (!cfg.channelId) return;
  try {
    await bot.sendMessage(cfg.channelId, text, { parse_mode: "MarkdownV2" });
  } catch (e) {
    console.error("Channel send error:", e.message);
  }
}

async function sendStickerToChannel(fileId) {
  if (!cfg.channelId || !fileId) return;
  try {
    await bot.sendSticker(cfg.channelId, fileId);
  } catch (e) {
    console.error("Sticker send error:", e.message);
  }
}

function currentSeasonLabel() {
  const { h, m } = getBDTime();
  const cur = h * 60 + m;
  const idx = cfg.seasons.findIndex((s) => {
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    return cur >= sh * 60 + sm && cur < eh * 60 + em;
  });
  if (idx >= 0) {
    const s = cfg.seasons[idx];
    return `Season ${idx + 1}: ${s.start}–${s.end}`;
  }
  return "";
}

async function handleSeasonStart() {
  cfg.sessionHistory = [];
  saveConfig(cfg);
  const label = currentSeasonLabel();
  console.log(`🚀 Season START detected (${label})`);
  await sendToChannel(`🚀 *SEASON STARTED*
━━━━━━━━━━━━━━━━━━━━
🤖 ${escapeMd(cfg.teamName)} AI BOT
${label ? `⏰ ${escapeMd(label)}` : ""}
🎮 WIN GO \\- 1 MINUTE signals starting\\.\\.\\.
━━━━━━━━━━━━━━━━━━━━`);
  await sendStickerToChannel(cfg.seasonStartStickerFileId);
}

async function handleSeasonEnd(prevLabel) {
  console.log(`🏁 Season END detected`);
  await sendStickerToChannel(cfg.seasonEndStickerFileId);
  await sendToChannel(sessionSummaryText(cfg.sessionHistory, prevLabel));
  cfg.sessionHistory = [];
  saveConfig(cfg);
}

async function sendSignal(pred, period, nums, conf, force = false) {
  const caption = predCaption(pred, period, nums, conf);
  const imgId = pred === "BIG" ? cfg.bigImageFileId : cfg.smallImageFileId;
  try {
    if (imgId) {
      await bot.sendPhoto(cfg.channelId, imgId, { caption, parse_mode: "MarkdownV2" });
    } else {
      await bot.sendMessage(cfg.channelId, caption, { parse_mode: "MarkdownV2" });
    }
    lastSentPeriod = period;
    console.log(`✅ Signal [${period}] → ${pred} (${conf}%)`);
    return true;
  } catch (e) {
    console.error("Signal send error:", e.message);
    return false;
  }
}

async function sendResult(p) {
  const caption = resultCaption(p);
  try {
    await bot.sendMessage(cfg.channelId, caption, { parse_mode: "MarkdownV2" });
    const stickerId = p.win ? cfg.winStickerFileId : cfg.lossStickerFileId;
    if (stickerId) {
      await bot.sendSticker(cfg.channelId, stickerId);
    }
    console.log(`📊 Result [${p.period}] → ${p.win ? "WIN" : "LOSS"}${p.jackpot ? " 💎JACKPOT" : ""}`);
  } catch (e) {
    console.error("Result send error:", e.message);
  }
}

async function signalCycle(force = false) {
  if (!force && !canSendSignal()) return "skipped";
  if (!cfg.channelId) return "no_channel";

  const { items, live } = await fetchWingo();
  const hist = live && items.length > 0 ? items : generateFallbackHistory();
  if (!live) console.log("⚠️  Using fallback prediction (API unreachable)");

  // Check result for previous prediction
  if (lastPred && !lastPred.resultSent && live) {
    const found = items.find((i) => i.period === lastPred.period);
    if (found) {
      const actualLabel = found.n >= 5 ? "BIG" : "SMALL";
      lastPred.actual = found.n;
      lastPred.win = actualLabel === lastPred.pred;
      lastPred.jackpot = lastPred.nums.includes(found.n);
      lastPred.resultSent = true;
      await sendResult(lastPred);
      const idx = cfg.sessionHistory.findIndex((h) => h.period === lastPred.period);
      if (idx >= 0) cfg.sessionHistory[idx] = { ...lastPred };
      else cfg.sessionHistory.push({ ...lastPred });
      saveConfig(cfg);
    }
  }

  // API theke latest period nao, tar sathe +1 koro — eita next period
  const latest = hist[0];
  const nextPeriod = (BigInt(latest.period) + 1n).toString();

  if (!force && lastSentPeriod === nextPeriod) return "duplicate";

  const vote = multiVote(hist);
  const nums = jackpotNums(vote.pred, nextPeriod);
  const ok = await sendSignal(vote.pred, nextPeriod, nums, vote.confidence, force);
  if (!ok) return "send_error";

  lastPred = { period: nextPeriod, pred: vote.pred, nums, conf: vote.confidence };
  cfg.sessionHistory.push({ period: nextPeriod, pred: vote.pred, nums, conf: vote.confidence });
  saveConfig(cfg);
  return "ok";
}

let prevSeasonLabel = "";

async function seasonWatchTick() {
  if (!cfg.isRunning) return;
  const nowIn = isInSession();
  if (nowIn && !lastInSession) {
    lastInSession = true;
    prevSeasonLabel = currentSeasonLabel();
    await handleSeasonStart();
  } else if (!nowIn && lastInSession) {
    lastInSession = false;
    await handleSeasonEnd(prevSeasonLabel);
    prevSeasonLabel = "";
  }
}

function startSignalLoop() {
  if (signalInterval) return;
  console.log("▶️  Signal loop started");
  lastInSession = isInSession();
  if (lastInSession) prevSeasonLabel = currentSeasonLabel();
  signalInterval = setInterval(() => {
    signalCycle().catch(console.error);
  }, 60000);
  signalCycle().catch(console.error);
  if (!seasonWatchInterval) {
    seasonWatchInterval = setInterval(() => {
      seasonWatchTick().catch(console.error);
    }, 15000);
  }
}

function stopSignalLoop() {
  if (signalInterval) { clearInterval(signalInterval); signalInterval = null; }
  if (seasonWatchInterval) { clearInterval(seasonWatchInterval); seasonWatchInterval = null; }
}

async function safeAnswer(queryId) {
  try { await bot.answerCallbackQuery(queryId); } catch {}
}

function currentSeasonIndex(state) {
  const map = {
    wait_s1_start: 0, wait_s1_end: 0,
    wait_s2_start: 1, wait_s2_end: 1,
    wait_s3_start: 2, wait_s3_end: 2,
    wait_s4_start: 3, wait_s4_end: 3
  };
  return map[state] ?? 0;
}

function ordinal(n) {
  return ["1st", "2nd", "3rd", "4th"][n] ?? `${n + 1}th`;
}

bot.onText(/\/start/, async (msg) => {
  const uid = msg.from.id;
  if (cfg.adminIds.length === 0) {
    cfg.adminIds.push(uid);
    saveConfig(cfg);
  }
  adminStates.set(uid, "idle");
  await bot.sendMessage(
    msg.chat.id,
    `🤖 *${cfg.teamName} AI BOT*\n━━━━━━━━━━━━━━━\nWingo 1M Prediction Engine\n\nSelect an option:`,
    { parse_mode: "Markdown", reply_markup: mainMenuKb() }
  );
});

bot.onText(/\/menu/, async (msg) => {
  adminStates.set(msg.from.id, "idle");
  await bot.sendMessage(msg.chat.id, `🤖 *Main Menu*`, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
});

bot.onText(/\/status/, async (msg) => {
  await bot.sendMessage(msg.chat.id, statusText(), { parse_mode: "Markdown", reply_markup: backKb() });
});

bot.on("callback_query", async (query) => {
  const uid = query.from.id;
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data ?? "";
  await safeAnswer(query.id);
  if (!isAdmin(uid)) {
    await bot.sendMessage(chatId, "⛔ Not authorized.");
    return;
  }
  const edit = (text, kb) => {
    const markup = kb ?? backKb();
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: markup })
      .catch(() => bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup }));
  };

  switch (data) {
    case "menu_main":
      adminStates.set(uid, "idle");
      await edit(`🤖 *${cfg.teamName} AI BOT*\nMain Menu`, mainMenuKb());
      break;
    case "menu_settings":
      adminStates.set(uid, "idle");
      await edit(`⚙️ *Settings*\nConfigure your bot:`, settingsKb());
      break;
    case "menu_status":
      await edit(statusText(), { inline_keyboard: [[{ text: "🔙 Back", callback_data: "menu_main" }]] });
      break;
    case "menu_start": {
      cfg.isRunning = true;
      cfg.sessionHistory = [];
      saveConfig(cfg);
      lastInSession = false;
      startSignalLoop();
      await seasonWatchTick();
      await edit(`✅ *Bot Started!*\n\nAuto season start/end stickers + history will fire as sessions open and close.`, mainMenuKb());
      break;
    }
    case "menu_stop": {
      cfg.isRunning = false;
      saveConfig(cfg);
      if (lastInSession) {
        await handleSeasonEnd(prevSeasonLabel);
        lastInSession = false;
        prevSeasonLabel = "";
      }
      stopSignalLoop();
      await edit(`⏹ *Bot Stopped!*\nSeason end sticker + summary sent.`, mainMenuKb());
      break;
    }
    case "menu_test": {
      await edit(`🧪 *Sending test signal...*\nChannel: \`${cfg.channelId || "NOT SET"}\``);
      const result = await signalCycle(true);
      const resultMsg = {
        ok: `✅ *Test signal sent!*\nChannel: \`${cfg.channelId}\``,
        no_channel: `❌ *Channel not set!*\nSettings → 📢 Set Channel`,
        send_error: `❌ *Send failed!*\n\nPossible reasons:\n• Bot not Admin in channel\n• Wrong channel username`,
        duplicate: `⚠️ *Same period already sent!*\nWait 1 minute and try again.`
      };
      await bot.sendMessage(chatId, resultMsg[result] ?? `❌ Error: \`${result}\``, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
      break;
    }
    case "set_channel":
      adminStates.set(uid, "wait_channel");
      await bot.sendMessage(chatId, `📢 *Set Channel*\n\nSend channel username or ID:\nExample: \`@mychannel\` or \`-1001234567890\``, { parse_mode: "Markdown" });
      break;
    case "set_big_image":
      adminStates.set(uid, "wait_big_image");
      await bot.sendMessage(chatId, `🟢 *BIG Image*\n\nSend the BIG prediction image now.`, { parse_mode: "Markdown" });
      break;
    case "set_small_image":
      adminStates.set(uid, "wait_small_image");
      await bot.sendMessage(chatId, `🔴 *SMALL Image*\n\nSend the SMALL prediction image now.`, { parse_mode: "Markdown" });
      break;
    case "set_win_sticker":
      adminStates.set(uid, "wait_win_sticker");
      await bot.sendMessage(chatId, `✅ *WIN Sticker*\n\nSend the WIN sticker now.`, { parse_mode: "Markdown" });
      break;
    case "set_loss_sticker":
      adminStates.set(uid, "wait_loss_sticker");
      await bot.sendMessage(chatId, `❌ *LOSS Sticker*\n\nSend the LOSS sticker now.`, { parse_mode: "Markdown" });
      break;
    case "set_season_start_sticker":
      adminStates.set(uid, "wait_season_start_sticker");
      await bot.sendMessage(chatId, `🚀 *Season START Sticker*\n\nSend the sticker to use at season start.`, { parse_mode: "Markdown" });
      break;
    case "set_season_end_sticker":
      adminStates.set(uid, "wait_season_end_sticker");
      await bot.sendMessage(chatId, `🏁 *Season END Sticker*\n\nSend the sticker to use at season end.`, { parse_mode: "Markdown" });
      break;
    case "set_team_name":
      adminStates.set(uid, "wait_team_name");
      await bot.sendMessage(chatId, `👥 *Team Name*\n\nSend your team name:`, { parse_mode: "Markdown" });
      break;
    case "set_seasons": {
      const current = cfg.seasons.map((s, i) => `Season ${i + 1}: ${s.start}–${s.end}`).join("\n") || "None";
      seasonBuildState.set(uid, { seasons: [], step: "wait_s1_start" });
      adminStates.set(uid, "building_seasons");
      await bot.sendMessage(chatId,
        `⏰ *Set Sessions*\n\nCurrent:\n${current}\n\nLet's set up to 4 sessions.\n\nEnter *1st session START time* (HH:MM, 24h BD):`,
        { parse_mode: "Markdown" }
      );
      break;
    }
    default:
      break;
  }
});

bot.on("message", async (msg) => {
  const uid = msg.from?.id;
  if (!uid || !isAdmin(uid)) return;
  const state = adminStates.get(uid) ?? "idle";
  const chatId = msg.chat.id;

  if (state === "building_seasons") {
    const sb = seasonBuildState.get(uid);
    if (!sb) return;
    const step = sb.step;
    const text = msg.text?.trim() ?? "";

    if (step === "wait_s1_start" || step === "wait_s2_start" || step === "wait_s3_start" || step === "wait_s4_start") {
      const idx = currentSeasonIndex(step);
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await bot.sendMessage(chatId, `❌ Invalid format. Use HH:MM (e.g. 09:00). Try again:`);
        return;
      }
      sb.seasons[idx] = { start: text, end: "" };
      sb.step = step.replace("start", "end");
      seasonBuildState.set(uid, sb);
      await bot.sendMessage(chatId, `✅ Start set. Now enter *${ordinal(idx)} session END time* (HH:MM):`, { parse_mode: "Markdown" });
      return;
    }

    if (step === "wait_s1_end" || step === "wait_s2_end" || step === "wait_s3_end" || step === "wait_s4_end") {
      const idx = currentSeasonIndex(step);
      if (!/^\d{1,2}:\d{2}$/.test(text)) {
        await bot.sendMessage(chatId, `❌ Invalid format. Use HH:MM (e.g. 22:00). Try again:`);
        return;
      }
      sb.seasons[idx].end = text;
      const nextIdx = idx + 1;

      const addMoreKb = {
        inline_keyboard: [
          [{ text: "➕ Add another session", callback_data: `add_season_${nextIdx}` }],
          [{ text: "✅ Done", callback_data: "seasons_done" }]
        ]
      };

      if (nextIdx >= 4) {
        cfg.seasons = sb.seasons;
        saveConfig(cfg);
        adminStates.set(uid, "idle");
        seasonBuildState.delete(uid);
        await bot.sendMessage(chatId, `✅ *4 sessions saved!*\n${seasonsText()}`, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
      } else {
        seasonBuildState.set(uid, sb);
        await bot.sendMessage(chatId,
          `✅ *Session ${idx + 1} saved!* (${sb.seasons[idx].start}–${sb.seasons[idx].end})\n\nAdd another or finish:`,
          { parse_mode: "Markdown", reply_markup: addMoreKb }
        );
      }
      return;
    }
    return;
  }

  // Handle add_season_N and seasons_done callbacks via message handler for inline reply
  if (state === "idle") return;

  if (state === "wait_channel") {
    const val = msg.text?.trim();
    if (!val) return;
    cfg.channelId = val;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ Channel set to: \`${val}\``, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_team_name") {
    const val = msg.text?.trim();
    if (!val) return;
    cfg.teamName = val;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ Team name set to: *${val}*`, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_big_image" && msg.photo) {
    cfg.bigImageFileId = msg.photo[msg.photo.length - 1].file_id;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ BIG image saved!`, { reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_small_image" && msg.photo) {
    cfg.smallImageFileId = msg.photo[msg.photo.length - 1].file_id;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ SMALL image saved!`, { reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_win_sticker" && msg.sticker) {
    cfg.winStickerFileId = msg.sticker.file_id;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ WIN sticker saved!`, { reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_loss_sticker" && msg.sticker) {
    cfg.lossStickerFileId = msg.sticker.file_id;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ LOSS sticker saved!`, { reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_season_start_sticker" && msg.sticker) {
    cfg.seasonStartStickerFileId = msg.sticker.file_id;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ Season START sticker saved!`, { reply_markup: mainMenuKb() });
    return;
  }
  if (state === "wait_season_end_sticker" && msg.sticker) {
    cfg.seasonEndStickerFileId = msg.sticker.file_id;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    await bot.sendMessage(chatId, `✅ Season END sticker saved!`, { reply_markup: mainMenuKb() });
    return;
  }
});

// Handle add_season inline button presses
bot.on("callback_query", async (query) => {
  const uid = query.from.id;
  const chatId = query.message.chat.id;
  const data = query.data ?? "";

  if (data.startsWith("add_season_")) {
    const idx = parseInt(data.split("_")[2]);
    const sb = seasonBuildState.get(uid);
    if (!sb) return;
    await safeAnswer(query.id);
    sb.step = `wait_s${idx + 1}_start`;
    seasonBuildState.set(uid, sb);
    adminStates.set(uid, "building_seasons");
    await bot.sendMessage(chatId, `Enter *${ordinal(idx)} session START time* (HH:MM):`, { parse_mode: "Markdown" });
    return;
  }

  if (data === "seasons_done") {
    const sb = seasonBuildState.get(uid);
    if (!sb) return;
    await safeAnswer(query.id);
    cfg.seasons = sb.seasons;
    saveConfig(cfg);
    adminStates.set(uid, "idle");
    seasonBuildState.delete(uid);
    await bot.sendMessage(chatId, `✅ *Sessions saved!*\n${seasonsText()}`, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
    return;
  }
});

console.log(`🤖 ${cfg.teamName} AI BOT started. Send /start to configure.`);
if (cfg.isRunning) {
  console.log("▶️  Resuming signal loop (was running before restart)");
  startSignalLoop();
}
