/**
 * 赛博梦占 · 前端逻辑
 * 流程：validate → (密码验证) → 设置/恢复会话 → 聊天 → 塔罗动画 → 历史抽屉
 */
(() => {
  "use strict";

  const qs = new URLSearchParams(location.search);
  const code = (qs.get("code") || "").trim();

  /* 后端地址：本地同域留空；GitHub Pages 部署时在 config.js 中填写 Worker 地址 */
  const API_BASE = String(window.CYBER_DREAM_API_BASE || "").replace(/\/+$/, "");
  const api = (path) => API_BASE + path;

  const $ = (id) => document.getElementById(id);

  const state = {
    code,
    token: code ? localStorage.getItem("cdt_token_" + code) || "" : "",
    settings: null,
    remaining: 0,
    sending: false,
    overlayOpen: false,
    overlayStart: 0,
    pending: null, // 已返回但尚未展示的 /api/chat 响应
    overlayTimers: [],
  };

  /* ====================== 通用工具 ====================== */

  function showScreen(name) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    const el = $("screen-" + name);
    if (el) el.classList.add("active");
  }

  let toastTimer = null;
  function showToast(text, duration = 2600) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    t.classList.remove("hide");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.classList.add("hide");
      setTimeout(() => (t.hidden = true), 320);
    }, duration);
  }

  async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  /* 预设二次元头像：按恋人昵称哈希生成 */
  function avatarFor(name) {
    const pets = ["🐰", "🐱", "🐻", "🦊", "🐨", "🐹", "🐼", "🐯"];
    const grads = [
      "linear-gradient(135deg, #FFD6E8, #FF9EC7)",
      "linear-gradient(135deg, #FFE0EC, #FF7FAE)",
      "linear-gradient(135deg, #FBD3E6, #F26CA7)",
      "linear-gradient(135deg, #FFE7F2, #FF9EC7)",
    ];
    const h = hashString(name || "梦");
    return { emoji: pets[h % pets.length], bg: grads[h % grads.length] };
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ====================== 初始化 ====================== */

  async function init() {
    if (!code) {
      showScreen("invalid");
      return;
    }
    let result;
    try {
      result = await fetchJSON(api(`/api/validate?code=${encodeURIComponent(code)}`));
    } catch (e) {
      $("invalid-tip").textContent = "网络好像不太顺畅，请检查网络后刷新重试。";
      showScreen("invalid");
      return;
    }
    const data = result.data;
    if (!data || !data.ok) {
      showScreen("invalid");
      return;
    }
    state.remaining = data.remaining;
    if (data.needPassword && !state.token) {
      showScreen("password");
      return;
    }
    await afterAuth();
  }

  async function afterAuth() {
    let result;
    try {
      result = await fetchJSON(api(`/api/messages?code=${encodeURIComponent(code)}`));
    } catch (e) {
      $("invalid-tip").textContent = "网络好像不太顺畅，请检查网络后刷新重试。";
      showScreen("invalid");
      return;
    }
    const data = result.data;
    if (!data || !data.ok) {
      showScreen("invalid");
      return;
    }
    state.remaining = data.remaining;
    if (data.settings && data.messages && data.messages.length > 0) {
      // 已有云端会话，跨设备恢复，直接进入聊天页
      enterChat(data.messages, data.settings);
    } else {
      prefillSetup(data.settings);
      showScreen("setup");
    }
  }

  /* ====================== 密码验证页 ====================== */

  function bindPasswordScreen() {
    const input = $("pwd-input");
    const btn = $("pwd-btn");
    const card = $("pwd-card");
    const err = $("pwd-error");

    async function submit() {
      const password = input.value.trim();
      if (!password) {
        err.textContent = "请输入密码";
        shake(card);
        return;
      }
      btn.disabled = true;
      btn.textContent = "正在解锁…";
      let result;
      try {
        result = await fetchJSON(api("/api/verify-password"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, password }),
        });
      } catch (e) {
        err.textContent = "网络异常，请稍后再试";
        btn.disabled = false;
        btn.textContent = "解锁梦境";
        return;
      }
      const data = result.data;
      if (data && data.ok && data.sessionToken) {
        state.token = data.sessionToken;
        localStorage.setItem("cdt_token_" + code, data.sessionToken);
        await afterAuth();
        return;
      }
      // 密码错误：抖动提示
      err.textContent = "密码不正确";
      input.value = "";
      shake(card);
      btn.disabled = false;
      btn.textContent = "解锁梦境";
    }

    btn.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  function shake(el) {
    el.classList.remove("shake");
    void el.offsetWidth; // 重置动画
    el.classList.add("shake");
  }

  /* ====================== 设置页 ====================== */

  function prefillSetup(saved) {
    const cached = saved || JSON.parse(localStorage.getItem("cdt_settings_" + code) || "null");
    if (!cached) return;
    $("f-user-name").value = cached.userName || "";
    $("f-user-gender").value = cached.userGender || "女";
    $("f-lover-name").value = cached.loverName || "";
    $("f-lover-gender").value = cached.loverGender || "男";
    $("f-personality").value = cached.loverPersonality || "";
    $("f-stage").value = cached.relationshipStage || "热恋中";
  }

  function bindSetupScreen() {
    $("setup-btn").addEventListener("click", () => {
      const settings = {
        userName: $("f-user-name").value.trim(),
        userGender: $("f-user-gender").value,
        loverName: $("f-lover-name").value.trim(),
        loverGender: $("f-lover-gender").value,
        loverPersonality: $("f-personality").value.trim(),
        relationshipStage: $("f-stage").value,
      };
      const err = $("setup-error");
      if (!settings.userName) {
        err.textContent = "请填写你的昵称";
        return;
      }
      if (!settings.loverName) {
        err.textContent = "请填写另一半的昵称";
        return;
      }
      if (!settings.loverPersonality) {
        err.textContent = "请描述一下 TA 的性格特质";
        return;
      }
      err.textContent = "";
      state.settings = settings;
      localStorage.setItem("cdt_settings_" + code, JSON.stringify(settings));
      enterChat([], settings);
    });
  }

  /* ====================== 聊天页 ====================== */

  function enterChat(messages, settings) {
    state.settings = settings;
    localStorage.setItem("cdt_settings_" + code, JSON.stringify(settings));

    // 头像 / 名字 / 关系阶段
    const avatar = avatarFor(settings.loverName);
    const avatarEl = $("chat-avatar");
    avatarEl.textContent = avatar.emoji;
    avatarEl.style.background = avatar.bg;
    $("chat-name").textContent = settings.loverName;
    $("chat-stage").textContent = settings.relationshipStage;

    // 渲染历史消息
    const list = $("chat-messages");
    const welcome = $("chat-welcome");
    if (messages && messages.length) {
      welcome.hidden = true;
      messages.forEach((m) => appendBubble(m.role === "user" ? "user" : "ai", m.content, false));
    }

    updateRemaining(state.remaining);
    showScreen("chat");
    scrollToBottom(false);

    // 次数用尽则直接锁定
    if (state.remaining <= 0) markExhausted();
  }

  function updateRemaining(n) {
    state.remaining = n;
    const badge = $("chat-remaining");
    badge.textContent = `剩余 ${n} 次`;
    badge.classList.toggle("danger", n <= 3);
  }

  function markExhausted() {
    $("chat-input").disabled = true;
    $("chat-input").placeholder = "链接已失效";
    $("chat-send").disabled = true;
    $("chat-exhausted").hidden = false;
  }

  function scrollToBottom(smooth = true) {
    const list = $("chat-messages");
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  function appendBubble(type, content, animate = true) {
    $("chat-welcome").hidden = true;
    const list = $("chat-messages");
    const div = document.createElement("div");
    div.className = `msg msg-${type}`;
    if (!animate) div.style.animation = "none";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = content;
    div.appendChild(bubble);
    list.appendChild(div);
    scrollToBottom();
    return div;
  }

  function removeLastUserBubble() {
    const bubbles = document.querySelectorAll("#chat-messages .msg-user");
    if (bubbles.length) bubbles[bubbles.length - 1].remove();
  }

  function showTyping() {
    removeTyping();
    const div = document.createElement("div");
    div.className = "msg msg-ai";
    div.id = "typing-msg";
    div.innerHTML = '<div class="typing-bubble"><span></span><span></span><span></span></div>';
    $("chat-messages").appendChild(div);
    scrollToBottom();
  }

  function removeTyping() {
    const t = $("typing-msg");
    if (t) t.remove();
  }

  /* ====================== 发送消息 / AI 请求 ====================== */

  function bindChatInput() {
    $("chat-send").addEventListener("click", sendMessage);
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendMessage();
    });
  }

  function sendMessage() {
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text || state.sending || state.remaining <= 0) return;

    input.value = "";
    appendBubble("user", text);
    state.sending = true;
    state.pending = null;

    openTarotOverlay();

    requestChat(text)
      .then((data) => {
        state.pending = data;
        updateRemaining(data.remaining);
        if (state.overlayOpen) {
          revealTarotCards(data.tarot);
          scheduleOverlayClose(data);
        } else {
          // 用户已跳过浮层：等待期间显示“正在输入”
          showTyping();
          finishReply(data);
        }
      })
      .catch((err) => {
        if (err && err.handled) return; // 次数用尽等已处理
        // AI 调用失败：不扣次数，回滚用户消息并提示
        removeLastUserBubble();
        closeTarotOverlay();
        removeTyping();
        showToast("信号好像断了，再试一次吧");
        state.sending = false;
      });
  }

  /** 请求 /api/chat，网络层失败自动重试一次 */
  async function requestChat(text) {
    const body = JSON.stringify({
      code,
      sessionToken: state.token,
      message: text,
      userSettings: state.settings,
    });
    const options = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };

    let result;
    try {
      result = await fetchJSON(api("/api/chat"), options);
    } catch (e) {
      // 网络超时/断网：自动重试一次
      try {
        await new Promise((r) => setTimeout(r, 1200));
        result = await fetchJSON(api("/api/chat"), options);
      } catch (e2) {
        throw { msg: "network" };
      }
    }

    const data = result.data;
    if (data && data.ok) return data;

    if (data && data.error === "exhausted") {
      updateRemaining(0);
      markExhausted();
      closeTarotOverlay();
      showToast("链接已失效");
      state.sending = false;
      throw { handled: true };
    }
    if (data && data.error === "unauthorized") {
      localStorage.removeItem("cdt_token_" + code);
      closeTarotOverlay();
      showToast("会话已过期，请刷新页面重新输入密码");
      state.sending = false;
      throw { handled: true };
    }
    throw { msg: "ai_failed" };
  }

  /** AI 回复落地：按换行拆分为多条气泡 */
  function finishReply(data) {
    removeTyping();
    const lines = String(data.reply || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) lines.push("……");
    lines.forEach((line, i) => {
      setTimeout(() => {
        appendBubble("ai", line);
        if (i === lines.length - 1) {
          state.sending = false;
          if (data.remaining <= 0) markExhausted();
        }
      }, i * 260);
    });
    if (!lines.length) state.sending = false;
    updateRemaining(data.remaining);
  }

  /* ====================== 塔罗牌浮层 ====================== */

  function openTarotOverlay() {
    const overlay = $("tarot-overlay");
    state.overlayOpen = true;
    state.overlayStart = Date.now();
    state.overlayTimers.forEach(clearTimeout);
    state.overlayTimers = [];
    // 重置为牌背
    document.querySelectorAll(".tcard").forEach((c) => {
      c.classList.remove("flip");
      c.querySelector(".tcard-position").textContent = "";
      c.querySelector(".tcard-name").textContent = "";
      const ori = c.querySelector(".tcard-orientation");
      ori.textContent = "";
      ori.className = "tcard-orientation";
      c.querySelector(".tcard-keywords").textContent = "";
    });
    overlay.hidden = false;
  }

  function revealTarotCards(cards) {
    cards.forEach((card, i) => {
      const el = document.querySelector(`.tcard[data-index="${i}"]`);
      if (!el) return;
      state.overlayTimers.push(
        setTimeout(() => {
          el.querySelector(".tcard-position").textContent = card.position;
          el.querySelector(".tcard-name").textContent = card.name;
          const ori = el.querySelector(".tcard-orientation");
          ori.textContent = card.orientation;
          ori.className = "tcard-orientation " + (card.orientation === "正位" ? "upright" : "reversed");
          el.querySelector(".tcard-keywords").textContent = (card.keywords || []).join(" · ");
          el.classList.add("flip");
        }, 400 + i * 900)
      );
    });
  }

  /** 展示动画总计约 8-10 秒后自动收起 */
  function scheduleOverlayClose(data) {
    const elapsed = Date.now() - state.overlayStart;
    const delay = Math.max(2600, 9000 - elapsed);
    state.overlayTimers.push(
      setTimeout(() => {
        closeTarotOverlay();
        finishReply(data);
      }, delay)
    );
  }

  function closeTarotOverlay() {
    state.overlayTimers.forEach(clearTimeout);
    state.overlayTimers = [];
    state.overlayOpen = false;
    $("tarot-overlay").hidden = true;
  }

  function bindTarotOverlay() {
    $("tarot-skip").addEventListener("click", () => {
      closeTarotOverlay();
      if (state.pending) {
        finishReply(state.pending);
      } else {
        showTyping(); // AI 还没返回，等待期间显示“正在输入”
      }
    });
  }

  /* ====================== 历史抽屉 ====================== */

  function bindHistoryDrawer() {
    const drawer = $("history-drawer");
    const backdrop = $("drawer-backdrop");

    function open() {
      backdrop.hidden = false;
      drawer.classList.add("open");
      loadHistory();
    }
    function close() {
      backdrop.hidden = true;
      drawer.classList.remove("open");
    }

    $("history-fab").addEventListener("click", () => {
      drawer.classList.contains("open") ? close() : open();
    });
    $("drawer-close").addEventListener("click", close);
    backdrop.addEventListener("click", close);
  }

  async function loadHistory() {
    const list = $("drawer-list");
    list.innerHTML = '<p class="drawer-empty">正在加载…</p>';
    let result;
    try {
      result = await fetchJSON(api(`/api/history?code=${encodeURIComponent(code)}`));
    } catch (e) {
      list.innerHTML = '<p class="drawer-empty">加载失败，请稍后再试</p>';
      return;
    }
    const data = result.data;
    if (!data || !data.ok || !data.history || !data.history.length) {
      list.innerHTML = '<p class="drawer-empty">还没有抽过牌<br>发一条消息试试吧</p>';
      return;
    }
    list.innerHTML = "";
    data.history.forEach((draw) => {
      const item = document.createElement("div");
      item.className = "draw-item";

      const time = document.createElement("div");
      time.className = "draw-time";
      time.textContent = "🕘 " + formatTime(draw.time);
      item.appendChild(time);

      const cardsBox = document.createElement("div");
      cardsBox.className = "draw-cards";
      draw.cards.forEach((c) => {
        const line = document.createElement("div");
        line.className = "draw-card-line";
        const pos = document.createElement("span");
        pos.className = "draw-pos";
        pos.textContent = c.position;
        const name = document.createElement("span");
        name.textContent = c.name;
        const ori = document.createElement("span");
        ori.className = "draw-ori " + (c.orientation === "正位" ? "upright" : "reversed");
        ori.textContent = c.orientation;
        line.appendChild(pos);
        line.appendChild(name);
        line.appendChild(ori);
        cardsBox.appendChild(line);
      });
      item.appendChild(cardsBox);
      list.appendChild(item);
    });
  }

  /* ====================== 启动 ====================== */

  bindPasswordScreen();
  bindSetupScreen();
  bindChatInput();
  bindTarotOverlay();
  bindHistoryDrawer();
  init();
})();
