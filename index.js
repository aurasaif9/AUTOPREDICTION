import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.CONFIG_PATH ?? path.join(__dirname, "./bot-config.json");
function defaultConfig() {
  return {
    channelId: "",
    bigImageFileId: "",
    smallImageFileId: "",
    winStickerFileId: "",
    lossStickerFileId: "",
    dailySignals: 20,
    seasons: [],
    teamName: "DeSh Club",
    isRunning: false,
    signalsSentToday: 0,
    lastSignalDate: "",
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
  } catch {
  }
  return defaultConfig();
}
function saveConfig(cfg2) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg2, null, 2), "utf-8");
  } catch (e) {
    console.error("Config save error:", e);
  }
}
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
    return cnt >= 3 ? t === "BIG" ? "SMALL" : "BIG" : t;
  },
  (h) => {
    const t = h[0].n >= 5 ? "BIG" : "SMALL";
    return h.length > 1 && (h[1].n >= 5 ? "BIG" : "SMALL") === t ? t : t === "BIG" ? "SMALL" : "BIG";
  },
  (h) => {
    const bigs = h.slice(0, 10).filter((x) => x.n >= 5).length;
    return bigs < 4 ? "BIG" : bigs > 6 ? "SMALL" : h[0].n >= 5 ? "BIG" : "SMALL";
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
      } catch {
      }
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
    } catch {
    }
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
      // IP won't match cert CN — skip verify
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
    req.setTimeout(8e3, () => {
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
        console.log(`\u2705 API OK [${ep.host}] \u2014 latest period: ${items[0].period}`);
        return { items, live: true };
      }
    } catch (e) {
      console.log(`\u26A0\uFE0F  API failed [${ep.host}]: ${e.message}`);
    }
  }
  return { items: [], live: false };
}
function generateFallbackHistory() {
  const now = /* @__PURE__ */ new Date();
  const bd = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Dhaka" }));
  const ymd = `${bd.getFullYear()}${String(bd.getMonth() + 1).padStart(2, "0")}${String(bd.getDate()).padStart(2, "0")}`;
  const minuteOfDay = bd.getHours() * 60 + bd.getMinutes();
  const baseSeq = 1e4 + minuteOfDay;
  const hash = (n) => (n * 2654435761 >>> 0) % 10;
  return Array.from({ length: 20 }, (_, i) => ({
    period: `${ymd}0${String(baseSeq - i).padStart(5, "0")}`,
    n: hash(minuteOfDay - i)
  }));
}
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("\u274C TELEGRAM_BOT_TOKEN missing!");
  process.exit(1);
}
const bot = new TelegramBot(TOKEN, { polling: { interval: 1e3, autoStart: true, params: { timeout: 10 } } });
let cfg = loadConfig();
const adminStates = /* @__PURE__ */ new Map();
const seasonBuildState = /* @__PURE__ */ new Map();
let lastPred = null;
let lastSentPeriod = "";
let signalInterval = null;
function mainMenuKb() {
  return {
    inline_keyboard: [
      [{ text: "\u2699\uFE0F Settings", callback_data: "menu_settings" }, { text: "\u{1F4CA} Status", callback_data: "menu_status" }],
      [{ text: "\u25B6\uFE0F Start Bot", callback_data: "menu_start" }, { text: "\u23F9 Stop Bot", callback_data: "menu_stop" }],
      [{ text: "\u{1F9EA} Test Signal", callback_data: "menu_test" }]
    ]
  };
}
function settingsKb() {
  return {
    inline_keyboard: [
      [{ text: "\u{1F4E2} Set Channel", callback_data: "set_channel" }],
      [{ text: "\u{1F7E2} BIG Image", callback_data: "set_big_image" }, { text: "\u{1F534} SMALL Image", callback_data: "set_small_image" }],
      [{ text: "\u2705 WIN Sticker", callback_data: "set_win_sticker" }, { text: "\u274C LOSS Sticker", callback_data: "set_loss_sticker" }],
      [{ text: "\u{1F4CA} Daily Signals", callback_data: "set_daily_signals" }],
      [{ text: "\u23F0 Set Sessions (4 max)", callback_data: "set_seasons" }],
      [{ text: "\u{1F465} Team Name", callback_data: "set_team_name" }],
      [{ text: "\u{1F519} Back", callback_data: "menu_main" }]
    ]
  };
}
function backKb() {
  return { inline_keyboard: [[{ text: "\u{1F519} Back to Menu", callback_data: "menu_main" }]] };
}
function isAdmin(uid) {
  return cfg.adminIds.length === 0 || cfg.adminIds.includes(uid);
}
function getBDTime() {
  const now = /* @__PURE__ */ new Date();
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
function resetDailyIfNeeded() {
  const { dateStr } = getBDTime();
  if (cfg.lastSignalDate !== dateStr) {
    cfg.signalsSentToday = 0;
    cfg.lastSignalDate = dateStr;
    saveConfig(cfg);
  }
}
function canSendSignal() {
  resetDailyIfNeeded();
  return cfg.isRunning && !!cfg.channelId && isInSession() && cfg.signalsSentToday < cfg.dailySignals;
}
function seasonsText() {
  if (cfg.seasons.length === 0) return "  No restriction (sends anytime)";
  return cfg.seasons.map((s, i) => `  Season ${i + 1}: ${s.start} \u2013 ${s.end}`).join("\n");
}
function statusText() {
  resetDailyIfNeeded();
  const { h, m } = getBDTime();
  const nowStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return `\u{1F4CA} *Bot Status*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F916} Bot: ${cfg.isRunning ? "\u{1F7E2} RUNNING" : "\u{1F534} STOPPED"}
\u{1F4E2} Channel: \`${cfg.channelId || "Not set"}\`
\u{1F465} Team: *${cfg.teamName} AI BOT*

\u23F0 *Sessions (BD Time):*
${seasonsText()}

\u{1F4CD} Now: \`${nowStr}\` BD \u2014 ${isInSession() ? "\u2705 In Session" : "\u23F8 Out of Session"}
\u{1F4CA} Signals Today: ${cfg.signalsSentToday}/${cfg.dailySignals}
\u{1F3AF} Remaining: ${Math.max(0, cfg.dailySignals - cfg.signalsSentToday)}
\u{1F7E2} BIG Image: ${cfg.bigImageFileId ? "\u2705" : "\u274C"} | \u{1F534} SMALL Image: ${cfg.smallImageFileId ? "\u2705" : "\u274C"}
\u2705 Win Sticker: ${cfg.winStickerFileId ? "\u2705" : "\u274C"} | \u274C Loss Sticker: ${cfg.lossStickerFileId ? "\u2705" : "\u274C"}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
}
function confidenceBar(pct) {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return "\u{1F7E9}".repeat(filled) + "\u2B1C".repeat(10 - filled);
}
function predCaption(pred, period, nums, conf) {
  const signalIcon = pred === "BIG" ? "\u{1F7E2} BIG" : "\u{1F534} SMALL";
  const bar = confidenceBar(conf);
  return `\u{1F916} *${cfg.teamName} AI BOT*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F3AE} WIN GO \\- 1 MINUTE
\u{1F4CC} PERIOD:  \`${period}\`
\u{1F3AF} SIGNAL:  *${signalIcon}*
\u{1F48E} JACKPOT:  *${nums.join(" \u2022 ")}*
\u{1F4CA} ${bar}  *${conf}%*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u2705 5 STEPS FOLLOW PROFIT 100%
\u{1F5A5} SERVER: ${cfg.teamName.toUpperCase()} API`;
}
function resultCaption(p) {
  const actualLabel = (p.actual ?? 0) >= 5 ? "BIG" : "SMALL";
  const winText = p.win ? "\u2705 WIN" : "\u274C LOSS";
  const jackpotText = p.jackpot ? "\u2705 YES" : "\u274C NO";
  return `\u{1F480} *PERIOD RESULT*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F4CC} PERIOD RESULT:  \`${p.period}\`
\u{1F3B2} OUTCOME:  *${actualLabel}*  \\(${p.actual}\\)
\u{1F3AF} PREDICTION:  *${p.pred}*
\u{1F4CA} Result:  *${winText}*
\u{1F48E} JACKPOT:  *${jackpotText}*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
}
function sessionSummaryText(history) {
  const total = history.length;
  if (total === 0) return `\u{1F4CA} *SESSION ENDED*

No predictions were made this session.`;
  const wins = history.filter((h) => h.win === true).length;
  const losses = history.filter((h) => h.win === false).length;
  const jackpots = history.filter((h) => h.jackpot === true).length;
  const winPct = Math.round(wins / total * 100);
  const rows = history.slice(-10).map(
    (h, i) => `${i + 1}\\. \`${h.period}\` \u2192 ${h.pred} \u2192 ${h.win === void 0 ? "\u23F3" : h.win ? "\u2705 WIN" : "\u274C LOSS"}${h.jackpot ? " \u{1F48E}" : ""}`
  ).join("\n");
  return `\u{1F534} *SEASON ENDED*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F4CA} *Session Summary*

Total: *${total}* predictions
\u2705 WIN: *${wins}* \\(${winPct}%\\)
\u274C LOSS: *${losses}* \\(${100 - winPct}%\\)
\u{1F48E} JACKPOT: *${jackpots}*

*Last 10 Results:*
${rows}
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
}
async function sendToChannel(text) {
  if (!cfg.channelId) return;
  try {
    await bot.sendMessage(cfg.channelId, text, { parse_mode: "MarkdownV2" });
  } catch (e) {
    console.error("Channel send error:", e.message);
  }
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
    if (!force) {
      cfg.signalsSentToday++;
      saveConfig(cfg);
    }
    console.log(`\u2705 Signal [${period}] \u2192 ${pred} (${conf}%)`);
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
    console.log(`\u{1F4CA} Result [${p.period}] \u2192 ${p.win ? "WIN" : "LOSS"}${p.jackpot ? " \u{1F48E}JACKPOT" : ""}`);
  } catch (e) {
    console.error("Result send error:", e.message);
  }
}
async function signalCycle(force = false) {
  if (!force && !canSendSignal()) return "skipped";
  if (!cfg.channelId) return "no_channel";
  const { items, live } = await fetchWingo();
  const hist = live && items.length > 0 ? items : generateFallbackHistory();
  if (!live) console.log("\u26A0\uFE0F  Using fallback prediction (API unreachable)");
  if (lastPred && !lastPred.resultSent && live) {
    const found = items.find((i) => i.period === lastPred.period);
    if (found) {
      const actualLabel = found.n >= 5 ? "BIG" : "SMALL";
      lastPred.actual = found.n;
      lastPred.win = actualLabel === lastPred.pred;
      lastPred.jackpot = lastPred.nums.includes(found.n);
      lastPred.resultSent = true;
      await sendResult(lastPred);
      cfg.sessionHistory.push({ ...lastPred });
      saveConfig(cfg);
    }
  }
  const latest = hist[0];
  const nextPeriod = (BigInt(latest.period) + 1n).toString();
  if (!force && lastSentPeriod === nextPeriod) return "duplicate";
  const vote = multiVote(hist);
  const nums = jackpotNums(vote.pred, nextPeriod);
  const ok = await sendSignal(vote.pred, nextPeriod, nums, vote.confidence, force);
  if (!ok) return "send_error";
  lastPred = { period: nextPeriod, pred: vote.pred, nums, conf: vote.confidence };
  return "ok";
}
function startSignalLoop() {
  if (signalInterval) return;
  console.log("\u25B6\uFE0F  Signal loop started");
  signalInterval = setInterval(() => {
    signalCycle().catch(console.error);
  }, 6e4);
  signalCycle().catch(console.error);
}
function stopSignalLoop() {
  if (signalInterval) {
    clearInterval(signalInterval);
    signalInterval = null;
  }
}
async function safeAnswer(queryId) {
  try {
    await bot.answerCallbackQuery(queryId);
  } catch {
  }
}
function currentSeasonIndex(state) {
  const map = {
    wait_s1_start: 0,
    wait_s1_end: 0,
    wait_s2_start: 1,
    wait_s2_end: 1,
    wait_s3_start: 2,
    wait_s3_end: 2,
    wait_s4_start: 3,
    wait_s4_end: 3
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
    `\u{1F916} *${cfg.teamName} AI BOT*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
