# 赛博梦占 · Cyber Dream Tarot

塔罗牌驱动的 AI 二次元恋人聊天应用。用户打开专属链接后，设置自己与恋人的信息，进入沉浸式聊天。每发送一条消息，系统抽取三张塔罗牌，AI 恋人依据角色设定、聊天上下文与牌面寓意生成多条自然回复。链接拥有固定消息次数，用完即失效。

## 技术栈

- **前端**：原生 HTML / CSS / JS（静态文件，可部署到任意静态托管）
- **后端**：Cloudflare Workers
- **存储**：Cloudflare KV（跨设备同步次数、聊天记录、抽牌历史）
- **AI**：DeepSeek Chat API

## 项目结构

```
├── data/tarot-deck.json      # 78 张塔罗牌完整数据（22 大阿卡纳 + 56 小阿卡纳）
├── src/worker.js             # Cloudflare Worker 后端（API + AI 调用 + CORS）
├── public/                   # 前端静态文件（部署到 GitHub Pages 的就是这整个目录）
│   ├── index.html            # 主应用（密码页 / 设置页 / 聊天页）
│   ├── admin.html            # 管理端（隐藏页面：生成链接 / 改次数 / 重置密码）
│   ├── config.js             # ★ 前端配置（填后端 Worker 地址，只用改这一个文件）
│   ├── css/style.css         # 粉色渐变 + 蕾丝风格样式
│   └── js/app.js             # 前端逻辑
├── scripts/create-code.mjs   # 命令行生成/管理链接工具
├── dev-server.mjs            # 本地开发服务器（接入真实 DeepSeek，失败回退 mock）
├── .env.local                # 本地 DeepSeek 密钥（已被 .gitignore 忽略，不提交）
├── .gitignore
├── wrangler.jsonc            # Cloudflare 部署配置
└── package.json
```

## 本地预览（真实 DeepSeek 回复）

```bash
# 1. 在项目根目录创建 .env.local（首次）：
#    DEEPSEEK_API_KEY=sk-你的密钥

# 2. 启动
node dev-server.mjs          # 默认 8080，可 PORT=8180 node dev-server.mjs
```

内置测试链接：

| 链接 | 次数 | 密码 |
|------|------|------|
| http://localhost:8080/?code=DEMO1234 | 50 | 无 |
| http://localhost:8080/?code=LOVE8888 | 30 | 1314 |

管理端：http://localhost:8080/admin.html （密钥 `dev-admin-key`）

> 本地服务器默认调用**真实 DeepSeek API**（密钥读取顺序：环境变量 `DEEPSEEK_API_KEY` → `.env.local`）。
> AI 调用失败时自动回退 mock 模板回复，保证流程不中断；数据存内存，重启清空。

## 正式部署（推荐：GitHub Pages 前端 + Workers 后端）

只需部署**一次**，之后给每个客户的链接都是「母链接 + ?code=xxx」的形式，
例如 `https://你的用户名.github.io/cyber-dream/?code=AbCd1234`。

### 第一步：部署后端（Cloudflare Workers）

```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create TAROT_KV       # 把返回的 id 填入 wrangler.jsonc
wrangler secret put DEEPSEEK_API_KEY        # 粘贴你的 DeepSeek 密钥
wrangler secret put ADMIN_KEY               # 自定义一个管理员密钥
wrangler deploy
```

记下 Worker 地址，形如 `https://cyber-dream.你的子域.workers.dev`。

### 第二步：部署前端（GitHub Pages）

1. 在 GitHub 新建仓库（如 `cyber-dream`），把**整个项目**推上去
   （`.gitignore` 已自动排除 `.env.local` 等密钥文件，**请勿手动上传它们**）。
2. 打开 `public/config.js`，把 Worker 地址填进去：

```js
window.CYBER_DREAM_API_BASE = "https://cyber-dream.你的子域.workers.dev";
```

3. 提交这个修改 → GitHub 仓库 Settings → Pages → Source 选 `main` 分支 `/ (root)`，目录选 `/public`，保存。
4. 稍等几分钟，母链接生效：`https://你的用户名.github.io/cyber-dream/`

