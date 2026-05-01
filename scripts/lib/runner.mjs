#!/usr/bin/env node
/**
 * browser-harness skill — Node-side dispatcher.
 *
 * Each subcommand turns into a `bhts -c '<snippet>'` invocation. The snippet
 * runs inside browser-harness-ts, which gives it `bh` (connected BH) and `h`
 * (alias for bh.helpers) in scope.
 *
 * We deliberately avoid importing browser-harness-ts directly so this skill
 * keeps zero npm dependencies of its own — bhts is the user's globally
 * installed CLI from `npm install -g browser-harness-ts`.
 */
import { spawn } from "node:child_process";
import { resolve, isAbsolute } from "node:path";

const [, , subcommand, ...args] = process.argv;

function die(msg, code = 2) {
  process.stderr.write(`browser-harness: ${msg}\n`);
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

/** Spawn `bhts -c <code>`. Returns the child's exit code. */
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

// --------- snippet builders ---------

function snippetForJs(expr) {
  return `
    const __r = await bh.js(${lit(expr)});
    if (typeof __r === "string") {
      // 字符串直接打，避免被 JSON 加引号
      console.log(__r);
    } else {
      console.log(JSON.stringify(__r, null, 2));
    }
  `;
}

function snippetForExec(snippet) {
  // 用户传的就是任意 bhts 代码，直接拼
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
    // 优先精确 url 包含，再退到 title 包含
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

// --------- main ---------

async function main() {
  let code = 0;
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
      let path = undefined;
      for (const a of args) {
        if (a === "--full") full = true;
        else if (!a.startsWith("--")) path = a;
      }
      // 把相对路径变绝对——bhts 工作目录可能不一样
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
  process.exit(code);
}

main().catch((e) => die(e.stack || String(e), 1));
