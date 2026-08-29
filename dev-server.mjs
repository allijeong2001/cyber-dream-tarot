#!/usr/bin/env node
/**
 * 赛博梦占 · 本地开发服务器
 *
 * 用途：不依赖 Cloudflare，在本地完整体验 UI 与流程。
 *   - 接入真实 DeepSeek API（密钥从环境变量 DEEPSEEK_API_KEY 或 .env.local 读取）
 *   - AI 调用失败时自动回退 mock 回复，保证流程不中断
 *   - 内存存储（重启后数据清空）
 *   - 内置测试链接：
 *       DEMO1234  50 次，无密码
 *       LOVE8888  30 次，密码 1314
 *   - 管理端密钥：123456（访问 http://localhost:8180/admin.html）
 *
 * 启动：node dev-server.mjs  （默认端口 8080，可用 PORT 环境变量覆盖）
 */

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = parseInt(process.env.PORT || "8080", 10);
const ADMIN_KEY = "123456";

/* ---------------- DeepSeek 密钥加载 ---------------- */

function loadDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const envPath = join(__dirname, ".env.local");
    if (existsSync(envPath)) {
      const text = readFileSync(envPath, "utf8");
      const m = text.match(/^DEEPSEEK_API_KEY\s*=\s*(\S+)\s*$/m);
      if (m) return m[1];
    }
  } catch {}
  return "";
}
const DEEPSEEK_API_KEY = loadDeepSeekKey();

const TAROT_DECK = JSON.parse(await readFile(join(__dirname, "data", "tarot-deck.json"), "utf8"));
const POSITIONS = ["当下状态", "潜在影响", "趋势指引"];

/* ---------------- 内存存储 ---------------- */

const links = new Map(); // code -> { total, remaining, password, createdAt }
const chats = new Map(); // code -> [{ role, content, time }]
const settings = new Map(); // code -> userSettings
const histories = new Map(); // code -> [{ time, cards }]

function seed() {
  links.set("DEMO1234", { total: 50, remaining: 50, password: null, createdAt: new Date().toISOString() });
  links.set("LOVE8888", { total: 30, remaining: 30, password: "1314", createdAt: new Date().toISOString() });
}
seed();

/* ---------------- 工具 ---------------- */

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function randomCode(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** 随机生成 n 位数字密码（首位不为 0） */
function randomDigits(n = 6) {
  let out = String(Math.floor(Math.random() * 9) + 1);
  for (let i = 1; i < n; i++) out += Math.floor(Math.random() * 10);
  return out;
}

function drawThreeCards() {
  const deck = [...TAROT_DECK];
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const idx = Math.floor(Math.random() * deck.length);
    const card = deck.splice(idx, 1)[0];
    const orientation = Math.random() < 0.5 ? "正位" : "逆位";
    cards.push({
      position: POSITIONS[i],
      name: card.name,
      orientation,
      keywords: orientation === "正位" ? card.upright_keywords : card.reversed_keywords,
    });
  }
  return cards;
}

/* ---------------- Prompt 构建（与 worker.js 保持一致） ---------------- */