Wingo 1M Prediction Engine

Select an option:`,
    { parse_mode: "Markdown", reply_markup: mainMenuKb() }
  );
});
bot.onText(/\/menu/, async (msg) => {
  adminStates.set(msg.from.id, "idle");
  await bot.sendMessage(msg.chat.id, `\u{1F916} *Main Menu*`, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
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
    await bot.sendMessage(chatId, "\u26D4 Not authorized.");
    return;
  }
  const edit = (text, kb) => {
    const markup = kb ?? backKb();
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: markup }).catch(() => bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup }));
  };
  switch (data) {
    case "menu_main":
      adminStates.set(uid, "idle");
      await edit(`\u{1F916} *${cfg.teamName} AI BOT*
Main Menu`, mainMenuKb());
      break;
    case "menu_settings":
      adminStates.set(uid, "idle");
      await edit(`\u2699\uFE0F *Settings*
Configure your bot:`, settingsKb());
      break;
    case "menu_status":
      await edit(statusText(), { inline_keyboard: [[{ text: "\u{1F519} Back", callback_data: "menu_main" }]] });
      break;
    case "menu_start": {
      cfg.isRunning = true;
      cfg.sessionHistory = [];
      saveConfig(cfg);
      startSignalLoop();
      await sendToChannel(
        `\u{1F7E2} *SEASON STARTED*
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u{1F916} ${cfg.teamName} AI BOT is now LIVE\\!
\u{1F3AE} WIN GO \\- 1 MINUTE signals starting\\.\\.\\.
\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`
      );
      await edit(`\u2705 *Bot Started!*

