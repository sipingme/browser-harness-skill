# browser-harness-skill

> 把 [`browser-harness-ts`](https://github.com/sipingme/browser-harness-ts) +
> [`browser-use/browser-harness`](https://github.com/browser-use/browser-harness)
> 封装成一个 OpenClaw / ClawHub Skill，让任何 LLM Agent（Cursor、Claude Code、
> OpenClaw、Codex …）都能一句话接到**用户已登录的真实 Chrome**。

## 这个 Skill 干什么

不开新窗口、不清 cookie、不弹隐私模式——直接接到用户**当前正在用的** Chrome
上跑 JS、点击、滚动、截图、读 DOM、填表、上传文件。Python 与 TypeScript
Agent 同时操作同一个浏览器，共享登录态。

```
┌──────────────┐        ┌──────────────────┐        ┌────────────────────┐
│ AI Agent     │ ─────▶ │ Python daemon    │ ─────▶ │ Real Chrome (CDP)  │
│ (任意框架)   │  unix  │ (browser-harness)│   ws   │  用户已登录的那个  │
└──────────────┘  sock  └──────────────────┘        └────────────────────┘
```

## 致谢

所有难点（Chrome attach、CDP 握手、对话框处理、stale-session 恢复、profile
discovery、76 个站点 domain-skills）都来自 [Browser Use](https://browser-use.com)
团队的 [`browser-use/browser-harness`](https://github.com/browser-use/browser-harness)
项目（MIT License, Copyright © 2026 Browser Use）。本 skill 只是把它的
TypeScript 客户端 [`browser-harness-ts`](https://github.com/sipingme/browser-harness-ts)
+ Python CLI 包成 OpenClaw 标准 skill 格式，让 ClawHub 用户能 `openclaw skills install browser-harness` 直接用。

如果觉得有用，请给上游 [`browser-use/browser-harness`](https://github.com/browser-use/browser-harness)
点 star——真正的工作在那里。

## 文件结构

```
browser-harness-skill/
├── SKILL.md          ← 给 Agent 的核心使用说明（在 ClawHub 列表页公开展示）
├── config.json       ← OpenClaw / ClawHub 元数据（命令、依赖、权限、风险）
├── reference.md      ← 完整 API 参考（Agent 按需读）
├── examples.md       ← 常见任务示例
├── setup.md          ← 详细安装文档
├── README.md         ← 本文件（人类读者向）
├── LICENSE           ← MIT
├── .gitignore
└── scripts/
    ├── run.sh        ← Skill 唯一入口：setup / doctor / js / exec / shot / ...
    └── lib/
        └── runner.mjs  ← Node 端把子命令转换成 bhts -c 调用
```

## 安装到 OpenClaw 工作区

```bash
# 从 ClawHub
openclaw skills install browser-harness

# 或本地开发
git clone https://github.com/sipingme/browser-harness-skill ./skills/browser-harness
```

第一次用：

```bash
cd skills/browser-harness
scripts/run.sh setup       # 装 bhts + browser-harness CLI 到 PATH
scripts/run.sh doctor      # 体检
```

详见 [setup.md](setup.md)。

## 给 Skill 作者：发布到 ClawHub

```bash
# 装 ClawHub CLI
npm i -g clawhub
clawhub login

# 在本目录跑（需要先 bump SKILL.md 顶部的 version 字段）
cd browser-harness-skill
clawhub skill publish .          # 默认从 SKILL.md frontmatter 取 name/version
```

或非交互：

```bash
clawhub skill publish . \
  --slug browser-harness \
  --name "browser-harness" \
  --version 0.1.0 \
  --tags latest,browser,automation
```

发布前自检：

- [ ] `SKILL.md` 顶部 frontmatter 含 `name`、`description`、`version`
- [ ] `version` 比上一次发布递增（semver）
- [ ] `SKILL.md` 体内没有 `OPENCLAW_…`、`Bearer …`、`sk-…` 等敏感字符串
- [ ] `scripts/run.sh` 可执行（`chmod +x`）
- [ ] 本地跑过 `scripts/run.sh setup && scripts/run.sh doctor`

## 与 browser-harness-ts 的关系

| 项目 | 角色 |
|---|---|
| `browser-use/browser-harness` (Python) | 真正持有 CDP WebSocket 的守护进程；上游 76 个 domain-skills 仓库 |
| `browser-harness-ts` (npm) | TypeScript 客户端 + `bhts -c '...'` CLI，本 skill 的运行时依赖 |
| `browser-harness-skill` (本仓库) | OpenClaw / ClawHub 的标准 skill 包装，让 LLM Agent 能直接调，沉淀知识到 `agent-workspace/domain-skills/` |

本 skill **不重写**任何浏览器控制逻辑——它只是把 `bhts -c '...'` 包成 `scripts/run.sh <subcmd>`，并补一份给 Agent 读的使用约定。

## License

MIT — 同上游一致，但版权归本 skill 作者（见 [LICENSE](LICENSE)）。上游 Python
代码版权归 Browser Use（见 `browser-harness` 包的 LICENSE）。
