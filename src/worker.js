/**
 * 赛博梦占 · Cloudflare Worker 后端
 *
 * 环境变量 / Secret：
 *   - KV              ：KV 命名空间绑定（存储链接、会话、聊天、历史）
 *   - DEEPSEEK_API_KEY：DeepSeek API 密钥（wrangler secret put DEEPSEEK_API_KEY）
 *   - ADMIN_KEY       ：管理员密钥（wrangler secret put ADMIN_KEY）
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

  // 3. 调用 AI（失败重试一次；仍失败则抛错，不扣次数）
  let reply;
  try {
    reply = await callDeepSeek(env, messages);
  } catch (e) {
    return json({ ok: false, error: "ai_failed" }, 502);
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

  const origin = new URL(request.url).origin;
  return json({ ok: true, code, total: totalNum, password: finalPassword, url: `${origin}/?code=${code}` });
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
      return json({ ok: false, error: "not_found" }, 404);
    } catch (e) {
      return json({ ok: false, error: "server_error" }, 500);
    }
  },
};
