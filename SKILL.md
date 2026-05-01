---
name: browser-harness
version: 0.1.0
description: 用 LLM 友好的方式控制用户已登录的真实 Chrome（CDP）。一行命令在当前标签页跑 JS、点击、滚动、截图、读 DOM、填表、上传文件——共享 cookie/session/登录态，跨 Python 与 TypeScript Agent 操作同一个浏览器。基于 browser-use/browser-harness（Python 守护进程）+ browser-harness-ts（TS 客户端 + bhts CLI）。
author: Ping Si <sipingme@gmail.com>
tags: [browser, automation, chrome, cdp, agent, llm, scraping, devtools-protocol, browser-use]
requiredEnvVars: []
---

# browser-harness

把 LLM Agent 接到**用户已经登录、已经打开**的那个真实 Chrome 上——不是 Playwright 启的临时窗口，不是隐私模式，不是清空 cookie 的容器。一个长寿命 Python 守护进程持有 CDP WebSocket，多个 Agent（Python 或 TS）通过 JSON-line IPC 同时操作同一个标签页。

> 致谢：Chrome 接管 / CDP 握手 / 对话框处理 / 76 个站点 domain-skills 全部来自 [Browser Use](https://github.com/browser-use) 团队的上游 [`browser-use/browser-harness`](https://github.com/browser-use/browser-harness)。本 skill 只是一层薄包装。

## 给 AI 的使用说明（核心）

### 用户意图 → 命令

| 用户说什么 | 调用 | 然后做什么 |
|---|---|---|
| 第一次用 / 安装 / 接到我的 Chrome | `scripts/run.sh setup` | 跟随提示完成 `uv tool install` + `npm install -g browser-harness-ts` + `browser-harness --setup`；最后跑 `doctor` 确认绿灯 |
| 看看现在能不能用 / 体检 | `scripts/run.sh doctor` | 报告：守护进程是否在跑、当前标签页 URL/title |
| 在我当前页面跑这段 JS：`<expr>` | `scripts/run.sh js '<expr>'` | 把 expr 注入当前标签页的页面上下文执行；返回 JSON 序列化结果 |
| 帮我点击 / 滚动 / 输入 / 截图 | `scripts/run.sh exec '<bhts snippet>'` | 通过 `bhts -c` 跑任意 BH 方法序列；snippet 内 `bh` 已就绪 |
| 截一张当前页面 | `scripts/run.sh shot [path]` | 默认存到 `./shot.png`；用户提供路径就用用户路径 |
| 读取当前页面信息 | `scripts/run.sh page` | 输出 `{url,title,viewport,scroll,pageSize}` JSON |
| 列出我打开的标签页 | `scripts/run.sh tabs` | 排除 `chrome://` 等内部页 |
| 切到匹配 `<keyword>` 的那个标签页 | `scripts/run.sh switch '<keyword>'` | 在 url/title 里匹配；多个匹配时优先精确 url 包含 |
| 打开新标签 `<url>` | `scripts/run.sh open '<url>'` | 新建标签 + 等加载完成 |
| 把这个文件传到当前页面的 `<selector>` | `scripts/run.sh upload '<selector>' '<abs-path>'` | 等价 `DOM.setFileInputFiles` |
| 我们之前在 xxx 站做过的事 | 先读 `agent-workspace/domain-skills/<host>/*.md`，再调上面的命令 | 不要重新摸索选择器；优先用沉淀的知识 |

### 关键约束（必须遵守）

1. **共享真实 Chrome，不要替用户开新窗口**。`browser-harness` 的全部价值是接管用户已登录的浏览器；任何"我帮你启动一个浏览器"的提议都是错的。
2. **守护进程必须先在跑**。`scripts/run.sh setup` 之后要求用户至少执行过一次 `browser-harness --setup`（接 chrome://inspect）。失败时跑 `scripts/run.sh doctor`，把它的输出**原文**贴给用户，不要瞎猜。
3. **不要替用户打开 chrome://inspect 链接**。守护进程附着 Chrome 时会打印一次性 URL，必须**原文转给用户在他自己的 Chrome 里点击**——你（Agent 端的浏览器）打开它没用。
4. **JS snippet 不能 close-over 外部变量**。`scripts/run.sh js / exec` 跑的代码序列化后送到 Chrome 执行；它看不见你这一侧 Node 里的任何变量，行为同 Playwright `page.evaluate`。需要传参时通过 `JSON.stringify` 拼到字符串里。
5. **写域知识，不要写"我做过什么"**。每发现一个站点的稳定选择器 / 私有 API / 框架坑，把它写进 `agent-workspace/domain-skills/<host>/*.md`（详见 [reference.md](reference.md) 的 *Domain skills* 节）。**不要**记"我点了第 3 个按钮然后等了 2 秒"——那是日记不是地图。
6. **永不**把 cookie / token / session id / 登录密码写进 domain-skills 文件——这些目录会进 git。
7. **CDP 调用是裸协议，没有自动重试**。网络抖动 / 标签被关 / Chrome 升级时调用会立即抛错；把错误**原文**报告给用户而不是默默吞掉。

### 错误恢复对照

| 错误信息 | 正确处置 |
|---|---|
| `browser-harness daemon "default" not running` | 跑 `scripts/run.sh setup`；若已 setup 过，提示用户重新跑 `browser-harness --setup` 接管 Chrome |
| `failed to discover Chrome /json/version` | Chrome 没开远程调试。提示用户：关掉 Chrome → `scripts/run.sh setup` 会指导重启时加 `--remote-debugging-port=9222` |
| `JavaScript evaluation failed: ReferenceError: ...` | snippet 引用了页面上不存在的变量；先用 `js 'document.title'` 类的简单语句确认上下文，再补全 |
| `no element for <selector>` | 选择器不在当前 DOM。先 `js 'document.querySelectorAll("...").length'` 检查，再考虑 iframe（用 `bh.iframeTarget(...)`） |
| 任何 `Target ... not found` | 标签页关闭或刷新后 sessionId 失效；调 `bh.ensureRealTab()` 重新附着 |

## 配合 domain-skills 工作（必看）

`agent-workspace/domain-skills/<host>/*.md` 是这个 skill 的"长期记忆"。**做任何站点任务前先读它**，不要靠零样本摸索。

```bash
ls agent-workspace/domain-skills/    # 看本地有哪些站点知识
cat agent-workspace/domain-skills/xiaohongshu/scraping.md   # 读特定站点
```

上游 76 个站点知识（GitHub / Twitter / LinkedIn / Notion / 飞书 / 小红书 ...）在 `browser-harness` Python 包里；本 skill 的 `agent-workspace/domain-skills/` 目录是**本机你自己沉淀**的知识，不会和上游冲突。详细写法约定见 [reference.md](reference.md#domain-skills)。

## 完成证据格式

每完成一个浏览器任务，回报给用户：

```
BROWSER_RESULT
- intent: <用户原话或概括>
- actions: <按顺序列出真正调用的 bhts 命令>
- final_page: <最终 URL + title>
- evidence: <截图路径 / 提取的数据 / 或 "已写入 domain-skills/<host>/<topic>.md">
- caveats: <如果任何一步靠假设而非验证，明确说>
```

## 例子

### 例 1：抓取当前 HN 首页前 5 条

> 用户：把 HN 首页前 5 条标题抓出来

AI 执行：
```bash
scripts/run.sh open https://news.ycombinator.com
scripts/run.sh js '[...document.querySelectorAll(".titleline a")].slice(0,5).map(a=>a.textContent)'
```

### 例 2：截图当前页

> 用户：截一张当前页面给我

AI 执行：
```bash
scripts/run.sh shot ./current.png
# 回报：BROWSER_RESULT 含截图路径
```

### 例 3：在已登录的飞书里复制一段文本

> 用户：把当前飞书文档第一段复制出来

AI 执行：
```bash
# 先读 domain-skills 看有没有飞书的稳定选择器
cat agent-workspace/domain-skills/feishu/docs.md 2>/dev/null || true
# 假设里面记录了 selector
scripts/run.sh js 'document.querySelector("[data-page-content] .text-block").innerText'
```

### 例 4：体检

> 用户：现在 browser-harness 还能用吗

AI 执行：
```bash
scripts/run.sh doctor
# 把原文输出贴给用户
```

更多例子（多步表单、文件上传、iframe、跨标签页协同）见 [examples.md](examples.md)。

## 完整 API 参考

[reference.md](reference.md) 包含：

- 所有 `bhts` / `bh.*` 方法签名（导航、输入、JS、截图、标签、文件上传、CDP passthrough）
- `agent-workspace/agent_helpers.ts` 的热加载约定
- domain-skills 写法 rubric（map vs diary）
- 多 Agent 命名空间（`BU_NAME`）
- Python 与 TS Agent 共享同一 Chrome 的工作流

## 安装与依赖

详见 [setup.md](setup.md)。简版：

```bash
# 一次性
scripts/run.sh setup     # 安装 uv tool + 全局 bhts CLI + 引导 browser-harness --setup

# 验证
scripts/run.sh doctor
```

## 安全说明

- **本 skill 不发送任何浏览数据到远程**——所有 CDP 流量在本机 Chrome ↔ 本机 Python 守护进程 ↔ 本机 Node 客户端之间。
- **AI 看到的就是用户当前的浏览器**：登录态、cookie、history、saved password 全部对 AI 可见。涉及敏感页面（银行 / 邮箱 / 内部系统）前必须**显式确认用户授权**，并优先用 `js` 只读取明确字段而非整页 dump。
- **截图同理**：`shot` 命令会把当前页面 PNG 写到本地路径；不要把它上传到任何远程服务（包括日志/分析平台）除非用户授权。
- **守护进程监听本机 socket**（默认 `~/.cache/browser-harness/<name>.sock` 或 Windows TCP loopback）——不接受远程连接。
- **多用户机器**：守护进程的 socket 权限默认 600，但 Chrome CDP 端口（9222）默认 listen on `127.0.0.1`，本机其他用户可以接管。共享机器请额外审计。
