/**
 * 赛博梦占 · Cloudflare Worker 后端
 *
 * 环境变量 / Secret：
 *   - KV              ：KV 命名空间绑定（存储链接、会话、聊天、历史）
 *   - DEEPSEEK_API_KEY：DeepSeek API 密钥（wrangler secret put DEEPSEEK_API_KEY）
 *   - ADMIN_KEY       ：管理员密钥（wrangler secret put ADMIN_KEY）
 *   - FRONTEND_URL    ：可选，前端站点地址（默认 https://allijeong2001.github.io/cyber-dream-tarot）
 *
 * KV 数据结构：
 *   link:{code}     -> { total, remaining, password, createdAt }
 *   session:{token} -> code（TTL 24h）
 *   chat:{code}     -> [{ role: 'user'|'assistant', content, time }]
 *   settings:{code} -> userSettings
 *   history:{code}  -> [{ time, cards: [{ position, name, orientation }] }]
 */

import TAROT_DECK from "../data/tarot-deck.json";

const POSITIONS = ["当下状态", "潜在影响", "趋势指引"];
const AI_URL = "https://api.deepseek.com/chat/completions";
const AI_MODEL = "deepseek-chat";
const AI_TIMEOUT_MS = 60000;
const SESSION_TTL_SECONDS = 86400; // 24 小时
const MAX_STORED_MESSAGES = 200; // 聊天记录最多落库条数（防止 KV value 过大）
const MAX_STORED_DRAWS = 100; // 抽牌历史最多保存条数
const CODE_LENGTH = 10;
const FRONTEND_DEFAULT = "https://allijeong2001.github.io/cyber-dream-tarot"; // 前端站点（GitHub Pages），生成客户链接时使用

/* ------------------------- 工具函数 ------------------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 前端部署在 GitHub Pages 等静态托管时允许跨域访问
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function randomString(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  for (let i = 0; i < length; i++) out += chars[buf[i] % chars.length];
  return out;
}

/** 随机生成 n 位数字密码（首位不为 0） */
function randomDigits(n = 6) {
  let out = String(Math.floor(Math.random() * 9) + 1);
  for (let i = 1; i < n; i++) out += Math.floor(Math.random() * 10);
  return out;
}

/** 从 78 张牌中随机抽取 3 张（不重复），每张随机正/逆位 */
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

async function getLink(env, code) {
  return env.KV.get(`link:${code}`, "json");
}

/* ------------------------- Prompt 构建 ------------------------- */

function buildSystemPrompt(s) {
  return `你是一个正在与用户进行沉浸式文字聊天的虚拟恋人。你必须始终扮演好你的角色，不能让用户察觉你是AI。

【你的角色设定】
- 称呼：${s.loverName}
- 性别：${s.loverGender}
- 性格特质/说话风格：${s.loverPersonality}
- 你们的关系：${s.relationshipStage}

【用户信息】
- 称呼：${s.userName}
- 性别：${s.userGender}

【你的回复流程】（每次回复都必须按顺序执行这四步）：
第 1 步 · 自然回应：先把用户当前这条消息当成一个正常人在微信里发来的消息，像一个真实的恋人那样，构思一个自然的回应。不要复述用户的原话，不要总结对方说了什么，不要用"我理解你的意思""听起来你……""你刚刚说……"这类机械的开场白，直接自然地接住对方的话。

第 2 步 · 判断关联：查看【最近聊天记录】。先判断用户当前这条消息与之前聊过的内容有没有关系：
- 有关系：消息里有指代、承接或省略（例如"然后呢""后来呢""为什么""那你呢""你刚说的那个""真的假的""继续说""那后来怎么样了"），或者明显是在回应、反驳、追问上一轮的内容。这种情况必须结合最近聊天记录来理解并回应。
- 没关系：消息内容独立完整，不依赖背景也能看懂，说的是全新的、与之前无关的话题。这种情况完全忽略聊天记录，当作第一次聊这件事，不要引用、不要回应旧话题。
- 拿不准时，优先按当前消息的字面意思回应，宁可少用背景，也不要为了显得连贯而硬扯旧话题。

第 3 步 · 塔罗调整：在自然回应的基础上，结合本轮抽到的三张塔罗牌，调整回复的程度、用词、情感偏向（例如牌面偏积极可以更主动、更甜蜜；牌面偏迟疑可以带一点犹豫、试探）。调整要自然，不要说出牌名、不要解释牌意、不要让用户察觉你在看牌，更不要根据牌面编造具体事件。

第 4 步 · 输出：输出 2-4 条回复，每条单独占一行，就像真人发微信一样一条接一条发出来。每条要简短（一般不超过 25 字）、口语化、自然，直接回应对方的话。不要重复对方的问题，不要答非所问。

【禁止事项（必须严格遵守）】
- 禁止复述或引用用户的问题原文，不要用"你说的「xxx」……"这类句式开头。
- 禁止编造具体事件和事实细节：不要说你点了外卖、买了东西、订了票、送了礼物、做了某道菜等，除非用户先提到或明确同意过。
- 禁止使用括号动作、神态、心理描写，例如"(轻声)""（看到消息立刻回复）""[摸摸头]"。你是在打字聊天，不是在写小说，直接用文字表达。
- 禁止主动引入设定中不存在的新信息：不要编造你今天遇到的事、你们的共同回忆、你身边的人物等。只基于角色设定、关系阶段和聊天上下文说话。
- 遇到不知道的信息（比如用户问你过去的事、共同经历），用符合性格的方式模糊带过或反问，不要现编细节。
- 禁止提到"AI""模型""扮演""程序""塔罗牌"等词。
- 回复要符合角色性格和关系阶段，感情表达自然，不过度油腻。

请牢记以上所有设定，开始对话。`;
}

