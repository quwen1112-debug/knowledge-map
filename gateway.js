#!/usr/bin/env node
/**
 * 本机模型网关 · 知识拓扑专用
 * ===============================================================
 * 解决的问题
 *   1. 不想每次去 DeepSeek 网站申请 Key —— 直接用 WorkBuddy 自己那份凭据；
 *   2. 又不愿意把 Key 写进 HTML —— 因为文件一发给别人，Key 就等于公开了。
 *
 * 做法
 *   真 Key 只存在于这个进程的内存里。页面由网关自己托管，网关在返回 HTML
 *   的那一刻把「一次性会话令牌」注入进去（只在 HTTP 响应里，磁盘上的
 *   knowledge-map.html 仍然是干净的占位符）。别人拿到这个 HTML 文件，
 *   里面没有任何密钥，AI 功能自然就是关的。
 *
 * 用法
 *   node ds-gateway.js                  # 起服务，浏览器开 http://127.0.0.1:8787/
 *   node ds-gateway.js --port 8899      # 换端口
 *   node ds-gateway.js --model deepseek-v4-pro
 *   node ds-gateway.js issue --hours 24 --uses 60 --label "给张三"
 *   node ds-gateway.js list / revoke <编号>
 *   node ds-gateway.js check            # 只看凭据读到没、能不能通，不起服务
 *
 * 凭据来源（按顺序取第一个可用的）
 *   1. --key sk-xxxx
 *   2. 环境变量 DEEPSEEK_API_KEY
 *   3. 同目录 wb-credential.json   {"base":"https://api.deepseek.com","key":"sk-...","model":"deepseek-flash"}
 *   4. ~/.workbuddy/models.json    ← WorkBuddy 自己用的那份，默认走这里，不复制、不落盘
 *   5. 同目录 deepseek.key         一行 sk-...
 *
 * 安全边界
 *   - 默认只监听 127.0.0.1，本机之外连不进来。
 *   - 令牌只存哈希；过期/次数/吊销三重校验。
 *   - --host 0.0.0.0 等于对外开放，那时务必用短期令牌，用完 revoke。
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DIR = __dirname;
const TOKENS_FILE = path.join(DIR, "gateway-tokens.json");
const CRED_FILE = path.join(DIR, "wb-credential.json");
const KEY_FILE = path.join(DIR, "deepseek.key");
const PAGE_FILE = path.join(DIR, "knowledge-map.html");
const WB_MODELS = path.join(os.homedir(), ".workbuddy", "models.json");

const DEFAULT_UPSTREAM = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const cmd = (argv[0] && !argv[0].startsWith("--")) ? argv[0] : "serve";
function flag(name, def) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith("--")) ? true : v;
}

/* ---------------- 凭据 ---------------- */
// 返回 {base, key, model, source}
function loadCredential() {
  const wantModel = flag("model", null);

  // 1. 命令行
  const argKey = flag("key", null);
  if (argKey && argKey !== true) {
    return { base: String(flag("upstream", DEFAULT_UPSTREAM)), key: String(argKey), model: wantModel || DEFAULT_MODEL, source: "--key 参数" };
  }

  // 2. 环境变量
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return { base: process.env.DS_UPSTREAM || DEFAULT_UPSTREAM, key: process.env.DEEPSEEK_API_KEY.trim(), model: wantModel || DEFAULT_MODEL, source: "环境变量 DEEPSEEK_API_KEY" };
  }

  // 3. 导进来的那份
  try {
    const c = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
    if (c && c.key) {
      return { base: String(c.base || DEFAULT_UPSTREAM).replace(/\/+$/, ""), key: String(c.key), model: wantModel || c.model || DEFAULT_MODEL, source: "wb-credential.json" };
    }
  } catch (e) { /* 没有就算了 */ }

  // 4. WorkBuddy 自己的模型配置
  try {
    const list = JSON.parse(fs.readFileSync(WB_MODELS, "utf8"));
    if (Array.isArray(list) && list.length) {
      let hit = null;
      if (wantModel) hit = list.find(m => m.id === wantModel);
      if (!hit) hit = list.find(m => m.id === DEFAULT_MODEL);
      if (!hit) hit = list.find(m => /deepseek/i.test(m.vendor || "") || /deepseek/i.test(m.id || ""));
      if (!hit) hit = list[0];
      if (hit && hit.apiKey) {
        // url 形如 .../chat/completions，取到 /v1 之前
        let base = DEFAULT_UPSTREAM;
        if (hit.url) base = String(hit.url).replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
        return { base, key: hit.apiKey, model: wantModel || hit.id, source: "WorkBuddy 个人 API（~/.workbuddy/models.json）" };
      }
    }
  } catch (e) { /* 没这个文件 */ }

  // 5. 老式的纯 Key 文件
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (raw) return { base: DEFAULT_UPSTREAM, key: raw.split(/\r?\n/)[0].trim(), model: wantModel || DEFAULT_MODEL, source: "deepseek.key" };
  } catch (e) { /* 没有 */ }

  return null;
}