> 后端已开启 CORS，前端跨域调用没问题；也可把前端和后端都部署在 Worker 同域（见下）。

### 日常给客户开通（每次 10 秒）

- **网页**：打开 `https://你的用户名.github.io/cyber-dream/admin.html`，
  填 ADMIN_KEY 和次数，勾选「自动生成随机 6 位数字密码」→ 生成 → 一键复制「链接 + 密码」发给客户。
- **命令行**：

```bash
node scripts/create-code.mjs https://你的用户名.github.io/cyber-dream <ADMIN_KEY> 30 auto
```

### 客户售后（改次数 / 重置密码）

- **网页**：admin.html 第二张卡片，输入客户 code → 查询 → 修改剩余次数或重置密码 → 保存。
- **命令行**：

```bash
# 把剩余次数改成 30
node scripts/create-code.mjs https://域名 <ADMIN_KEY> --update <code> --remaining 30
# 重置为新的随机 6 位密码
node scripts/create-code.mjs https://域名 <ADMIN_KEY> --update <code> --auto-pwd
```

### 备选：全部部署在 Cloudflare（前端后端同域）

若不想用 GitHub Pages，可直接把 `public/` 目录的内容放到 Worker 的静态资产里
（在 `wrangler.jsonc` 中配置 `[assets]` 指向 `public/`），此时 `config.js` 保持空字符串即可。

## 生成链接（管理端）

**方式一：隐藏管理页**

访问 `https://<你的域名>/admin.html`，输入 ADMIN_KEY、总次数，可选：
- 勾选「自动生成随机 6 位数字密码」（推荐，密码直接显示可复制）
- 或手动指定密码 / 不设密码

**方式二：命令行**

```bash
node scripts/create-code.mjs https://<你的域名> <ADMIN_KEY> <总次数> [密码|auto]
```

## API 一览

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | /api/validate?code=xxx | 验证链接，返回剩余次数与是否需要密码 |
| POST | /api/verify-password | 验证密码，返回临时会话 token（24h） |
| POST | /api/chat | 发送消息，返回塔罗牌 + AI 回复 + 剩余次数 |
| GET | /api/history?code=xxx | 塔罗牌抽取历史（倒序，仅牌面信息） |
| GET | /api/messages?code=xxx | 聊天记录与设置（跨设备同步恢复用） |
| POST | /api/create-code | 管理员创建新链接（需 ADMIN_KEY，支持 autoPassword 自动 6 位密码） |
| POST | /api/update-code | 管理员查询/修改已有链接（改剩余次数、改/重置/清除密码） |

所有接口均已开启 CORS，前端可部署在任意域名。

## 核心逻辑说明

- **抽牌**：每条消息从 78 张牌中不重复抽取 3 张（当下状态 / 潜在影响 / 趋势指引），每张随机正/逆位。
- **上下文**：最近 6 条聊天记录以独立的"背景上下文" system 消息注入（与当前对话分离）；系统 Prompt 规定：用户延续上一话题（追问/指代/承接）时结合背景回复，开启全新不相关话题时完全无视背景。
- **次数扣减**：仅在 DeepSeek 成功返回后扣减；AI 失败（含超时重试一次后仍失败）不扣次数。
- **跨设备同步**：剩余次数、聊天记录、设置、抽牌历史全部存 KV，同一链接任意设备打开看到同一份数据。
- **会话安全**：带密码链接聊天需持有临时 token（KV 存储，24 小时有效）。

## KV 数据结构

| Key | Value |
|-----|-------|
| link:{code} | { total, remaining, password, createdAt } |
| session:{token} | code（TTL 24h） |
| chat:{code} | 聊天记录（最多保留 200 条） |
| settings:{code} | 用户设置 |
| history:{code} | 抽牌历史（最多保留 100 条，仅牌面不含解读） |

## 安全提醒

- `ADMIN_KEY`、`DEEPSEEK_API_KEY` 只通过 `wrangler secret` 设置，绝不写进代码或提交到 GitHub。
- `.env.local`、`*.key`、`dev-server.log` 已被 `.gitignore` 排除，推送前请确认 `git status` 中没有它们。
- admin.html 是隐藏管理页，仅自己使用，不要把链接发给客户。
