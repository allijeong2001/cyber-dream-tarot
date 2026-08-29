#!/usr/bin/env node
/**
 * 赛博梦占 · 命令行生成链接工具
 *
 * 用法：
 *   node scripts/create-code.mjs <基础地址> <管理员密钥> <总次数> [密码|auto]
 *
 * 示例：
 *   node scripts/create-code.mjs https://dream.example.com my-admin-key 50
 *   node scripts/create-code.mjs https://dream.example.com my-admin-key 50 auto   # 自动生成 6 位密码
 *   node scripts/create-code.mjs https://dream.example.com my-admin-key 50 1314   # 指定密码
 *
 * 管理已有链接（改次数 / 重置密码）：
 *   node scripts/create-code.mjs <基础地址> <管理员密钥> --update <code> [--remaining N] [--password xxx|--auto-pwd|--clear-pwd]
 */

const args = process.argv.slice(2);
const [baseUrl, adminKey, totalArg, password] = args;

function usage() {
  console.error("用法:");
  console.error("  生成: node scripts/create-code.mjs <基础地址> <管理员密钥> <总次数> [密码|auto]");
  console.error("  管理: node scripts/create-code.mjs <基础地址> <管理员密钥> --update <code> [--remaining N] [--password xxx|--auto-pwd|--clear-pwd]");
  process.exit(1);
}

if (!baseUrl || !adminKey) usage();

async function post(path, body) {
  const res = await fetch(baseUrl.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

try {
  // ---- 管理已有链接 ----
  if (totalArg === "--update") {
    const idx = args.indexOf("--update");
    const code = args[idx + 1];
    if (!code) usage();

    const body = { adminKey, code };
    const flags = {
      remaining: args.indexOf("--remaining"),
      password: args.indexOf("--password"),
      autoPwd: args.indexOf("--auto-pwd"),
      clearPwd: args.indexOf("--clear-pwd"),
    };
    if (flags.remaining !== -1) body.remaining = parseInt(args[flags.remaining + 1], 10);
    if (flags.password !== -1) body.password = args[flags.password + 1];
    if (flags.autoPwd !== -1) body.autoPassword = true;
    if (flags.clearPwd !== -1) body.clearPassword = true;

    const data = await post("/api/update-code", body);
    if (!data.ok) {
      console.error("操作失败:", data.error || "未知错误");
      process.exit(1);
    }
    const l = data.link;
    console.log("✦ 链接信息");
    console.log("  code    :", l.code);
    console.log("  总次数 :", l.total);
    console.log("  剩余   :", l.remaining);
    console.log("  密码   :", l.password || "（无密码）");
    console.log("  创建于 :", l.createdAt);
    console.log("  链接   :", baseUrl.replace(/\/+$/, "") + "/?code=" + l.code);
    process.exit(0);
  }

  // ---- 生成新链接 ----
  if (!totalArg) usage();
  const total = parseInt(totalArg, 10);
  if (!Number.isInteger(total) || total < 1) {
    console.error("错误: 总次数必须是正整数");
    process.exit(1);
  }

  const data = await post("/api/create-code", {
    adminKey,
    total,
    autoPassword: password === "auto" ? true : undefined,
    password: password && password !== "auto" ? password : undefined,
  });

  if (!data.ok) {
    console.error("生成失败:", data.error || "未知错误");
    process.exit(1);
  }

  console.log("✦ 链接生成成功");
  console.log("  code :", data.code);
  console.log("  次数 :", data.total);
  if (data.password) console.log("  密码 :", data.password);
  console.log("  链接 :", baseUrl.replace(/\/+$/, "") + "/?code=" + data.code);
} catch (e) {
  console.error("网络异常:", e.message);
  process.exit(1);
}