const mask = k => (k ? k.slice(0, 7) + "…" + k.slice(-4) + "（" + k.length + " 位）" : "—");

/* ---------------- 令牌存取 ---------------- */
function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); }
  catch (e) { return []; }
}
function saveTokens(list) {
  try { fs.writeFileSync(TOKENS_FILE, JSON.stringify(list, null, 2), "utf8"); } catch (e) {}
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const shortId = () => crypto.randomBytes(3).toString("hex");

function prune(list) {
  const now = Date.now();
  const alive = list.filter(t => !t.revoked && Date.parse(t.expiresAt) > now);
  const dead = list.filter(t => t.revoked || Date.parse(t.expiresAt) <= now)
                   .sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt))
                   .slice(0, 20);              // 留一点已失效的做痕迹，最多 20 条
  return alive.slice(-200).concat(dead);       // 有效的也只留 200 条
}

function issueToken({ hours = 24, uses = 0, label = "", persist = true }) {
  const token = "wbk-" + crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const rec = {
    id: shortId(),
    label: label || "未命名",
    hash: sha(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3600e3).toISOString(),
    uses: Number(uses) || 0,
    used: 0,
    revoked: false
  };
  if (persist) {
    const list = prune(loadTokens());
    list.push(rec);
    saveTokens(list);
  }
  return { token, rec };
}

function checkToken(token) {
  const h = sha(token);
  const rec = loadTokens().find(t => t.hash === h);
  if (!rec) return { ok: false, reason: "令牌不存在" };
  if (rec.revoked) return { ok: false, reason: "令牌已被吊销" };
  if (Date.parse(rec.expiresAt) < Date.now()) return { ok: false, reason: "令牌已过期" };
  if (rec.uses > 0 && rec.used >= rec.uses) return { ok: false, reason: "令牌次数已用完" };
  return { ok: true, rec };
}
function consume(rec) {
  const list = loadTokens();
  const t = list.find(x => x.id === rec.id);
  if (t) { t.used += 1; saveTokens(list); }
}

/* ---------------- 命令行 ---------------- */
if (cmd === "issue") {
  const hours = Number(flag("hours", 24));
  const uses = Number(flag("uses", 0));
  const label = String(flag("label", ""));
  const { token, rec } = issueToken({ hours, uses, label });
  console.log("");
  console.log("  令牌编号  " + rec.id + (label ? "   (" + label + ")" : ""));
  console.log("  有效期    " + hours + " 小时，到 " + rec.expiresAt + " 截止");
  console.log("  可用次数  " + (uses > 0 ? uses + " 次" : "不限"));
  console.log("");
  console.log("  " + token);
  console.log("");
  console.log("  只显示这一次，文件里存的是哈希，丢了就再发一个。");
  console.log("  对方在工具里点「接入模型 → 本机网关」，地址 http://<你的IP>:8787/v1，Key 填这串。");
  console.log("");
  process.exit(0);
}

