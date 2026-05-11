#!/usr/bin/env bash
# scripts/safe-shell.sh — sourceable safety wrapper for browser-harness skill
#
# 用法（必须 source 进当前 shell，不能直接执行）：
#
#   source /Users/siping/Documents/AI/2026/browser-harness-skill/scripts/safe-shell.sh
#
# 之后用 `bh` 替代 `scripts/run.sh`：
#
#   bh page                # 只读：直接跑
#   bh tabs
#   bh shot
#   bh exec '<snippet>'    # 写性可疑：先打印命令，等 y/N 确认
#   bh upload sel /tmp/x   # 同上
#
# 卸载（解开 trap、删函数）：
#
#   bh-safe-unload
#
# ──────────────────────────────────────────────────────────────────────────
# 五条 ClawScan finding 对应缓解（与 SKILL.md 的内置防御层叠加）：
#
#   F1. Identity and Privilege Abuse (High)
#       → 强制 BH_PUBLIC_ONLY=1，仅允许 publicSites allow-list 内域名
#       → 启动时再次提醒用独立 Chrome profile，不要复用日常浏览器
#
#   F2. Tool Misuse and Exploitation (High)
#       → 写性可疑子命令（exec/upload/click/type/key/scroll/open/js）
#         调用前要求人工 y/N 确认（agent 自动调用会卡住，正是设计意图）
#       → raw 子命令直接拦截
#       → 每次调用前 unset BH_RAW_OK / BH_ALLOW_SENSITIVE，挡掉外部环境注入
#       → 拦截 --i-understand-sensitive 单命令绕过
#
#   F3. Rogue Agents (Med) —— 守护进程长寿命
#       → 在当前 shell 注册 EXIT trap，shell 退出时自动 scripts/run.sh stop
#
#   F4. Memory and Context Poisoning (Med)
#       → 启动时检查 agent-workspace/ 是否被 git 跟踪（应该在 .gitignore）
#
#   F5. Supply Chain (Low)
#       → 启动时验证 bhts / browser-harness 实际版本与 run.sh 钉死的一致
#
# ──────────────────────────────────────────────────────────────────────────
# 适用范围：
#   - 给"人 + agent 协作"的会话用。完全无人值守的 agent 跑批不适合（会卡 read）。
#   - 不取代 SKILL.md 内置的 sensitive-deny + audit-log，只是在外层多加一道闸。
#   - 如果你**确实**需要绕过（比如要 raw、要操作敏感站点），不要在这个 wrapper
#     里加开关——直接新开一个 shell 用 scripts/run.sh，让责任边界明确。

# --- 防止被 exec 调用 ---------------------------------------------------------
( return 0 2>/dev/null ) || {
  printf '\033[1;31mERR\033[0m safe-shell.sh 必须 source 而非直接执行：\n' >&2
  printf '    source %s\n' "$0" >&2
  exit 1
}

# --- 找到 SKILL_ROOT（兼容 bash 和 zsh）---------------------------------------
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  _BH_SAFE_SRC="${BASH_SOURCE[0]}"
else
  _BH_SAFE_SRC="$0"
fi
_BH_SAFE_SCRIPTS_DIR="$(cd "$(dirname "$_BH_SAFE_SRC")" 2>/dev/null && pwd)"
_BH_SAFE_SKILL_ROOT="$(cd "$_BH_SAFE_SCRIPTS_DIR/.." 2>/dev/null && pwd)"
_BH_SAFE_RUN="$_BH_SAFE_SCRIPTS_DIR/run.sh"

if [ ! -x "$_BH_SAFE_RUN" ]; then
  printf '\033[1;31mERR\033[0m 找不到可执行的 %s\n' "$_BH_SAFE_RUN" >&2
  printf '    safe-shell.sh 必须放在 skill 的 scripts/ 目录下\n' >&2
  unset _BH_SAFE_SRC _BH_SAFE_SCRIPTS_DIR _BH_SAFE_SKILL_ROOT _BH_SAFE_RUN
  return 1 2>/dev/null || true