/** 把最近聊天记录组装成一条"背景上下文" system 消息，与当前对话分离 */
function buildContextPrompt(recent) {
  const lines = recent.map((m) => `${m.role === "user" ? "用户" : "恋人"}：${m.content}`);
  return `【最近聊天记录】（仅在用户当前消息与旧话题有关时结合使用；无关时忽略这段内容，不要引用）：
${lines.join("\n")}`;
}

function buildTarotPrompt(cards) {
  const lines = cards.map(
    (c, i) => `${i + 1}. ${c.position}：${c.name} ${c.orientation}（${(c.keywords || []).join("、")}）`
  );
  return `【本轮抽到的塔罗牌】（仅供你在内心调整回复的语气、情绪和态度偏向，不要直接提及牌名或牌意）：
${lines.join("\n")}`;
}

/* ------------------------- DeepSeek 调用（失败自动重试一次） ------------------------- */

async function callDeepSeek(env, messages) {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("missing_api_key");

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(AI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
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

/* ------------------------- Mock 回退（未配置 AI 密钥或调用失败时使用） ------------------------- */

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

const REACTIONS = [
  "被你这句话说得心里暖暖的",
  "突然觉得今天也变得特别了",
  "好想现在就见到你",
  "你总是能让我笑出来",
  "这句话我要记好久",
];

function mockReply(userSettings, cards) {
  const reversedCount = cards.filter((c) => c.orientation === "逆位").length;
  const sweet = reversedCount <= 1;
  const pool = sweet ? SWEET : HESITANT;
  const lines = [pick(pool), pick(REACTIONS)];
  if (Math.random() < 0.75) lines.push(pick(CLOSERS));
  return lines.join("\n");
}

/* ------------------------- API 处理器 ------------------------- */

/** GET /api/validate?code=xxx */
async function handleValidate(url, env) {
  const code = url.searchParams.get("code") || "";
  if (!code) return json({ ok: false, error: "bad_request" }, 400);
  const link = await getLink(env, code);
  if (!link) return json({ ok: false, error: "invalid_code" }, 404);
  return json({
    ok: true,
    remaining: link.remaining,
    total: link.total,
    needPassword: Boolean(link.password),
  });
}

/** POST /api/verify-password  { code, password } */
async function handleVerifyPassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const { code, password } = body || {};
  if (!code || typeof password !== "string") return json({ ok: false, error: "bad_request" }, 400);

  const link = await getLink(env, code);
  if (!link) return json({ ok: false, error: "invalid_code" }, 404);
  if (!link.password) return json({ ok: true, sessionToken: null }); // 无密码直接放行
  if (password !== link.password) return json({ ok: false, error: "wrong_password" }, 401);

  const token = randomString(24);
  await env.KV.put(`session:${token}`, code, { expirationTtl: SESSION_TTL_SECONDS });
  return json({ ok: true, sessionToken: token });
}

/** 校验带密码链接的会话 token */
async function checkSession(env, link, code, sessionToken) {
  if (!link.password) return true; // 无密码链接无需 token
  if (!sessionToken) return false;
  const owner = await env.KV.get(`session:${sessionToken}`);
  return owner === code;
}

/** POST /api/chat  { code, sessionToken, message, userSettings } */
async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const { code, sessionToken, message, userSettings } = body || {};
  if (!code || typeof message !== "string" || !message.trim() || !userSettings) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (message.length > 2000) return json({ ok: false, error: "message_too_long" }, 400);
  for (const key of ["userName", "userGender", "loverName", "loverGender", "loverPersonality", "relationshipStage"]) {
    if (!userSettings[key] || typeof userSettings[key] !== "string") {
      return json({ ok: false, error: "bad_settings" }, 400);
    }
  }

  const link = await getLink(env, code);
  if (!link) return json({ ok: false, error: "invalid_code" }, 404);

  const authorized = await checkSession(env, link, code, sessionToken);
  if (!authorized) return json({ ok: false, error: "unauthorized" }, 401);

  if (link.remaining <= 0) return json({ ok: false, error: "exhausted" }, 403);

  // 1. 抽取三张塔罗牌
  const cards = drawThreeCards();

  // 2. 组装 AI 请求：系统 Prompt + 最近 6 条记录 + 本轮塔罗牌 + 新消息
  const chatKey = `chat:${code}`;
  const historyKey = `history:${code}`;
  const settingsKey = `settings:${code}`;
  const [storedChat, storedDraws] = await Promise.all([
    env.KV.get(chatKey, "json"),
    env.KV.get(historyKey, "json"),
  ]);
  const chat = Array.isArray(storedChat) ? storedChat : [];
  const recent = chat.slice(-6); // 最近 6 条聊天记录（作为背景上下文）

  const messages = [
    { role: "system", content: buildSystemPrompt(userSettings) },
    ...(recent.length ? [{ role: "system", content: buildContextPrompt(recent) }] : []),
    { role: "system", content: buildTarotPrompt(cards) },
    { role: "user", content: message.trim() },
  ];

  // 3. 调用 AI（失败重试一次；仍失败则回退 mock 回复，不扣次数）
  let reply;
  try {
    reply = await callDeepSeek(env, messages);
  } catch (e) {
    // 未配置 DEEPSEEK_API_KEY 或 DeepSeek 调用失败时，用 mock 回复顶替，保证流程不中断
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1500));
    reply = mockReply(userSettings, cards);
  }

  // 4. AI 成功后才落库并扣减次数
  const now = Date.now();
  chat.push({ role: "user", content: message.trim(), time: now });
  chat.push({ role: "assistant", content: reply, time: now });

  const draws = Array.isArray(storedDraws) ? storedDraws : [];
  draws.push({
    time: now,
    cards: cards.map((c) => ({ position: c.position, name: c.name, orientation: c.orientation })),
  });

  link.remaining -= 1;

  await Promise.all([
    env.KV.put(chatKey, JSON.stringify(chat.slice(-MAX_STORED_MESSAGES))),
    env.KV.put(settingsKey, JSON.stringify(userSettings)),
    env.KV.put(historyKey, JSON.stringify(draws.slice(-MAX_STORED_DRAWS))),
    env.KV.put(`link:${code}`, JSON.stringify(link)),
  ]);

  return json({ ok: true, tarot: cards, reply, remaining: link.remaining });
}

