#!/usr/bin/env bash
# browser-harness skill — single entry, dispatches subcommands to bhts.
#
# Usage:
#   scripts/run.sh setup
#   scripts/run.sh doctor
#   scripts/run.sh js   '<expr>'
#   scripts/run.sh exec '<bhts snippet>'
#   scripts/run.sh shot [--full] [path]
#   scripts/run.sh page
#   scripts/run.sh tabs
#   scripts/run.sh open '<url>'
#   scripts/run.sh switch '<keyword>'
#   scripts/run.sh upload '<selector>' '<abs-path>'
#   scripts/run.sh click  <x> <y>
#   scripts/run.sh type   '<text>'
#   scripts/run.sh key    '<Enter|Tab|...>'
#   scripts/run.sh scroll <dy>
#   scripts/run.sh helpers
#   scripts/run.sh raw    -c '<...>'
#   scripts/run.sh help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$SCRIPT_DIR/lib/runner.mjs"

blue()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
green() { printf "\033[1;32m ok\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m!!!\033[0m %s\n" "$*" >&2; }
fail()  { printf "\033[1;31mERR\033[0m %s\n" "$*" >&2; exit 1; }

show_help() {
  cat <<'EOF'
browser-harness skill v0.1.0
==> 让 LLM Agent 通过 CDP 接管用户已登录的真实 Chrome

用法:
  scripts/run.sh <subcommand> [args]

子命令:
  setup                          一次性安装 + 引导接管 Chrome
  doctor                         体检：依赖 / 守护进程 / 当前页

  js   '<expr>'                  在当前标签跑一段 JS，返回 JSON 结果
  exec '<snippet>'               跑任意 bhts -c snippet（bh / h 已就绪）
  raw  -c '<snippet>' ...        透传到 bhts，传任意 bhts 参数

  page                           当前页 url/title/viewport/scroll/pageSize
  tabs                           列出真实标签
  open '<url>'                   新建标签 + waitForLoad
  switch '<keyword>'             切到 url/title 含关键词的标签
  shot [--full] [path]           截图（默认 ./shot.png）

  click <x> <y>                  视口坐标点击（不推荐）
  type  '<text>'                 在焦点元素插入文本
  key   '<Enter|Tab|Esc|...>'    按下单键
  scroll <dy>                    滚动 dy 像素（负值向上）

  upload '<selector>' '<abs-path>'   给 input[type=file] 设文件
  helpers                            列已注册的自定义 helpers
  help                               本帮助

环境变量:
  BU_NAME             守护进程命名空间，默认 default（多 Agent 并行用）
  BH_AGENT_WORKSPACE  agent-workspace 目录覆盖

依赖:
  node >= 20.6.0、python >= 3.10、uv、bhts、browser-harness（PATH）
  缺什么 `scripts/run.sh setup` 会指引安装

详细 API: ./reference.md   常见任务: ./examples.md   安装: ./setup.md
EOF
}