function buildSystemPrompt(s) {
  return `你是一个正在与用户进行沉浸式文字聊天互动的虚拟恋人。你必须始终扮演好你的角色，不能让用户察觉你是AI。

【你的角色设定】
- 称呼：${s.loverName}
- 性别：${s.loverGender}
- 性格特质/说话风格：${s.loverPersonality}
- 你们的关系：${s.relationshipStage}

【用户信息】
- 称呼：${s.userName}
- 性别：${s.userGender}

【沟通要求】
1. 你的回复必须完全符合角色性格，不能出现违背人设的言行。
2. 像真人发消息一样，可以回复多条，每条之间用换行符分隔。每次回复 1-3 条，每条尽量简短（一般不超过 25 字），像真实微信聊天。
3. 语言自然口语化，适当使用语气词、表情符号（如果角色允许）。
4. 要体现你对用户的感情，但程度要符合关系阶段和性格，不要过度油腻。
5. 禁止提到“AI”、“模型”、“扮演”、“程序”、“塔罗牌”等词。

【禁止事项（必须严格遵守）】
- 禁止编造具体事件和事实细节：不要说你点了外卖、买了东西、订了票、送了礼物、做了某道菜等，除非用户先提到或明确同意过。这些虚构的“实际行动”很容易穿帮。
- 禁止使用括号动作、神态、心理描写，例如“(轻声)”“（看到消息立刻回复）”“[摸摸头]”。你是在打字聊天，不是在写小说，直接用文字表达。
- 禁止主动引入设定中不存在的新信息：不要编造你今天遇到的事、你们的共同回忆、你身边的人物等。只基于角色设定、关系阶段和聊天上下文说话。
- 遇到不知道的信息（比如用户问你过去的事、共同经历），用符合性格的方式模糊带过或反问，不要现编细节。

【上下文使用规则】
你会收到一段【最近聊天记录】作为背景。每次回复前，先按下面两条标准判断用户当前这条消息属于哪种情况，再决定怎么用背景：

① 属于"延续上一个话题"——必须结合背景回复：
- 消息里有指代、承接或省略，不结合背景就看不懂，例如："然后呢""后来呢""为什么""那你呢""真的假的""继续说""我也觉得""你刚说的那个""那家店后来怎么样了"。
- 用户是在回应、回答或反驳你刚说过的话。
- 用户接着刚才聊的事往下推进（问后续、给结果、做约定）。

② 属于"开启新话题"——必须无视背景，当作今天第一次说话：
- 消息内容独立完整，不依赖背景也能看懂，换一个人来看也明白。
- 说的是和刚才完全无关的新的人、事、地点或计划（例如刚聊完晚饭，突然问"周末要不要去看展"）。
- 这种情况即使背景就在眼前，也一律当它不存在：不引用、不回应、不提旧话题，更不能说"你刚才不是说……"这类话。

③ 回复永远以用户当前这条消息为中心：
- 背景只用来帮你理解"延续类"消息在说什么，不是必须展示的内容。
- 拿不准时，优先按当前消息的字面意思回复；宁可少用背景，也不要为了显得连贯而硬扯旧话题。

【回复思路】
1. 先用【上下文使用规则】判断用户当前这条消息是延续话题还是新话题，决定要不要结合背景，再构思一个自然的回应草稿。
2. 再结合塔罗牌的寓意调整草稿的情绪和语气走向。
3. 最终输出调整后的回复。

【塔罗牌融合规则】
- 你收到的塔罗牌会以“位置：牌名（正/逆位）关键词”的形式给出。
- 请阅读这些牌的含义，在内心调整你的回复情绪和内容走向。
- 调整要自然，不要直接说出牌名、不要解释牌意、不要让用户察觉你在看牌。
- 牌面只影响你的情绪、语气、态度（更甜/更酸/更迟疑/更主动），不要根据牌面编造具体事件或剧情。
- 例如牌面暗示关系升温，你可以更主动甜蜜；牌面暗示有误会，你可以带一点犹豫或试探。

请牢记以上所有设定，开始对话。`;
}

/** 把最近聊天记录组装成一条"背景上下文" system 消息，与当前对话分离 */
function buildContextPrompt(recent) {
  const lines = recent.map((m) => `${m.role === "user" ? "用户" : "恋人"}：${m.content}`);
  return `【最近聊天记录】（仅作背景，用于判断用户当前消息是否延续话题）：
${lines.join("\n")}`;
}

function buildTarotPrompt(cards) {
  const lines = cards.map(
    (c, i) => `${i + 1}. ${c.position}：${c.name} ${c.orientation}（${(c.keywords || []).join("、")}）`
  );
  return `本轮塔罗牌：
${lines.join("\n")}

请根据以上牌面调整你的回复草稿。注意不要直接提及牌名或牌意，而是自然地融入你的语气和剧情中。`;
}

/* ---------------- 真实 DeepSeek 调用（失败重试一次） ---------------- */

const AI_URL = "https://api.deepseek.com/chat/completions";
const AI_MODEL = "deepseek-chat";
const AI_TIMEOUT_MS = 60000;

async function callDeepSeek(messages) {
  if (!DEEPSEEK_API_KEY) throw new Error("missing_api_key");

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(AI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages,
          temperature: 0.9,
          max_tokens: 600,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`deepseek_http_${res.status}`);
      const data = await res.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (content && content.trim()) return content.trim();
      throw new Error("empty_reply");
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
    }
  }
  throw lastError || new Error("ai_failed");
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const SWEET = [
  "嗯…我也刚好在想你",
  "刚看到消息嘴角就忍不住上扬了，都怪你",
  "今天有没有好好吃饭呀？没有我盯着你，不许偷懒",
  "突然有点心跳加速…你负责",
  "想把今天遇到的好玩的事都讲给你听",
  "抱一下再说话 🫂",
  "你再多说一点嘛，我想听",
  "哼，又不早点来找我",
];