fi

# --- 颜色辅助 -----------------------------------------------------------------
_bh_blue()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
_bh_green() { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
_bh_warn()  { printf '\033[1;33m!!!\033[0m %s\n' "$*" >&2; }
_bh_fail()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; }

# --- 提取 run.sh 钉死的版本 ---------------------------------------------------
_bh_pinned_version() {
  # $1 = BHTS_PKG_VERSION | PYTHON_BH_PKG_VERSION
  awk -v key="$1" '
    $0 ~ "^"key"=" {
      sub("^"key"=", "");
      gsub("\"", "");
      print;
      exit
    }
  ' "$_BH_SAFE_RUN"
}

# --- 启动检查 ------------------------------------------------------------------
_bh_safe_init() {
  _bh_blue "browser-harness safe-shell 已加载"
  _bh_blue "  SKILL_ROOT      = $_BH_SAFE_SKILL_ROOT"
  _bh_blue "  BH_PUBLIC_ONLY  = 1 (强制 publicSites allow-list)"
  _bh_blue "  写操作确认       = 开（exec/upload/click/type/key/scroll/open/js）"
  _bh_blue "  退出自动 stop    = 开（EXIT trap → scripts/run.sh stop）"

  # F4: agent-workspace/ 不应进 git
  if [ -d "$_BH_SAFE_SKILL_ROOT/.git" ] && command -v git >/dev/null 2>&1; then
    if ( cd "$_BH_SAFE_SKILL_ROOT" && \
         git ls-files --error-unmatch agent-workspace/ >/dev/null 2>&1 ); then
      _bh_warn "F4: agent-workspace/ 被 git 跟踪——请加入 .gitignore（防 Memory Poisoning）"
    else
      _bh_green "F4: agent-workspace/ 未被 git 跟踪"
    fi
  fi

  # F5: 实际版本 vs 钉死版本
  local _bhts_pin _bhts_actual _pybh_pin _pybh_actual
  _bhts_pin="$(_bh_pinned_version BHTS_PKG_VERSION)"
  _pybh_pin="$(_bh_pinned_version PYTHON_BH_PKG_VERSION)"
  if command -v bhts >/dev/null 2>&1; then
    _bhts_actual="$(bhts --version 2>/dev/null | awk '{print $2}' || echo '?')"
    if [ "$_bhts_actual" = "$_bhts_pin" ]; then
      _bh_green "F5: bhts $_bhts_actual = pinned $_bhts_pin"
    else
      _bh_warn "F5: bhts 实际 $_bhts_actual ≠ 钉死 $_bhts_pin（请重跑 scripts/run.sh setup）"
    fi
  else
    _bh_warn "F5: bhts 未安装——跑 scripts/run.sh setup"
  fi
  if command -v browser-harness >/dev/null 2>&1; then
    _pybh_actual="$(browser-harness --version 2>/dev/null || echo '?')"
    if [ "$_pybh_actual" = "$_pybh_pin" ]; then
      _bh_green "F5: browser-harness $_pybh_actual = pinned $_pybh_pin"
    else
      _bh_warn "F5: browser-harness 实际 $_pybh_actual ≠ 钉死 $_pybh_pin"
    fi
  else
    _bh_warn "F5: browser-harness 未安装——跑 scripts/run.sh setup"
  fi

  # F1: 提醒独立 profile
  printf '\n'
  _bh_warn "F1 提醒：用独立 Chrome profile，不要把日常浏览器（银行/邮箱/SSO）暴露给 agent。"
  printf '    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n'
  printf '      --user-data-dir="$HOME/.cache/chrome-bh-profile" \\\n'
  printf '      --remote-debugging-port=9222\n'
  printf '\n'
  _bh_blue "用法：bh page | bh tabs | bh exec '...' | bh-safe-unload"
}