# --- setup ---------------------------------------------------------------
do_setup() {
  blue "browser-harness skill setup"
  printf "\n"

  # 1. node
  if ! command -v node >/dev/null 2>&1; then
    warn "node 未安装。请先装 Node.js >= 20.6.0:"
    printf "    https://nodejs.org/  或  nvm install 20\n"
    fail "装好 node 后重跑: scripts/run.sh setup"
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
    fail "node 版本太低（$(node --version)），需要 >= 20.6.0"
  fi
  green "node $(node --version)"

  # 2. uv
  if ! command -v uv >/dev/null 2>&1; then
    warn "uv 未安装。任选一种:"
    printf "    curl -LsSf https://astral.sh/uv/install.sh | sh\n"
    printf "    brew install uv\n"
    fail "装好 uv 后重跑: scripts/run.sh setup"
  fi
  green "uv $(uv --version | awk '{print $2}')"

  # 3. browser-harness-ts (npm global)
  if ! command -v bhts >/dev/null 2>&1; then
    blue "npm install -g browser-harness-ts"
    npm install -g browser-harness-ts
  fi
  if ! command -v bhts >/dev/null 2>&1; then
    warn "bhts 仍不在 PATH。把 npm 全局 bin 加进 PATH:"
    printf '    echo '\''export PATH="$(npm prefix -g)/bin:$PATH"'\'' >> ~/.zshrc && source ~/.zshrc\n'
    fail "PATH 修好后重跑"
  fi
  green "bhts $(bhts --version 2>/dev/null | awk '{print $2}' || echo '?') ($(command -v bhts))"

  # 4. browser-harness (Python via uv tool)
  if ! command -v browser-harness >/dev/null 2>&1; then
    blue "uv tool install browser-harness"
    uv tool install --force browser-harness
  fi
  if ! command -v browser-harness >/dev/null 2>&1; then
    warn "browser-harness 仍不在 PATH。把 uv tool bin 加进 PATH:"
    printf '    echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.zshrc && source ~/.zshrc\n'
    fail "PATH 修好后重跑"
  fi
  green "browser-harness $(browser-harness --version 2>/dev/null || echo '?')"

  printf "\n"
  blue "下一步：把守护进程接到你正在用的 Chrome"
  printf "    browser-harness --setup\n"
  printf "\n"
  printf "接管完成后再跑:\n"
  printf "    scripts/run.sh doctor\n"
}

# --- doctor --------------------------------------------------------------
do_doctor() {
  EXIT=0

  if command -v node >/dev/null 2>&1; then
    green "node $(node --version)"
  else
    warn "node 缺失"; EXIT=1
  fi

  if command -v uv >/dev/null 2>&1; then
    green "uv $(uv --version | awk '{print $2}')"
  else
    warn "uv 缺失"; EXIT=1
  fi

  if command -v bhts >/dev/null 2>&1; then
    green "bhts $(bhts --version 2>/dev/null | awk '{print $2}' || echo '?') ($(command -v bhts))"
  else
    warn "bhts 缺失"; EXIT=1
  fi

  if command -v browser-harness >/dev/null 2>&1; then
    green "browser-harness $(browser-harness --version 2>/dev/null || echo '?') ($(command -v browser-harness))"
  else
    warn "browser-harness 缺失"; EXIT=1
  fi

  if [ "$EXIT" -ne 0 ]; then
    warn "依赖不完整。跑: scripts/run.sh setup"
    return $EXIT
  fi

  # 守护 + 当前标签
  blue "尝试连接守护进程并读取当前标签..."
  if bhts -c '
    try {
      const info = await bh.pageInfo();
      const tab = await bh.currentTab();
      console.log(JSON.stringify({
        ok: true,
        daemon: bh.name,
        log: bh.logPath,
        url: info.url || tab.url,
        title: info.title || tab.title,
        viewport: info.w ? `${info.w}x${info.h}` : null
      }, null, 2));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: String(e.message || e) }, null, 2));
      process.exit(2);
    }
  '; then
    green "守护进程在跑且接管 Chrome 成功"
  else
    warn "守护进程没起或没接 Chrome——跑: browser-harness --setup"
    EXIT=1
  fi

  exit $EXIT
}

# --- 子命令分发 ----------------------------------------------------------
SUB="${1:-help}"
shift || true

case "$SUB" in
  -h|--help|help)   show_help ;;
  setup)            do_setup ;;
  doctor)           do_doctor ;;

  # 其它子命令统一走 Node runner —— 拼 bhts -c 的逻辑放那里更易读
  js|exec|page|tabs|open|switch|shot|click|type|key|scroll|upload|helpers)
    exec node "$RUNNER" "$SUB" "$@"
    ;;

  raw)
    # 直接转发到 bhts，不加任何包装
    if ! command -v bhts >/dev/null 2>&1; then
      fail "bhts 未安装。跑: scripts/run.sh setup"
    fi
    exec bhts "$@"
    ;;

  *)
    warn "未知子命令: $SUB"
    show_help
    exit 2
    ;;
esac