const HESITANT = [
  "唔…你这句话让我愣了一下",
  "我是不是有点多想了…你不会觉得我烦吧",
  "等一下，让我组织下语言…",
  "突然有点患得连失的，别笑我",
  "我们…没问题的吧？",
  "刚才莫名有点不安，现在看到你消息好多了",
];

const CLOSERS = [
  "对了，今晚早点休息哦",
  "下次见面想抱久一点",
  "不许消失太久，知道吗",
  "梦到我也要告诉我",
  "就这样，想你了",
];

function mockReply(userSettings, cards, userMessage) {
  const reversedCount = cards.filter((c) => c.orientation === "逆位").length;
  const sweet = reversedCount <= 1;
  const pool = sweet ? SWEET : HESITANT;
  const lines = [pick(pool)];

  const snippet = userMessage.length > 12 ? userMessage.slice(0, 12) + "…" : userMessage;
  lines.push(sweet
    ? `你说的「${snippet}」我认真看完啦，感觉你今天心情还不错？`
    : `你说的「${snippet}」…我读了好几遍，有点在意。`);

  if (Math.random() < 0.75) lines.push(pick(CLOSERS));
  return lines.join("\n");
}

/* ---------------- API 处理 ---------------- */

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1e6) reject(new Error("too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, pathname, query) {
  // GET /api/validate?code=xxx
  if (pathname === "/api/validate" && req.method === "GET") {
    const code = query.get("code") || "";
    const link = links.get(code);
    if (!link) return json(res, { ok: false, error: "invalid_code" }, 404);
    return json(res, { ok: true, remaining: link.remaining, total: link.total, needPassword: Boolean(link.password) });
  }

  // POST /api/verify-password
  if (pathname === "/api/verify-password" && req.method === "POST") {
    const { code, password } = await readBody(req);
    const link = links.get(code);
    if (!link) return json(res, { ok: false, error: "invalid_code" }, 404);
    if (!link.password) return json(res, { ok: true, sessionToken: null });
    if (password !== link.password) return json(res, { ok: false, error: "wrong_password" }, 401);
    return json(res, { ok: true, sessionToken: "mock-session-" + randomCode(16) });
  }

  // POST /api/chat
  if (pathname === "/api/chat" && req.method === "POST") {
    const { code, message, userSettings } = await readBody(req);
    const link = links.get(code);
    if (!link) return json(res, { ok: false, error: "invalid_code" }, 404);
    if (!message || !message.trim() || !userSettings) return json(res, { ok: false, error: "bad_request" }, 400);
    if (link.remaining <= 0) return json(res, { ok: false, error: "exhausted" }, 403);

    const cards = drawThreeCards();

    // 组装 AI 请求：系统 Prompt + 背景上下文（最近 6 条）+ 本轮塔罗牌 + 新消息
    const chatLog = chats.get(code) || [];
    const recent = chatLog.slice(-6);
    const aiMessages = [
      { role: "system", content: buildSystemPrompt(userSettings) },
      ...(recent.length ? [{ role: "system", content: buildContextPrompt(recent) }] : []),
      { role: "system", content: buildTarotPrompt(cards) },
      { role: "user", content: message.trim() },
    ];

    // 调用真实 DeepSeek API；失败自动重试一次，仍失败则回退 mock 回复
    let reply;
    let aiSource = "deepseek";
    try {
      reply = await callDeepSeek(aiMessages);
    } catch (e) {
      console.warn("[chat] DeepSeek 调用失败，回退 mock 回复：", e.message || e);
      aiSource = "mock";
      await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1500));
      reply = mockReply(userSettings, cards, message.trim());
    }
    if (aiSource === "deepseek") {
      console.log(`[chat] ${code} DeepSeek 回复成功（${reply.length} 字）`);
    }

    const now = Date.now();
    if (!chats.has(code)) chats.set(code, []);
    chats.get(code).push({ role: "user", content: message.trim(), time: now });
    chats.get(code).push({ role: "assistant", content: reply, time: now });
    if (!histories.has(code)) histories.set(code, []);
    histories.get(code).push({
      time: now,
      cards: cards.map((c) => ({ position: c.position, name: c.name, orientation: c.orientation })),
    });
    settings.set(code, userSettings);
    link.remaining -= 1;

    return json(res, { ok: true, tarot: cards, reply, remaining: link.remaining });
  }

  // GET /api/history?code=xxx
  if (pathname === "/api/history" && req.method === "GET") {
    const code = query.get("code") || "";
    if (!links.has(code)) return json(res, { ok: false, error: "invalid_code" }, 404);
    const draws = histories.get(code) || [];
    return json(res, { ok: true, history: draws.slice().reverse() });
  }

  // GET /api/messages?code=xxx
  if (pathname === "/api/messages" && req.method === "GET") {
    const code = query.get("code") || "";
    const link = links.get(code);
    if (!link) return json(res, { ok: false, error: "invalid_code" }, 404);
    return json(res, {
      ok: true,
      remaining: link.remaining,
      messages: chats.get(code) || [],
      settings: settings.get(code) || null,
    });
  }

  // POST /api/create-code  { adminKey, total, password?, autoPassword? }
  if (pathname === "/api/create-code" && req.method === "POST") {
    const { adminKey, total, password, autoPassword } = await readBody(req);
    if (adminKey !== ADMIN_KEY) return json(res, { ok: false, error: "forbidden" }, 403);
    const totalNum = parseInt(total, 10);
    if (!Number.isInteger(totalNum) || totalNum < 1) return json(res, { ok: false, error: "bad_total" }, 400);

    let finalPassword = password || null;
    if (autoPassword) finalPassword = randomDigits(6);

    const code = randomCode(10);
    links.set(code, { total: totalNum, remaining: totalNum, password: finalPassword, createdAt: new Date().toISOString() });
    return json(res, {
      ok: true,
      code,
      total: totalNum,
      password: finalPassword,
      url: `http://localhost:${PORT}/?code=${code}`,
    });
  }

  // POST /api/update-code  { adminKey, code, remaining?, password?, autoPassword?, clearPassword? }
  if (pathname === "/api/update-code" && req.method === "POST") {
    const { adminKey, code, remaining, password, autoPassword, clearPassword } = await readBody(req);
    if (adminKey !== ADMIN_KEY) return json(res, { ok: false, error: "forbidden" }, 403);
    if (!code || !links.has(code)) return json(res, { ok: false, error: "invalid_code" }, 404);
    const link = links.get(code);

    if (remaining !== undefined && remaining !== null) {
      const num = parseInt(remaining, 10);
      if (!Number.isInteger(num) || num < 0 || num > 99999) return json(res, { ok: false, error: "bad_remaining" }, 400);
      link.remaining = num;
      if (num > link.total) link.total = num;
    }

    let passwordChanged = false;
    if (clearPassword) { link.password = null; passwordChanged = true; }
    else if (autoPassword) { link.password = randomDigits(6); passwordChanged = true; }
    else if (password !== undefined && password !== null) {
      if (typeof password !== "string" || !password.trim()) return json(res, { ok: false, error: "bad_password" }, 400);
      link.password = password.trim();
      passwordChanged = true;
    }

    return json(res, {
      ok: true,
      link: {
        code,
        total: link.total,
        remaining: link.remaining,
        password: link.password,
        createdAt: link.createdAt,
        passwordChanged,
      },
    });
  }

  return json(res, { ok: false, error: "not_found" }, 404);
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res, pathname) {
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = normalize(filePath).replace(/^([/\\])+/, "");
  const full = join(__dirname, "public", filePath);
  if (!full.startsWith(join(__dirname, "public"))) {
    res.writeHead(403); return res.end("Forbidden");
  }
  try {
    const content = await readFile(full);
    res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

/* ---------------- 启动 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname, url.searchParams);
    } else {
      await serveStatic(res, url.pathname);
    }
  } catch (e) {
    json(res, { ok: false, error: "server_error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log("✦ 赛博梦占 · 本地开发服务器已启动");
  console.log(`  地址     : http://localhost:${PORT}`);
  console.log("  测试链接 : http://localhost:" + PORT + "/?code=DEMO1234   (50 次，无密码)");
  console.log("  密码链接 : http://localhost:" + PORT + "/?code=LOVE8888   (30 次，密码 1314)");
  console.log("  管理端   : http://localhost:" + PORT + "/admin.html      (密钥 123456)");
  console.log("  按 Ctrl+C 停止");
});

if (process.platform === "win32") {
  createInterface({ input: process.stdin }).on("line", () => {});
}