SEASON STARTED message sent to channel.`, mainMenuKb());
      break;
    }
    case "menu_stop": {
      cfg.isRunning = false;
      saveConfig(cfg);
      stopSignalLoop();
      await sendToChannel(sessionSummaryText(cfg.sessionHistory));
      await edit(`\u23F9 *Bot Stopped!*
SEASON ENDED summary sent to channel.`, mainMenuKb());
      break;
    }
    case "menu_test": {
      await edit(`\u{1F9EA} *Sending test signal...*
Channel: \`${cfg.channelId || "NOT SET"}\``);
      const result = await signalCycle(true);
      const resultMsg = {
        ok: `\u2705 *Test signal sent!*
Channel: \`${cfg.channelId}\``,
        no_channel: `\u274C *Channel not set!*
Settings \u2192 \u{1F4E2} Set Channel`,
        send_error: `\u274C *Send failed!*

Possible reasons:
\u2022 Bot is not Admin in channel
\u2022 Wrong channel username`,
        duplicate: `\u26A0\uFE0F *Same period already sent!*
Wait 1 minute and try again.`
      };
      await bot.sendMessage(chatId, resultMsg[result] ?? `\u274C Error: \`${result}\``, { parse_mode: "Markdown", reply_markup: mainMenuKb() });
      break;
    }
    case "set_channel":
      adminStates.set(uid, "wait_channel");
      await bot.sendMessage(
        chatId,
        `\u{1F4E2} *Set Channel*

Ye kono format e dite paro:
\u2022 \`@mychannel\`
\u2022 \`mychannel\`
\u2022 \`https://t.me/mychannel\`
\u2022 \`-1001234567890\`

\u26A0\uFE0F Bot ke channel-e *Admin* koro age!`,
        { parse_mode: "Markdown" }
      );
      break;
    case "set_big_image":
      adminStates.set(uid, "wait_big_image");
      await bot.sendMessage(chatId, `\u{1F7E2} *BIG Image*

BIG prediction er jonne photo patha:`, { parse_mode: "Markdown" });
      break;
    case "set_small_image":
      adminStates.set(uid, "wait_small_image");
      await bot.sendMessage(chatId, `\u{1F534} *SMALL Image*

SMALL prediction er jonne photo patha:`, { parse_mode: "Markdown" });
      break;
    case "set_win_sticker":
      adminStates.set(uid, "wait_win_sticker");
      await bot.sendMessage(chatId, `\u2705 *WIN Sticker*

Jeta WIN hoyar por pathaite chai sei sticker ta patha:`, { parse_mode: "Markdown" });
      break;
    case "set_loss_sticker":
      adminStates.set(uid, "wait_loss_sticker");
      await bot.sendMessage(chatId, `\u274C *LOSS Sticker*

Jeta LOSS hoyar por pathaite chai sei sticker ta patha:`, { parse_mode: "Markdown" });
      break;
    case "set_daily_signals":
      adminStates.set(uid, "wait_daily_signals");
      await bot.sendMessage(chatId, `\u{1F4CA} *Daily Signals*
Current: *${cfg.dailySignals}*

Send a number (1\u2013200):`, { parse_mode: "Markdown" });
      break;
    case "set_team_name":
      adminStates.set(uid, "wait_team_name");
      await bot.sendMessage(chatId, `\u{1F465} *Team Name*
Current: *${cfg.teamName}*

New name pathao:`, { parse_mode: "Markdown" });
      break;
    case "set_seasons": {
      cfg.seasons = [];
      saveConfig(cfg);
      seasonBuildState.set(uid, []);
      adminStates.set(uid, "wait_s1_start");
      await bot.sendMessage(
        chatId,
        `\u23F0 *Session Setup*
Up to *4 sessions* set korte paro\\.

\u{1F550} *1st Season Start Time* pathao:
Format: \`HH:MM\` \\(BD Time\\)
Example: \`09:00\``,
        { parse_mode: "MarkdownV2" }
      );
      break;
    }
    case "season_skip":
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *Sessions Saved!*

