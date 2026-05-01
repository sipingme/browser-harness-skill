#!/usr/bin/env node
/**
 * browser-harness skill — Node-side dispatcher.
 *
 * Each subcommand turns into a `bhts -c '<snippet>'` invocation. The snippet
 * runs inside browser-harness-ts, which gives it `bh` (connected BH) and `h`
 * (alias for bh.helpers) in scope.
 *
 * Hardening (v0.2.0):
 *  - subprocess isolation only — never `await import("browser-harness-ts")`
 *  - sensitive-deny default — refuses writes on hostnames matching
 *    ALWAYS_SENSITIVE_HOST_PATTERNS unless BH_ALLOW_SENSITIVE=1 or the
 *    user passes --i-understand-sensitive
 *  - BH_PUBLIC_ONLY=1 hard-isolation — only PUBLIC_ALLOW_LIST hostnames
 *  - metadata-only audit log — ts/subcommand/hostname/argv-sha256/exit
 *
 * The mirror copy of these constants lives in config.json under
 * capabilities.policy. Keep them in sync when bumping versions.
 */
import { spawn } from "node:child_process";
import { resolve, isAbsolute, join } from "node:path";
import { mkdirSync, appendFileSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// ---------- policy constants (mirror of config.json capabilities.policy) ----------

const ALWAYS_SENSITIVE_HOST_PATTERNS = [
  /\b(bank|paypal|alipay|stripe|wepay|wechat[-_.]?pay|payment)\b/i,
  /\b(gmail|outlook|hotmail|protonmail|webmail|qq\.com\/mail|139\.com|163\.com\/mail)\b/i,
  /\.(internal|intranet|corp|local|lan)(:|\/|$)/i,
  /\b(admin|dashboard|console|wp-admin|cpanel|phpmyadmin)\b/i,
  /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i,
  /\b(ehr|emr|patient|hipaa|medical-record|hospital)\b/i,
];

const PUBLIC_ALLOW_LIST = [
  "github.com", "news.ycombinator.com", "stackoverflow.com", "stackexchange.com",
  "npmjs.com", "pypi.org", "crates.io", "rubygems.org",
  "wikipedia.org", "wikimedia.org",
  "arxiv.org", "biorxiv.org",
  "developer.mozilla.org", "web.dev", "caniuse.com",
  "reuters.com", "bbc.com", "bbc.co.uk",
  "lobste.rs", "v2ex.com", "infoq.cn", "juejin.cn", "csdn.net", "cnblogs.com",
  "theverge.com", "arstechnica.com", "engadget.com", "techcrunch.com",
  "huggingface.co", "kaggle.com", "paperswithcode.com",
  "docs.python.org", "tc39.es", "rfc-editor.org",
  "youtube.com", "youtu.be",
  "bilibili.com", "zhihu.com",
  "openlibrary.org", "imdb.com",
  "thepaper.cn", "36kr.com", "huxiu.com", "wallstreetcn.com", "eastmoney.com",
  "google.com", "bing.com", "duckduckgo.com", "baidu.com", "sogou.com",
  "stackoverflow.blog", "dev.to",
];

const INTERNAL_URL_PREFIXES = [
  "chrome://", "about:", "devtools://", "chrome-untrusted://", "chrome-extension://",
];

// 只读子命令：任何 policy 下都允许（便于体检 / 列表）
const EXEMPT_SUBCOMMANDS = new Set(["page", "tabs", "helpers"]);

// ---------- arg / env parsing ----------

const RAW_ARGV = process.argv.slice(2);
const subcommand = RAW_ARGV[0];

// 提取并剥离 --i-understand-sensitive 标志
let cliOptInSensitive = false;
const args = [];
for (let i = 1; i < RAW_ARGV.length; i++) {
  const a = RAW_ARGV[i];
  if (a === "--i-understand-sensitive") {
    cliOptInSensitive = true;
  } else {
    args.push(a);
  }
}

const ENV = process.env;
const ALLOW_SENSITIVE = cliOptInSensitive || ENV.BH_ALLOW_SENSITIVE === "1";
const PUBLIC_ONLY = ENV.BH_PUBLIC_ONLY === "1";
const AUDIT_LOG_PATH = ENV.BH_AUDIT_LOG !== undefined
  ? ENV.BH_AUDIT_LOG
  : join(homedir(), ".cache", "browser-harness", "skill-audit.log");

// ---------- utilities ----------

function die(msg, code = 2) {
  process.stderr.write(`browser-harness skill: ${msg}\n`);
  process.exit(code);
}

function need(arg, name, idx) {
  if (arg === undefined || arg === null || arg === "") {
    die(`缺少参数: ${name}（位置 ${idx + 1}）`);
  }
  return arg;
}

/**
 * Embed a value as a JS literal we can paste safely into a bhts snippet.
 * Uses JSON.stringify; for `undefined`, returns the string "undefined".
 */
function lit(v) {
  if (v === undefined) return "undefined";
  return JSON.stringify(v);
}

function hostnameOf(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isInternalUrl(url) {
  return INTERNAL_URL_PREFIXES.some((p) => (url || "").startsWith(p));
}

/**
 * 决定是否拒绝当前 URL。返回 { ok: true } 或 { ok: false, reason }.
 * 内部 URL（chrome://, about:, devtools://...）总是放行。
 * publicOnly 优先于 sensitive-deny。
 */
function checkUrlPolicy(url) {
  if (!url) return { ok: true, mode: "no-url" };
  if (isInternalUrl(url)) return { ok: true, mode: "internal-url" };
  const host = hostnameOf(url);
  if (!host) return { ok: true, mode: "non-http-url" };

  if (PUBLIC_ONLY) {
    const hit = PUBLIC_ALLOW_LIST.some(
      (d) => host === d || host.endsWith("." + d),
    );
    if (!hit) {
      return {
        ok: false,
        reason: `BH_PUBLIC_ONLY=1 模式下 ${host} 不在 publicSites allow-list；需要去掉环境变量或把域名加进 PUBLIC_ALLOW_LIST 重新发布。`,
      };
    }
    return { ok: true, mode: "public-allowed" };
  }

  for (const pat of ALWAYS_SENSITIVE_HOST_PATTERNS) {
    if (pat.test(url)) {
      if (ALLOW_SENSITIVE) {
        return { ok: true, mode: "sensitive-allowed-via-opt-in" };
      }
      return {
        ok: false,
        reason: `${host} 命中 sensitive 模式 ${pat}；如确认是你授权的操作，重跑时加 --i-understand-sensitive 或在环境里设 BH_ALLOW_SENSITIVE=1。`,
      };
    }
  }
  return { ok: true, mode: "default-allowed" };
}

// ---------- audit log ----------

function sha256Of(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function ensureLogDirSafe(p) {
  if (!p) return;
  const dir = p.replace(/[\\/][^\\/]+$/, "");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* 目录已存在或不可写——下面写文件时再统一处理 */
  }
}

function writeAudit(line) {
  if (!AUDIT_LOG_PATH) return; // 用户显式置空则禁用
  try {
    ensureLogDirSafe(AUDIT_LOG_PATH);
    appendFileSync(AUDIT_LOG_PATH, line + "\n", { mode: 0o600 });
    // 文件已存在时 mode 不会被改；显式 chmod 一次防止上次 mask 不严
    try {
      const st = statSync(AUDIT_LOG_PATH);
      if ((st.mode & 0o077) !== 0) chmodSync(AUDIT_LOG_PATH, 0o600);
    } catch {
      /* ignore */
    }
  } catch {
    /* 写不进去也不要影响主流程 */
  }
}

function auditLine({ subcommand, hostname, exitCode, mode, denied }) {
  const ts = new Date().toISOString();
  const argvHash = sha256Of(JSON.stringify(RAW_ARGV));
  return [
    `ts=${ts}`,
    `sub=${subcommand}`,
    `host=${hostname || "-"}`,
    `mode=${mode || "-"}`,
    `denied=${denied ? "1" : "0"}`,
    `exit=${exitCode}`,
    `argv_sha256=${argvHash}`,
  ].join(" ");
}

// ---------- bhts subprocess ----------

function runBhts(code) {
  return new Promise((resolveP) => {
    const child = spawn("bhts", ["-c", code], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (e) => {
      if (e.code === "ENOENT") {
        die("bhts 未在 PATH 上。先跑: scripts/run.sh setup");
      }
      die(`spawn bhts 失败: ${e.message}`);
    });
    child.on("exit", (code, signal) => {
      if (signal) die(`bhts 收到信号 ${signal}`, 130);
      resolveP(code ?? 0);
    });
  });
}

/**
 * 在跑真正命令前，先用一个轻量 bhts 调用读 currentTab 拿 url。
 * 返回 url 字符串（拿不到就返回空串，不抛异常——让后面的 policy check 自己决定）。
 */
function fetchCurrentTabUrl() {
  return new Promise((resolveP) => {
    const child = spawn(
      "bhts",
      [
        "-c",
        'try { const t = await bh.currentTab(); console.log(JSON.stringify({url: t.url || ""})); } catch (e) { console.log(JSON.stringify({url: "", err: String(e.message || e)})); }',
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolveP(""));
    child.on("exit", () => {
      try {
        const m = out.match(/\{[^]*\}/); // 抓最后一行 JSON
        if (!m) return resolveP("");
        const parsed = JSON.parse(m[0]);
        resolveP(parsed.url || "");
      } catch {
        resolveP("");
      }
    });
  });
}

// ---------- snippet builders ----------

function snippetForJs(expr) {
  return `
    const __r = await bh.js(${lit(expr)});
    if (typeof __r === "string") {
      console.log(__r);
    } else {
      console.log(JSON.stringify(__r, null, 2));
    }
  `;
}

function snippetForExec(snippet) {
  return snippet;
}

function snippetForPage() {
  return `
    const info = await bh.pageInfo();
    console.log(JSON.stringify(info, null, 2));
  `;
}

function snippetForTabs() {
  return `
    const tabs = await bh.listTabs(false);
    console.log(JSON.stringify(tabs, null, 2));
  `;
}

function snippetForOpen(url) {
  return `
    await bh.newTab(${lit(url)});
    await bh.waitForLoad();
    console.log(JSON.stringify(await bh.pageInfo(), null, 2));
  `;
}

function snippetForSwitch(keyword) {
  return `
    const kw = ${lit(keyword)}.toLowerCase();
    const tabs = await bh.listTabs(false);
    let hit = tabs.find(t => (t.url || "").toLowerCase().includes(kw));
    if (!hit) hit = tabs.find(t => (t.title || "").toLowerCase().includes(kw));
    if (!hit) {
      console.error("没有标签匹配关键词:", ${lit(keyword)});
      console.error("当前标签:");
      for (const t of tabs) console.error("  -", t.title.slice(0, 50), "  ", t.url.slice(0, 80));
      process.exit(2);
    }
    await bh.switchTab(hit.targetId);
    console.log(JSON.stringify(hit, null, 2));
  `;
}

function snippetForShot({ full, path }) {
  return `
    const out = await bh.captureScreenshot({ path: ${lit(path)}, full: ${lit(full)} });
    console.log(out);
  `;
}

function snippetForClick(x, y) {
  return `
    await bh.clickAtXy(${Number(x)}, ${Number(y)});
    console.log("clicked", ${Number(x)}, ${Number(y)});
  `;
}

function snippetForType(text) {
  return `
    await bh.typeText(${lit(text)});
    console.log("typed", ${lit(text.length)}, "chars");
  `;
}

function snippetForKey(key) {
  return `
    await bh.pressKey(${lit(key)});
    console.log("pressed", ${lit(key)});
  `;
}

function snippetForScroll(dy) {
  return `
    await bh.scroll(400, 400, ${Number(dy)});
    console.log("scrolled dy =", ${Number(dy)});
  `;
}

function snippetForUpload(selector, path) {
  return `
    await bh.uploadFile(${lit(selector)}, ${lit(path)});
    console.log("uploaded", ${lit(path)}, "->", ${lit(selector)});
  `;
}

function snippetForHelpers() {
  return `
    const names = Object.keys(bh.helpers || {});
    if (names.length === 0) {
      console.log("(no helpers registered — write some in agent-workspace/agent_helpers.ts)");
    } else {
      for (const n of names) console.log(n);
    }
  `;
}

// ---------- policy gating per subcommand ----------

/**
 * 决定本次执行要检查的 URL：
 *  - "open" / "switch": 检查参数本身（即将变为当前页）
 *  - 其它写命令：检查当前已附着的标签 url
 *  - exempted 子命令：跳过检查
 * 返回 { url, source } 或 { skip: true }（exempted）。
 */
async function resolveUrlForPolicy(sub, args) {
  if (EXEMPT_SUBCOMMANDS.has(sub)) return { skip: true };

  if (sub === "open") {
    return { url: args[0] || "", source: "arg" };
  }
  if (sub === "switch") {
    // switch 是按关键词匹配标签——不看参数 URL，但目标页可能敏感。
    // 对 switch 我们只在切到敏感页之后由后续命令再次触发拦截。
    // 这里跳过，避免阻塞合法的"切到 GitHub 看看"场景。
    return { skip: true };
  }
  // 其它都是作用在当前 tab
  const cur = await fetchCurrentTabUrl();
  return { url: cur, source: "currentTab" };
}

// ---------- main ----------

async function main() {
  if (!subcommand) die("缺少子命令");

  // 1) 决定要校验哪个 URL
  const urlInfo = await resolveUrlForPolicy(subcommand, args);

  // 2) 执行 policy check
  let policyMode = "exempt";
  let host = "";
  if (!urlInfo.skip) {
    const verdict = checkUrlPolicy(urlInfo.url || "");
    policyMode = verdict.mode || "unknown";
    host = hostnameOf(urlInfo.url || "");
    if (!verdict.ok) {
      writeAudit(
        auditLine({
          subcommand,
          hostname: host,
          exitCode: 7,
          mode: policyMode,
          denied: true,
        }),
      );
      die(
        `DENY (${policyMode}): ${verdict.reason}\n` +
          `  目标: ${urlInfo.url || "(unknown)"}`,
        7,
      );
    }
  }

  // 3) 跑实际命令
  let code = 0;
  try {
    switch (subcommand) {
      case "js": {
        const expr = need(args[0], "JS 表达式", 0);
        code = await runBhts(snippetForJs(expr));
        break;
      }
      case "exec": {
        const snip = need(args[0], "bhts snippet", 0);
        code = await runBhts(snippetForExec(snip));
        break;
      }
      case "page":
        code = await runBhts(snippetForPage());
        break;
      case "tabs":
        code = await runBhts(snippetForTabs());
        break;
      case "open": {
        const url = need(args[0], "URL", 0);
        code = await runBhts(snippetForOpen(url));
        break;
      }
      case "switch": {
        const kw = need(args[0], "keyword", 0);
        code = await runBhts(snippetForSwitch(kw));
        break;
      }
      case "shot": {
        let full = false;
        let path;
        for (const a of args) {
          if (a === "--full") full = true;
          else if (!a.startsWith("--")) path = a;
        }
        if (path && !isAbsolute(path)) path = resolve(process.cwd(), path);
        if (!path) path = resolve(process.cwd(), full ? "fullpage.png" : "shot.png");
        code = await runBhts(snippetForShot({ full, path }));
        break;
      }
      case "click": {
        const x = need(args[0], "x", 0);
        const y = need(args[1], "y", 1);
        if (Number.isNaN(Number(x)) || Number.isNaN(Number(y))) {
          die("click x y 必须是数字");
        }
        code = await runBhts(snippetForClick(x, y));
        break;
      }
      case "type": {
        const text = need(args[0], "text", 0);
        code = await runBhts(snippetForType(text));
        break;
      }
      case "key": {
        const key = need(args[0], "key 名（如 Enter）", 0);
        code = await runBhts(snippetForKey(key));
        break;
      }
      case "scroll": {
        const dy = need(args[0], "dy", 0);
        if (Number.isNaN(Number(dy))) die("scroll dy 必须是数字（负值向上）");
        code = await runBhts(snippetForScroll(dy));
        break;
      }
      case "upload": {
        const selector = need(args[0], "CSS selector", 0);
        let path = need(args[1], "本地文件路径", 1);
        if (!isAbsolute(path)) path = resolve(process.cwd(), path);
        code = await runBhts(snippetForUpload(selector, path));
        break;
      }
      case "helpers":
        code = await runBhts(snippetForHelpers());
        break;
      default:
        die(`未知子命令: ${subcommand}`);
    }
  } finally {
    writeAudit(
      auditLine({
        subcommand,
        hostname: host,
        exitCode: code,
        mode: policyMode,
        denied: false,
      }),
    );
  }

  process.exit(code);
}

main().catch((e) => die(e.stack || String(e), 1));