if (cmd === "list") {
  const list = loadTokens();
  if (!list.length) { console.log("还没有发出过令牌。"); process.exit(0); }
  console.log("");
  list.forEach(t => {
    const state = t.revoked ? "已吊销"
      : (Date.parse(t.expiresAt) < Date.now() ? "已过期"
      : (t.uses > 0 && t.used >= t.uses ? "次数用完" : "有效"));
    console.log("  " + t.id + "  " + state.padEnd(4) + "  " +
      String(t.used) + "/" + (t.uses || "不限") + " 次  " +
      "到 " + t.expiresAt.slice(0, 16).replace("T", " ") + "  " + t.label);
  });
  console.log("");
  process.exit(0);
}

if (cmd === "revoke") {
  const id = argv[1];
  if (!id) { console.log("用法：node ds-gateway.js revoke <编号>"); process.exit(1); }
  const list = loadTokens();
  const t = list.find(x => x.id === id);
  if (!t) { console.log("没找到编号 " + id); process.exit(1); }
  t.revoked = true;
  saveTokens(list);
  console.log("已吊销 " + id + "（" + t.label + "）");
  process.exit(0);
}

if (cmd === "check") {
  const cred = loadCredential();
  if (!cred) {
    console.log("\n  没找到任何可用凭据。\n");
    console.log("  期望的位置：");
    console.log("    · " + WB_MODELS + "（WorkBuddy 自己的模型配置）");
    console.log("    · " + CRED_FILE);
    console.log("    · 环境变量 DEEPSEEK_API_KEY\n");
    process.exit(1);
  }
  console.log("");
  console.log("  凭据来源  " + cred.source);
  console.log("  上游地址  " + cred.base);
  console.log("  模型      " + cred.model);
  console.log("  Key       " + mask(cred.key));
  console.log("");
  (async () => {
    try {
      const r = await fetch(cred.base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cred.key },
        body: JSON.stringify({ model: cred.model, max_tokens: 8, messages: [{ role: "user", content: "回一个字：通" }] })
      });
      const t = await r.text();
      console.log("  连通测试  HTTP " + r.status + "  " + t.slice(0, 160).replace(/\s+/g, " "));
      console.log("");
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      console.log("  连通测试  失败：" + e.message + "\n");
      process.exit(1);
    }
  })();
  return;
}

/* ---------------- 服务 ---------------- */
const CRED = loadCredential();
if (!CRED) {
  console.error("");
  console.error("  没找到可用的模型凭据。按顺序试过：");
  console.error("    --key 参数 / DEEPSEEK_API_KEY / wb-credential.json /");
  console.error("    " + WB_MODELS + " / deepseek.key");
  console.error("");
  console.error("  最省事的办法：确认 WorkBuddy 桌面端里配过模型，然后直接再跑一次。");
  console.error("");
  process.exit(1);
}

const PORT = Number(flag("port", 8787));
const HOST = String(flag("host", "127.0.0.1"));
const UPSTREAM = String(CRED.base || DEFAULT_UPSTREAM).replace(/\/+$/, "");
const MODEL = String(CRED.model || DEFAULT_MODEL);
const SESSION_HOURS = Number(flag("session-hours", 12));

function cors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function servePage(res, urlPath) {
  let html;
  try { html = fs.readFileSync(PAGE_FILE, "utf8"); }
  catch (e) {
    json(res, 404, { error: { message: "找不到 knowledge-map.html（应和本文件同目录）" } });
    return;
  }
  const { token, rec } = issueToken({ hours: SESSION_HOURS, uses: 0, label: "页面会话 " + new Date().toTimeString().slice(0, 5) });
  const base = "http://127.0.0.1:" + PORT + "/v1";
  html = html.split("__WB_TOKEN__").join(token)
             .split("__WB_BASE__").join(base)
             .split("__WB_MODEL__").join(MODEL);

  if (urlPath === "/ai" || urlPath === "/ai/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
    console.log(new Date().toTimeString().slice(0, 8), "PAGE 注入会话令牌 " + rec.id + "（" + SESSION_HOURS + " 小时）");
    return;
  }
  // 根路径直接给工具本身，省一次跳转
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
  console.log(new Date().toTimeString().slice(0, 8), "PAGE 注入会话令牌 " + rec.id + "（" + SESSION_HOURS + " 小时）");
}