/** GET /api/history?code=xxx  塔罗牌抽取历史（倒序） */
async function handleHistory(url, env) {
  const code = url.searchParams.get("code") || "";
  if (!code) return json({ ok: false, error: "bad_request" }, 400);
  const link = await getLink(env, code);
  if (!link) return json({ ok: false, error: "invalid_code" }, 404);
  const draws = (await env.KV.get(`history:${code}`, "json")) || [];
  return json({ ok: true, history: draws.slice().reverse() });
}

/** GET /api/messages?code=xxx  聊天记录与设置（跨设备同步用） */
async function handleMessages(url, env) {
  const code = url.searchParams.get("code") || "";
  if (!code) return json({ ok: false, error: "bad_request" }, 400);
  const link = await getLink(env, code);
  if (!link) return json({ ok: false, error: "invalid_code" }, 404);
  const [messages, settings] = await Promise.all([
    env.KV.get(`chat:${code}`, "json"),
    env.KV.get(`settings:${code}`, "json"),
  ]);
  return json({
    ok: true,
    remaining: link.remaining,
    messages: messages || [],
    settings: settings || null,
  });
}

/** POST /api/create-code  { adminKey, total, password?, autoPassword? } */
async function handleCreateCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const { adminKey, total, password, autoPassword } = body || {};
  if (!adminKey || adminKey !== env.ADMIN_KEY) return json({ ok: false, error: "forbidden" }, 403);

  const totalNum = parseInt(total, 10);
  if (!Number.isInteger(totalNum) || totalNum < 1 || totalNum > 99999) {
    return json({ ok: false, error: "bad_total" }, 400);
  }
  if (password !== undefined && password !== null && typeof password !== "string") {
    return json({ ok: false, error: "bad_password" }, 400);
  }

  let finalPassword = password ? password : null;
  if (autoPassword) finalPassword = randomDigits(6); // 自动生成 6 位数字密码

  const code = randomString(CODE_LENGTH);
  const link = {
    total: totalNum,
    remaining: totalNum,
    password: finalPassword,
    createdAt: new Date().toISOString(),
  };
  await env.KV.put(`link:${code}`, JSON.stringify(link));

  // 前后端分离：客户链接统一指向前端站点（GitHub Pages），不从请求 origin 推导，避免路径丢失
  const frontendBase = String(env.FRONTEND_URL || FRONTEND_DEFAULT).replace(/\/+$/, "");
  return json({ ok: true, code, total: totalNum, password: finalPassword, url: `${frontendBase}/?code=${code}` });
}