${seasonsText()}`, { parse_mode: "Markdown", reply_markup: settingsKb() });
      break;
  }
});
bot.on("message", async (msg) => {
  const uid = msg.from?.id;
  if (!uid || !isAdmin(uid)) return;
  const chatId = msg.chat.id;
  const state = adminStates.get(uid) ?? "idle";
  if (state === "idle") return;
  if (msg.sticker) {
    const fileId = msg.sticker.file_id;
    if (state === "wait_win_sticker") {
      cfg.winStickerFileId = fileId;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *WIN sticker saved!*`, { parse_mode: "Markdown", reply_markup: settingsKb() });
    } else if (state === "wait_loss_sticker") {
      cfg.lossStickerFileId = fileId;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *LOSS sticker saved!*`, { parse_mode: "Markdown", reply_markup: settingsKb() });
    }
    return;
  }
  if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    if (state === "wait_big_image") {
      cfg.bigImageFileId = fileId;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *BIG image saved!*`, { parse_mode: "Markdown", reply_markup: settingsKb() });
    } else if (state === "wait_small_image") {
      cfg.smallImageFileId = fileId;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *SMALL image saved!*`, { parse_mode: "Markdown", reply_markup: settingsKb() });
    }
    return;
  }
  const text = msg.text?.trim() ?? "";
  if (!text) return;
  if (state.startsWith("wait_s")) {
    const isStart = state.endsWith("_start");
    const seasonIdx = currentSeasonIndex(state);
    if (!/^\d{1,2}:\d{2}$/.test(text)) {
      await bot.sendMessage(chatId, `\u274C Wrong format! Use HH:MM e.g. \`09:00\``, { parse_mode: "Markdown" });
      return;
    }
    const [hh, mm] = text.split(":").map(Number);
    if (hh > 23 || mm > 59) {
      await bot.sendMessage(chatId, `\u274C Invalid time! Hours 0-23, Minutes 0-59`);
      return;
    }
    const timeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    if (isStart) {
      const builds = seasonBuildState.get(uid) ?? [];
      builds[seasonIdx] = { start: timeStr };
      seasonBuildState.set(uid, builds);
      const endState = `wait_s${seasonIdx + 1}_end`;
      adminStates.set(uid, endState);
      await bot.sendMessage(chatId, `\u2705 ${ordinal(seasonIdx)} Season Start: *${timeStr}*

Now send *End Time*:`, { parse_mode: "Markdown" });
    } else {
      const builds = seasonBuildState.get(uid) ?? [];
      const season = builds[seasonIdx] ?? {};
      const [sh, sm] = (season.start ?? "00:00").split(":").map(Number);
      if (hh * 60 + mm <= sh * 60 + sm) {
        await bot.sendMessage(chatId, `\u274C End time must be after start time (${season.start})!`);
        return;
      }
      season.end = timeStr;
      cfg.seasons.push({ start: season.start, end: timeStr });
      saveConfig(cfg);
      const nextIdx = seasonIdx + 1;
      const built = cfg.seasons.map((s, i) => `  Season ${i + 1}: ${s.start} \u2013 ${s.end}`).join("\n");
      if (nextIdx < 4) {
        const nextStartState = `wait_s${nextIdx + 1}_start`;
        adminStates.set(uid, nextStartState);
        await bot.sendMessage(
          chatId,
          `\u2705 *${ordinal(seasonIdx)} Season saved!*
${built}

\u{1F550} Send *${ordinal(nextIdx)} Season Start Time* or tap Done:`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: `\u2705 Done (${nextIdx} season${nextIdx > 1 ? "s" : ""} saved)`, callback_data: "season_skip" }]] }
          }
        );
      } else {
        adminStates.set(uid, "idle");
        await bot.sendMessage(chatId, `\u2705 *All 4 Sessions saved!*

${built}`, { parse_mode: "Markdown", reply_markup: settingsKb() });
      }
    }
    return;
  }
  switch (state) {
    case "wait_channel": {
      let channelId = text.trim();
      const tmeMatch = channelId.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/i);
      if (tmeMatch) channelId = `@${tmeMatch[1]}`;
      else if (!channelId.startsWith("-") && !channelId.startsWith("@")) channelId = `@${channelId}`;
      cfg.channelId = channelId;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *Channel set:* \`${cfg.channelId}\`

\u{1F9EA} Test korte Test Signal chapa!`, { parse_mode: "Markdown", reply_markup: settingsKb() });
      break;
    }
    case "wait_daily_signals": {
      const n = parseInt(text);
      if (isNaN(n) || n < 1 || n > 200) {
        await bot.sendMessage(chatId, `\u274C Enter 1\u2013200.`);
        return;
      }
      cfg.dailySignals = n;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 *Daily signals: ${n}*`, { parse_mode: "Markdown", reply_markup: settingsKb() });
      break;
    }
    case "wait_team_name": {
      if (text.length < 2 || text.length > 30) {
        await bot.sendMessage(chatId, `\u274C Name must be 2\u201330 chars.`);
        return;
      }
      cfg.teamName = text;
      saveConfig(cfg);
      adminStates.set(uid, "idle");
      await bot.sendMessage(chatId, `\u2705 Team: *${text} AI BOT*`, { parse_mode: "Markdown", reply_markup: settingsKb() });
      break;
    }
  }
});
bot.on("polling_error", (err) => {
  const msg = err.message ?? "";
  if (msg.includes("ETELEGRAM") && msg.includes("timeout")) return;
  if (msg.includes("query is too old")) return;
  console.error("Polling error:", msg);
});
process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  if (msg.includes("query is too old") || msg.includes("ETELEGRAM")) return;
  console.error("Unhandled rejection:", reason);
});
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const healthServer = http.createServer((req, res) => {
  const uptime = Math.floor(process.uptime());
  const { h, m, dateStr } = getBDTime();
  const nowStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const body = JSON.stringify({
    status: "ok",
    bot: cfg.teamName + " AI BOT",
    running: cfg.isRunning,
    channel: cfg.channelId || "not set",
    uptime_seconds: uptime,
    bd_time: nowStr,
    date: dateStr,
    signals_today: cfg.signalsSentToday,
    daily_limit: cfg.dailySignals,
    in_session: isInSession(),
    last_period: lastSentPeriod || "none"
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
});
healthServer.listen(PORT, () => {
  console.log(`\u{1F310} Health server running on port ${PORT}`);
});
console.log("\u{1F916} DeSh Club Wingo Bot starting...");
cfg = loadConfig();
if (cfg.isRunning) {
  console.log("\u25B6\uFE0F  Auto-resuming signal loop...");
  startSignalLoop();
}
console.log("\u2705 Bot polling for messages...");