# --- F3: shell 退出时自动 stop -----------------------------------------------
_bh_safe_cleanup() {
  if command -v browser-harness >/dev/null 2>&1; then
    _bh_blue "[safe-shell] shell 退出，自动停止守护进程..."
    "$_BH_SAFE_RUN" stop >/dev/null 2>&1 || true
  fi
}

# 注意：这会覆盖你已有的 EXIT trap。如果有别的 EXIT trap，请手动合并。
trap '_bh_safe_cleanup' EXIT

# --- 主函数 bh ----------------------------------------------------------------
bh() {
  local _sub="${1:-help}"
  shift 2>/dev/null || true

  # F2: 拦截 --i-understand-sensitive
  local _arg
  for _arg in "$@"; do
    case "$_arg" in
      --i-understand-sensitive)
        _bh_fail "safe-shell 拒绝 --i-understand-sensitive。"
        _bh_fail "如确需操作敏感站点，请在新 shell 直接：scripts/run.sh $_sub ..."
        return 2
        ;;
    esac
  done

  # F2: 拦截 raw
  if [ "$_sub" = "raw" ]; then
    _bh_fail "safe-shell 拒绝 raw 子命令（绕过 sensitive-deny + 完整 audit）。"
    _bh_fail "如确需 raw，请在新 shell：BH_RAW_OK=1 scripts/run.sh raw -c '...'"
    return 2
  fi

  # F1 + F2: 强制 PUBLIC_ONLY，清空敏感开关（保存→设置→还原）
  local _saved_pub="${BH_PUBLIC_ONLY-__unset__}"
  local _saved_raw="${BH_RAW_OK-__unset__}"
  local _saved_sens="${BH_ALLOW_SENSITIVE-__unset__}"
  export BH_PUBLIC_ONLY=1
  unset BH_RAW_OK BH_ALLOW_SENSITIVE

  # F2: 写性可疑子命令需 y/N 确认
  case "$_sub" in
    exec|upload|click|type|key|scroll|open|js)
      _bh_warn "[safe-shell] 即将执行写操作：bh $_sub $*"
      printf '    继续？[y/N] '
      local _ans
      IFS= read -r _ans
      if [ "$_ans" != "y" ] && [ "$_ans" != "Y" ]; then
        _bh_warn "已取消"
        _bh_safe_restore_env "$_saved_pub" "$_saved_raw" "$_saved_sens"
        return 130
      fi
      ;;
  esac

  # 调用真正的 run.sh
  "$_BH_SAFE_RUN" "$_sub" "$@"
  local _rc=$?

  _bh_safe_restore_env "$_saved_pub" "$_saved_raw" "$_saved_sens"
  return $_rc
}

_bh_safe_restore_env() {
  # $1=BH_PUBLIC_ONLY 之前的值（__unset__ 表示未设置），$2=BH_RAW_OK，$3=BH_ALLOW_SENSITIVE
  if [ "$1" = "__unset__" ]; then unset BH_PUBLIC_ONLY;     else export BH_PUBLIC_ONLY="$1"; fi
  if [ "$2" = "__unset__" ]; then unset BH_RAW_OK;           else export BH_RAW_OK="$2"; fi
  if [ "$3" = "__unset__" ]; then unset BH_ALLOW_SENSITIVE;  else export BH_ALLOW_SENSITIVE="$3"; fi
}

# --- 卸载 ---------------------------------------------------------------------
bh-safe-unload() {
  trap - EXIT
  unset -f bh _bh_blue _bh_green _bh_warn _bh_fail _bh_pinned_version \
            _bh_safe_init _bh_safe_cleanup _bh_safe_restore_env bh-safe-unload 2>/dev/null
  unset _BH_SAFE_SRC _BH_SAFE_SCRIPTS_DIR _BH_SAFE_SKILL_ROOT _BH_SAFE_RUN
  echo "[safe-shell] 已卸载（EXIT trap 已解开，bh 函数已移除）"
}

# --- 启动 ---------------------------------------------------------------------
_bh_safe_init