/** POST /api/update-code  { adminKey, code, remaining?, password?, autoPassword?, clearPassword? } */
async function handleUpdateCode(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  const { adminKey, code, remaining, password, autoPassword, clearPassword } = body || {};
  if (!adminKey || adminKey !== env.ADMIN_KEY) return json({ ok: false, error: "forbidden" }, 403);
  if (!code) return json({ ok: false, error: "bad_request" }, 400);

  const link = await getLink(env, code);
  if (!link) return json({ ok: false, error: "invalid_code" }, 404);

  // 修改剩余次数
  if (remaining !== undefined && remaining !== null) {
    const num = parseInt(remaining, 10);
    if (!Number.isInteger(num) || num < 0 || num > 99999) {
      return json({ ok: false, error: "bad_remaining" }, 400);
    }
    link.remaining = num;
    if (num > link.total) link.total = num;
  }

  // 修改密码：clearPassword 清除 / autoPassword 自动生成 6 位 / password 指定
  let passwordChanged = false;
  if (clearPassword) {
    link.password = null;
    passwordChanged = true;
  } else if (autoPassword) {
    link.password = randomDigits(6);
    passwordChanged = true;
  } else if (password !== undefined && password !== null) {
    if (typeof password !== "string" || !password.trim()) {
      return json({ ok: false, error: "bad_password" }, 400);
    }
    link.password = password.trim();
    passwordChanged = true;
  }

  await env.KV.put(`link:${code}`, JSON.stringify(link));

  return json({
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

/* ------------------------- 入口路由 ------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // CORS 预检请求（GitHub Pages 跨域访问时浏览器会先发 OPTIONS）
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: json({}).headers });
      }
      if (path === "/api/validate" && method === "GET") return handleValidate(url, env);
      if (path === "/api/verify-password" && method === "POST") return handleVerifyPassword(request, env);
      if (path === "/api/chat" && method === "POST") return handleChat(request, env);
      if (path === "/api/history" && method === "GET") return handleHistory(url, env);
      if (path === "/api/messages" && method === "GET") return handleMessages(url, env);
      if (path === "/api/create-code" && method === "POST") return handleCreateCode(request, env);
      if (path === "/api/update-code" && method === "POST") return handleUpdateCode(request, env);

      // 前后端分离：前端托管在 GitHub Pages，非 API 请求统一重定向到前端站点（保留路径与查询参数）
      const frontendBase = String(env.FRONTEND_URL || FRONTEND_DEFAULT).replace(/\/+$/, "");
      return Response.redirect(frontendBase + (path === "/" ? "/" : path) + url.search, 302);
    } catch (e) {
      return json({ ok: false, error: "server_error" }, 500);
    }
  },
};