const server = http.createServer((req, res) => {
  cors(req, res);

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const urlPath = String(req.url || "/").split("?")[0];

  if (urlPath === "/health") {
    json(res, 200, {
      ok: true,
      model: MODEL,
      upstream: UPSTREAM,
      source: CRED.source,
      page: fs.existsSync(PAGE_FILE),
      sessionHours: SESSION_HOURS,
      tokens: loadTokens().length
    });
    return;
  }

  if (req.method === "GET" && (urlPath === "/" || urlPath === "/index.html" || urlPath === "/ai" || urlPath === "/ai/")) {
    servePage(res, urlPath);
    return;
  }

  if (req.method !== "POST") { json(res, 405, { error: { message: "只支持 POST" } }); return; }

  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) { json(res, 401, { error: { message: "缺少令牌" } }); return; }

  const chk = checkToken(token);
  if (!chk.ok) { json(res, 401, { error: { message: "令牌无效：" + chk.reason } }); return; }

  let body = "";
  let tooBig = false;
  req.on("data", c => {
    body += c;
    if (body.length > 262144) { tooBig = true; req.destroy(); }
  });
  req.on("end", async () => {
    if (tooBig) { json(res, 413, { error: { message: "请求体过大" } }); return; }

    const tail = req.url.replace(/^\/v1/, "");
    const target = UPSTREAM + (tail.startsWith("/") ? tail : "/" + tail);

    try {
      const r = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + CRED.key      // 真 Key 只在这一跳出现，绝不回到浏览器
        },
        body
      });
      const text = await r.text();
      if (r.ok) consume(chk.rec);
      res.writeHead(r.status, {
        "Content-Type": r.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store"
      });
      res.end(text);
      const left = chk.rec.uses > 0 ? (chk.rec.uses - chk.rec.used - (r.ok ? 1 : 0)) : "∞";
      console.log(new Date().toTimeString().slice(0, 8), (r.ok ? "OK  " : "FAIL"), r.status, chk.rec.id, "剩余 " + left);
    } catch (e) {
      json(res, 502, { error: { message: "上游连接失败：" + e.message } });
    }
  });
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error("\n  端口 " + PORT + " 被占用了。换一个：node ds-gateway.js --port 8899\n");
  } else {
    console.error("\n  起不来：" + e.message + "\n");
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = "http://127.0.0.1:" + PORT + "/";
  console.log("");
  console.log("  ┌─────────────────────────────────────────────┐");
  console.log("  │  知识拓扑 · 本机网关已就绪                   │");
  console.log("  └─────────────────────────────────────────────┘");
  console.log("");
  console.log("  打开        " + url);
  console.log("  凭据来源    " + CRED.source);
  console.log("  模型        " + MODEL);
  console.log("  真 Key      " + mask(CRED.key) + "  只在本进程内存里");
  console.log("  会话令牌    " + SESSION_HOURS + " 小时，每次打开页面自动换新");
  console.log("");
  if (!fs.existsSync(PAGE_FILE)) {
    console.log("  ⚠ 同目录没看到 knowledge-map.html，页面打不开（接口仍可用）。");
    console.log("");
  }
  console.log("  Ctrl+C 停止。停掉之后页面里的 AI 就不通了，拓扑和笔记照常用。");
  if (HOST === "0.0.0.0") {
    console.log("");
    console.log("  ⚠ 正在对外开放。只发短期令牌：node ds-gateway.js issue --hours 24 --uses 60");
    console.log("    用完 revoke 掉。");
  }
  console.log("");

  if (flag("open", false)) {
    try {
      const cp = require("child_process");
      if (process.platform === "win32") cp.exec('start "" "' + url + '"');
      else if (process.platform === "darwin") cp.exec('open "' + url + '"');
      else cp.exec('xdg-open "' + url + '"');
    } catch (e) { /* 打不开就算了，地址已经印在上面 */ }
  }
});
