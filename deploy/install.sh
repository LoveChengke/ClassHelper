#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 班级小助手 · 服务端 Linux 一键安装器
#
# 支持：Ubuntu 20.04+ / Debian 11+ / CentOS 7+ / Rocky Linux / AlmaLinux 8+
#       （自动识别 apt / yum / dnf；直接安装形态要求 systemd）
#
# 两种形态：
#   native（默认）—— 装成 systemd 服务，自带 Node 运行时，SQLite 或 MySQL
#   docker        —— 用随包的 Dockerfile 构建镜像 + compose 起容器（需要 docker）
#
# 用法：
#   sudo bash install.sh                      # 交互式（TUI 菜单 + 问答）
#   sudo bash install.sh --check              # 只体检（不需要 root，不改动任何东西）
#   sudo bash install.sh --uninstall          # 卸载（会问保留什么）
#
#   自动化 / 验收常用参数（给了参数就不问对应的问题）：
#     --mode native|docker        安装形态
#     --dir /opt/classhelper      安装目录
#     --port 4000                 服务端口
#     --database sqlite|mysql     数据库
#     --mysql-host/-port/-db/-user/-password-stdin
#     --admin-password-stdin      从 stdin 读一行作为初始管理员密码（不进 argv / history）
#     --package <url|file://路径> 服务端安装包（默认从 GitHub Release 取最新版）
#     --sha256 <哈希>             安装包校验值（给了就强制校验）
#     --node-source bundled|system|tarball   Node 运行时来源（默认 bundled）
#     --node-mirror <url>          Node 下载镜像（默认 https://npmmirror.com/mirrors/node）
#     --node-tarball <url|路径>    直接用指定的 Node 压缩包（内网离线场景）
#     --with-nginx                 顺带放一份 Nginx 反代配置（不自动申请证书）
#     --open-firewall              按检测到的防火墙放行端口
#     --yes                        全部用默认值，不再交互（CI / 验收用）
#
# 幂等：重复执行 = 覆盖安装。已有 config.env（含 JWT_SECRET）与 data/ 一律保留，不重置密钥。
# 日志：/var/log/classhelper/install.log
# ---------------------------------------------------------------------------
set -euo pipefail

# ---------------------------------------------------------------- 集中变量

PRODUCT="班级小助手"
SERVICE_NAME="classhelper"

INSTALL_DIR="/opt/classhelper"
CONFIG_DIR="/etc/classhelper"
CONFIG_FILE="${CONFIG_DIR}/config.env"
LOG_DIR="/var/log/classhelper"
BACKUP_DIR="/var/backups/classhelper"
BIN_DIR="/usr/local/bin"
SERVICE_USER="classhelper"
SERVICE_GROUP="classhelper"
PORT="4000"
MODE="native"
DB_KIND="sqlite"
MYSQL_HOST="127.0.0.1"
MYSQL_PORT="3306"
MYSQL_DB="classhelper"
MYSQL_USER="classhelper"
MYSQL_PASSWORD=""

# 服务端安装包（默认取 GitHub Release 上的 Linux 资产）
REPO_SLUG="LoveChengke/ClassHelper"
GITHUB_RELEASES_PAGE="https://github.com/${REPO_SLUG}/releases"
PACKAGE_URL=""
PACKAGE_SHA256=""
VERSION=""
STAGE_DIR=""

# Node 运行时
NODE_MAJOR="22"
NODE_SOURCE="bundled"
NODE_MIRROR="https://npmmirror.com/mirrors/node"
NODE_TARBALL=""
NODE_DIR_NAME="runtime/node"

WITH_NGINX=0
OPEN_FIREWALL=0
ASSUME_YES=0
CHECK_ONLY=0
UNINSTALL=0
ADMIN_PASSWORD=""
ADMIN_PASSWORD_FROM_STDIN=0
INSTALL_DOCKER=0
FORCE=0

LOG_FILE="${LOG_DIR}/install.log"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"

# ---------------------------------------------------------------- 输出

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_MAGENTA=$'\033[35m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_CYAN=''; C_MAGENTA=''
fi

log()  { printf '%s[classhelper]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '%s[classhelper]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
step() { printf '\n%s▶ %s%s\n' "$C_MAGENTA" "$*" "$C_RESET"; }
warn() { printf '%s[classhelper]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { trap - ERR; printf '%s[classhelper]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

on_error() {
  local code=$?
  printf '\n%s[classhelper]%s 安装中断（第 %s 行，退出码 %s）\n' "$C_RED" "$C_RESET" "$1" "$code" >&2
  if [ -f "$LOG_FILE" ]; then printf '完整日志：%s\n' "$LOG_FILE" >&2; fi
  exit "$code"
}
trap 'on_error "$LINENO"' ERR

banner() {
  printf '\n%s' "$C_CYAN"
  cat <<'ASCII'
   ██████╗██╗      █████╗ ███████╗███████╗██╗  ██╗███████╗██╗     ██████╗ ███████╗██████╗
  ██╔════╝██║     ██╔══██╗██╔════╝██╔════╝██║  ██║██╔════╝██║     ██╔══██╗██╔════╝██╔══██╗
  ██║     ██║     ███████║███████╗███████╗███████║█████╗  ██║     ██████╔╝█████╗  ██████╔╝
  ██║     ██║     ██╔══██║╚════██║╚════██║██╔══██║██╔══╝  ██║     ██╔═══╝ ██╔══╝  ██╔══██╗
  ╚██████╗███████╗██║  ██║███████║███████║██║  ██║███████╗███████╗██║     ███████╗██║  ██║
   ╚═════╝╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝
ASCII
  printf '%s  %s · 服务端 Linux 安装器%s\n' "$C_BOLD" "$PRODUCT" "$C_RESET"
  printf '%s  一键安装 + classhelper 运维命令（status / password / upgrade / backup …）%s\n\n' "$C_DIM" "$C_RESET"
}

# 打印文件头部注释里的用法（第一个分隔线之后、第二个分隔线之前）
usage() {
  awk 'NR == 1 { next }
       /^# -{10,}/ { seen++; if (seen == 2) exit; next }
       seen == 1 { sub(/^# ?/, ""); print }' "$SCRIPT_PATH"
}

# ---------------------------------------------------------------- 参数解析

read_stdin_line() { IFS= read -r "$1" || true; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode) MODE="${2:-}"; shift 2 ;;
      --dir) INSTALL_DIR="${2:-}"; shift 2 ;;
      --port) PORT="${2:-}"; shift 2 ;;
      --user) SERVICE_USER="${2:-}"; SERVICE_GROUP="${2:-}"; shift 2 ;;
      --database) DB_KIND="${2:-}"; shift 2 ;;
      --mysql-host) MYSQL_HOST="${2:-}"; shift 2 ;;
      --mysql-port) MYSQL_PORT="${2:-}"; shift 2 ;;
      --mysql-db) MYSQL_DB="${2:-}"; shift 2 ;;
      --mysql-user) MYSQL_USER="${2:-}"; shift 2 ;;
      --mysql-password) MYSQL_PASSWORD="${2:-}"; shift 2 ;;
      --mysql-password-stdin) read_stdin_line MYSQL_PASSWORD; shift ;;
      --admin-password-stdin) ADMIN_PASSWORD_FROM_STDIN=1; shift ;;
      --package) PACKAGE_URL="${2:-}"; shift 2 ;;
      --sha256) PACKAGE_SHA256="${2:-}"; shift 2 ;;
      --version) VERSION="${2:-}"; shift 2 ;;
      --node-source) NODE_SOURCE="${2:-}"; shift 2 ;;
      --node-mirror) NODE_MIRROR="${2:-}"; shift 2 ;;
      --node-tarball) NODE_TARBALL="${2:-}"; NODE_SOURCE="tarball"; shift 2 ;;
      --with-nginx) WITH_NGINX=1; shift ;;
      --open-firewall) OPEN_FIREWALL=1; shift ;;
      --install-docker) INSTALL_DOCKER=1; shift ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      --force) FORCE=1; shift ;;
      --check) CHECK_ONLY=1; shift ;;
      --uninstall|--remove) UNINSTALL=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数：$1（--help 看用法）" ;;
    esac
  done
  case "$MODE" in native|docker) ;; *) die "--mode 只能是 native 或 docker" ;; esac
  case "$DB_KIND" in sqlite|mysql) ;; *) die "--database 只能是 sqlite 或 mysql" ;; esac
  case "$NODE_SOURCE" in bundled|system|tarball) ;; *) die "--node-source 只能是 bundled / system / tarball" ;; esac
  case "$INSTALL_DIR" in
    /) die "安装目录不能是 /" ;;
    /usr|/usr/*|/etc|/etc/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/boot|/boot/*) die "安装目录不能是系统目录：${INSTALL_DIR}" ;;
    /*) ;;
    *) die "安装目录必须是绝对路径：${INSTALL_DIR}" ;;
  esac
}

# ---------------------------------------------------------------- 环境探测

OS_ID=""; OS_VER=""; OS_NAME=""; PKG=""
detect_os() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_VER="${VERSION_ID:-}"
    OS_NAME="${PRETTY_NAME:-${OS_ID} ${OS_VER}}"
  else
    OS_NAME="$(uname -s) $(uname -r)"
  fi
  if command -v apt-get >/dev/null 2>&1; then PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then PKG="yum"
  else PKG=""
  fi
}

has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

pkg_install() {
  [ "$#" -gt 0 ] || return 0
  case "$PKG" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    *) warn "未识别包管理器，请手工安装：$*"; return 1 ;;
  esac
}

ensure_dependencies() {
  step "检查并补齐依赖"
  local missing=() tool
  for tool in curl tar gzip; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  command -v sha256sum >/dev/null 2>&1 || missing+=("coreutils")
  if [ "${#missing[@]}" -gt 0 ]; then
    info "缺少：${missing[*]}（用 ${PKG:-未识别的包管理器} 安装）"
    local pkgs=()
    for tool in "${missing[@]}"; do
      case "$tool" in
        curl) pkgs+=("curl") ;;
        tar) pkgs+=("tar") ;;
        gzip) pkgs+=("gzip") ;;
        coreutils) pkgs+=("coreutils") ;;
      esac
    done
    pkg_install "${pkgs[@]}" || die "依赖安装失败，请手工安装：${missing[*]}"
  fi
  command -v curl >/dev/null 2>&1 || die "缺少 curl，无法继续"
  log "依赖就绪（${PKG:-未知包管理器}）"
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p=":${port}\$" '$4 ~ p {found=1} END {exit !found}'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v p=":${port}\$" '$4 ~ p {found=1} END {exit !found}'
  else
    return 1
  fi
}

is_installed() { [ -f "${INSTALL_DIR}/.installed.json" ]; }

existing_version() {
  if [ -f "${INSTALL_DIR}/VERSION" ]; then tr -d '[:space:]' <"${INSTALL_DIR}/VERSION"; else printf '未知'; fi
}

config_value() { # $1=KEY：从已有配置里读一项（覆盖安装时沿用旧值）
  local key="$1"
  [ -f "$CONFIG_FILE" ] || return 0
  sed -n "s/^[[:space:]]*${key}=//p" "$CONFIG_FILE" | tail -n 1 | tr -d '"'"'"
}

# ---------------------------------------------------------------- 交互问答

ask() { # $1=提示 $2=默认值 $3=目标变量
  local prompt="$1" default="$2" var="$3" answer=""
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  if [ -n "$default" ]; then
    read -r -p "$(printf '%s[?]%s %s [%s]: ' "$C_CYAN" "$C_RESET" "$prompt" "$default")" answer || true
  else
    read -r -p "$(printf '%s[?]%s %s: ' "$C_CYAN" "$C_RESET" "$prompt")" answer || true
  fi
  printf -v "$var" '%s' "${answer:-$default}"
}

ask_secret() { # $1=提示 $2=目标变量（不回显）
  local prompt="$1" var="$2" value=""
  printf -v "$var" ''
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then return 0; fi
  read -r -s -p "$(printf '%s[?]%s %s' "$C_CYAN" "$C_RESET" "$prompt")" value || true
  printf '\n'
  printf -v "$var" '%s' "$value"
}

ask_yes_no() { # $1=提示 $2=默认 y/n；返回 0=是
  local prompt="$1" default="$2" answer=""
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    [ "$default" = "y" ]
    return
  fi
  read -r -p "$(printf '%s[?]%s %s [%s]: ' "$C_CYAN" "$C_RESET" "$prompt" "$default")" answer || true
  case "${answer:-$default}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

choose_mode_interactive() {
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then return 0; fi
  printf '%s请选择：%s\n' "$C_BOLD" "$C_RESET"
  printf '  1) 直接安装（systemd 服务 + 内置 Node 运行时，默认 SQLite）%s  ← 推荐%s\n' "$C_GREEN" "$C_RESET"
  printf '  2) 直接安装 + MySQL\n'
  printf '  3) Docker 部署（构建镜像 + compose 起容器）\n'
  printf '  4) 只体检（--check，不改动系统）\n'
  printf '  5) 卸载\n'
  local choice=""
  read -r -p "$(printf '%s[?]%s 输入序号 [1]: ' "$C_CYAN" "$C_RESET")" choice || true
  case "${choice:-1}" in
    1) MODE="native"; DB_KIND="sqlite" ;;
    2) MODE="native"; DB_KIND="mysql" ;;
    3) MODE="docker" ;;
    4) CHECK_ONLY=1 ;;
    5) UNINSTALL=1 ;;
    *) die "无效的选择：${choice}" ;;
  esac
  printf '\n'
}

collect_answers() {
  if [ "$CHECK_ONLY" = "1" ] || [ "$UNINSTALL" = "1" ] || [ "$ASSUME_YES" = "1" ]; then return 0; fi

  ask "安装目录" "$INSTALL_DIR" INSTALL_DIR
  ask "服务端口" "$PORT" PORT
  if [ "$MODE" = "native" ] && [ "$DB_KIND" = "sqlite" ]; then
    if ask_yes_no "改用 MySQL（默认 SQLite：单机够用，备份就是拷文件）？" "n"; then
      DB_KIND="mysql"
    fi
  fi
  if [ "$DB_KIND" = "mysql" ]; then
    ask "MySQL 主机" "$MYSQL_HOST" MYSQL_HOST
    ask "MySQL 端口" "$MYSQL_PORT" MYSQL_PORT
    ask "MySQL 库名" "$MYSQL_DB" MYSQL_DB
    ask "MySQL 用户名" "$MYSQL_USER" MYSQL_USER
    ask_secret "MySQL 密码（不回显）：" MYSQL_PASSWORD
  fi
  if [ "$NODE_SOURCE" = "bundled" ]; then
    if ask_yes_no "本机已装 Node ≥20.19 时改用系统 Node（不额外下载内置运行时）？" "n"; then
      NODE_SOURCE="system"
    fi
  fi
  if [ "$ADMIN_PASSWORD_FROM_STDIN" = "0" ] && [ -z "$ADMIN_PASSWORD" ]; then
    ask_secret "初始管理员（admin）密码（留空则用服务端默认 admin123；公网部署请务必设置）：" ADMIN_PASSWORD
  fi
  if ask_yes_no "顺带放一份 Nginx 反向代理配置到 ${CONFIG_DIR}/nginx.conf？" "n"; then WITH_NGINX=1; fi
  if ask_yes_no "按检测到的防火墙放行端口 ${PORT}？" "n"; then OPEN_FIREWALL=1; fi
}

# ---------------------------------------------------------------- 用户与目录

ensure_user() {
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "系统用户 ${SERVICE_USER} 已存在，跳过创建"
    return 0
  fi
  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    groupadd --system "$SERVICE_GROUP"
  fi
  useradd --system -g "$SERVICE_GROUP" -d "$INSTALL_DIR" -s /sbin/nologin -c "ClassHelper Server" "$SERVICE_USER" 2>/dev/null \
    || useradd --system -g "$SERVICE_GROUP" -d "$INSTALL_DIR" -s /usr/sbin/nologin -c "ClassHelper Server" "$SERVICE_USER"
  log "已创建系统用户 ${SERVICE_USER}"
}

ensure_dirs() {
  step "准备目录"
  mkdir -p "$INSTALL_DIR" "${INSTALL_DIR}/data" "${INSTALL_DIR}/logs" \
           "${INSTALL_DIR}/${NODE_DIR_NAME%/*}" "$CONFIG_DIR" "$LOG_DIR" "$BACKUP_DIR"
  chmod 700 "$CONFIG_DIR" "$LOG_DIR" "$BACKUP_DIR"
  # 配置目录归服务用户所有（Web 端「一键切换数据库」要改写 config.env）
  chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_DIR"
  chmod 755 "$INSTALL_DIR"
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "${INSTALL_DIR}/data" "${INSTALL_DIR}/logs"
  log "安装目录 ${INSTALL_DIR}｜配置 ${CONFIG_DIR}｜日志 ${LOG_DIR}｜备份 ${BACKUP_DIR}"
}

# ---------------------------------------------------------------- 安装包

asset_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) uname -m ;;
  esac
}

github_latest_tag() {
  local json
  json="$(curl -fsSL --max-time 20 -H 'User-Agent: ClassHelper-Installer' \
    "https://api.github.com/repos/${REPO_SLUG}/releases/latest" 2>/dev/null)" || return 1
  printf '%s' "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

resolve_package_url() {
  local tag="$VERSION" ver
  if [ -z "$tag" ]; then
    tag="$(github_latest_tag)" || true
    if [ -z "$tag" ]; then
      die "取不到 GitHub 最新版本（本机可能没有外网）。请用 --package 指定安装包，例如：
    sudo bash install.sh --package /tmp/classhelper-server-linux-x64-1.1.0.tar.gz"
    fi
  fi
  ver="${tag#v}"
  printf '%s/releases/download/%s/classhelper-server-linux-%s-%s.tar.gz' \
    "$GITHUB_RELEASES_PAGE" "$tag" "$(asset_arch)" "$ver"
}

# 下载 + 校验 + 解压；结果放进全局 STAGE_DIR（不用命令替换取，否则会把日志一起捕获）
fetch_package() {
  step "获取服务端安装包"
  local url="${PACKAGE_URL}"
  if [ -z "$url" ]; then url="$(resolve_package_url)"; fi

  local tmp; tmp="$(mktemp -d)"
  local pkg="${tmp}/classhelper-server.tar.gz"
  info "下载：${url}"
  case "$url" in
    file://*|/*|./*|../*) cp -f "${url#file://}" "$pkg" ;;
    *) curl -fSL --max-time 600 -H 'User-Agent: ClassHelper-Installer' -o "$pkg" "$url" ;;
  esac
  [ -s "$pkg" ] || die "安装包为空：${url}"

  local got; got="$(sha256sum "$pkg" | awk '{print $1}')"
  if [ -n "$PACKAGE_SHA256" ]; then
    [ "$got" = "$PACKAGE_SHA256" ] || die "sha256 校验失败：期望 ${PACKAGE_SHA256}，实际 ${got}"
    log "sha256 校验通过"
  else
    PACKAGE_SHA256="$got"
    info "sha256（未提供校验值，仅记录）：${got}"
  fi

  STAGE_DIR="${tmp}/pkg"
  mkdir -p "$STAGE_DIR"
  tar -xzf "$pkg" -C "$STAGE_DIR" --strip-components=1 || die "解压失败：安装包格式不对"
  [ -f "${STAGE_DIR}/server/dist/index.js" ] || die "安装包内容不对：缺少 server/dist/index.js"
  if [ -z "$VERSION" ] && [ -f "${STAGE_DIR}/VERSION" ]; then
    VERSION="$(tr -d '[:space:]' <"${STAGE_DIR}/VERSION")"
  fi
  [ -n "$VERSION" ] || VERSION="0.0.0"
  log "安装包就绪：v${VERSION}"
}

place_program_files() {
  local item
  step "铺开程序文件"
  for item in server web node_modules tools bin systemd logrotate.d profile.d \
              package.json VERSION README.txt Dockerfile nginx.conf classhelper.service.template .cross-built; do
    [ -e "${STAGE_DIR}/${item}" ] || continue
    rm -rf "${INSTALL_DIR:?}/${item}"
    cp -a "${STAGE_DIR}/${item}" "${INSTALL_DIR}/${item}"
  done
  chmod +x "${INSTALL_DIR}/bin/classhelper"
  chown -R root:root "${INSTALL_DIR}/server" "${INSTALL_DIR}/web" "${INSTALL_DIR}/node_modules" \
                     "${INSTALL_DIR}/tools" "${INSTALL_DIR}/bin" "${INSTALL_DIR}/systemd" 2>/dev/null || true
  log "程序文件已就位（server / web / node_modules / tools / bin）"
}

# ---------------------------------------------------------------- Node 运行时

node_runtime_version() { # $1=可执行文件；可用且 ≥20.19 时输出版本号
  [ -x "$1" ] || return 1
  local ver major minor
  ver="$("$1" -v 2>/dev/null)" || return 1
  major="$(printf '%s' "$ver" | sed 's/^v\([0-9]*\).*/\1/')"
  minor="$(printf '%s' "$ver" | sed 's/^v[0-9]*\.\([0-9]*\).*/\1/')"
  if [ "${major:-0}" -gt 20 ] || { [ "${major:-0}" -eq 20 ] && [ "${minor:-0}" -ge 19 ]; }; then
    printf '%s' "$ver"
    return 0
  fi
  return 1
}

# glibc 版本（形如 2.28）；判定不了就输出空串
glibc_version() {
  local out
  out="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
  if [ -n "$out" ]; then printf '%s' "${out##* }"; return 0; fi
  out="$(ldd --version 2>/dev/null | head -n 1 || true)"
  printf '%s' "$(printf '%s' "$out" | sed -n 's/.* \([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')"
}

# Node 官方 linux-x64 二进制要求 glibc ≥ 2.28（CentOS 7 是 2.17，直接跑不起来）
glibc_too_old() {
  local glibc="${1:-}"
  [ -n "$glibc" ] || return 1
  local major minor
  major="${glibc%%.*}"
  minor="$(printf '%s' "$glibc" | sed 's/^[0-9]*\.\([0-9]*\).*/\1/')"
  [ "${major:-0}" -lt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -lt 28 ]; }
}

setup_node() {
  step "准备 Node 运行时"
  local target="${INSTALL_DIR}/${NODE_DIR_NAME}"
  local existing=""
  if [ -x "${target}/bin/node" ]; then existing="$(node_runtime_version "${target}/bin/node" || true)"; fi
  if [ -n "$existing" ]; then
    log "已有内置 Node ${existing}，跳过下载"
    return 0
  fi

  if [ "$NODE_SOURCE" = "system" ]; then
    local sys_node ver=""
    sys_node="$(command -v node || true)"
    if [ -n "$sys_node" ]; then ver="$(node_runtime_version "$sys_node" || true)"; fi
    if [ -z "$ver" ]; then
      die "系统 Node 不可用或版本过低（要求 ≥20.19）。去掉 --node-source system 即可用内置运行时"
    fi
    rm -rf "$target"; mkdir -p "${target}/bin"
    ln -sfn "$sys_node" "${target}/bin/node"
    log "使用系统 Node ${ver}（${sys_node}）"
    return 0
  fi

  local work; work="$(mktemp -d)"
  local tarball="" sha="" filename=""
  if [ -n "$NODE_TARBALL" ]; then
    filename="$(basename "${NODE_TARBALL%%\?*}")"
    case "$NODE_TARBALL" in
      http*|file://*|/*) tarball="${work}/${filename}" ;;
      *) tarball="$NODE_TARBALL" ;;
    esac
    if [ "$tarball" != "$NODE_TARBALL" ]; then
      info "下载 Node：${NODE_TARBALL}"
      case "$NODE_TARBALL" in
        file://*|/*) cp -f "${NODE_TARBALL#file://}" "$tarball" ;;
        *) curl -fSL --max-time 600 -o "$tarball" "$NODE_TARBALL" ;;
      esac
    fi
  else
    local dist="${NODE_MIRROR%/}/latest-v${NODE_MAJOR}.x"
    local glibc; glibc="$(glibc_version)"
    if glibc_too_old "$glibc"; then
      # CentOS 7 这类老系统 glibc 2.17：Node 官方 x64 二进制（要求 ≥2.28）装了也起不来，
      # 历史上会表现成"装完服务立刻退出、日志里只有一行 Illegal instruction / GLIBC not found"。
      warn "本机 glibc ${glibc} < 2.28：Node 官方 linux-$(asset_arch) 二进制无法运行"
      warn "改用 unofficial-builds 的 glibc-217 构建（功能一致，只是编译基线更低）"
      dist="https://unofficial-builds.nodejs.org/download/release/latest-v${NODE_MAJOR}.x"
    fi
    info "读取 Node 版本清单：${dist}/SHASUMS256.txt"
    local sums="${work}/SHASUMS256.txt"
    curl -fsSL --max-time 60 -o "$sums" "${dist}/SHASUMS256.txt" \
      || die "下载 Node 校验清单失败（可用 --node-mirror 换镜像，或 --node-source system）"
    # 优先 .tar.gz：不需要 xz 解压工具
    filename="$(grep -oE "node-v[0-9.]+-linux-$(asset_arch)(-glibc-217)?\.tar\.gz" "$sums" | head -n 1)"
    if [ -z "$filename" ]; then
      filename="$(grep -oE "node-v[0-9.]+-linux-$(asset_arch)(-glibc-217)?\.tar\.xz" "$sums" | head -n 1)"
    fi
    [ -n "$filename" ] || die "校验清单里没找到 linux-$(asset_arch) 的 Node 包"
    sha="$(grep -E "[ *]${filename}\$" "$sums" | awk '{print $1}' | head -n 1)"
    tarball="${work}/${filename}"
    info "下载 Node：${dist}/${filename}"
    curl -fSL --max-time 600 -o "$tarball" "${dist}/${filename}" || die "下载 Node 失败"
  fi

  if [ -n "$sha" ]; then
    local got; got="$(sha256sum "$tarball" | awk '{print $1}')"
    [ "$got" = "$sha" ] || die "Node 压缩包 sha256 校验失败：期望 ${sha}，实际 ${got}"
    log "Node 压缩包校验通过（${filename}）"
  else
    warn "未校验 Node 压缩包哈希（自定义 --node-tarball 时拿不到校验值）"
  fi

  local extract="${work}/extract"
  mkdir -p "$extract"
  case "$tarball" in
    *.tar.xz) tar -xJf "$tarball" -C "$extract" || die "解压 Node 失败（需要 xz：apt/yum install xz）" ;;
    *) tar -xzf "$tarball" -C "$extract" || die "解压 Node 失败" ;;
  esac
  local inner; inner="$(find "$extract" -maxdepth 1 -mindepth 1 -type d | head -n 1)"
  [ -n "$inner" ] || die "Node 压缩包结构异常"

  rm -rf "$target"; mkdir -p "$target"
  cp -a "${inner}/." "$target/"
  if [ -z "$(node_runtime_version "${target}/bin/node" || true)" ]; then
    die "内置 Node 不可用或版本过低"
  fi
  log "内置 Node $("${target}/bin/node" -v) → ${target}"
  rm -rf "$work"
}

# ---------------------------------------------------------------- 配置文件

gen_secret() {
  local len="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$len"
  elif [ -x "${INSTALL_DIR}/${NODE_DIR_NAME}/bin/node" ]; then
    "${INSTALL_DIR}/${NODE_DIR_NAME}/bin/node" -e "process.stdout.write(require('node:crypto').randomBytes(${len}).toString('hex'))"
  else
    head -c "$len" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# URL 里这些字符会破坏连接串解析，做个最小百分号编码
url_encode() {
  printf '%s' "$1" | sed -e 's/%/%25/g' -e 's/@/%40/g' -e 's/:/%3A/g' -e 's|/|%2F|g' \
    -e 's/?/%3F/g' -e 's/#/%23/g' -e 's/ /%20/g'
}

database_url() {
  if [ "$MODE" = "docker" ] && [ "$DB_KIND" = "sqlite" ]; then
    # 容器里 serverRoot 是 /app/server，绝对路径最稳
    printf 'file:/app/data/classhelper.db'
  elif [ "$DB_KIND" = "mysql" ]; then
    printf 'mysql://%s:%s@%s:%s/%s' "$MYSQL_USER" "$(url_encode "$MYSQL_PASSWORD")" "$MYSQL_HOST" "$MYSQL_PORT" "$MYSQL_DB"
  else
    printf 'file:../data/classhelper.db'
  fi
}

write_config() {
  step "写入配置 ${CONFIG_FILE}"
  if [ -f "$CONFIG_FILE" ] && [ "$FORCE" != "1" ]; then
    log "检测到已有配置：保留（含 JWT_SECRET 与数据库设置），只补齐缺失项"
    local key value
    for key in NODE_ENV HOST AUTO_MIGRATE TRUST_PROXY; do
      case "$key" in
        NODE_ENV) value="production" ;;
        HOST) value="0.0.0.0" ;;
        AUTO_MIGRATE) value="true" ;;
        TRUST_PROXY) value="1" ;;
      esac
      if ! grep -qE "^[[:space:]]*${key}=" "$CONFIG_FILE"; then
        printf '\n%s=%s\n' "$key" "$value" >>"$CONFIG_FILE"
      fi
    done
    if ! grep -qE '^[[:space:]]*JWT_SECRET=.' "$CONFIG_FILE"; then
      printf '\nJWT_SECRET=%s\n' "$(gen_secret)" >>"$CONFIG_FILE"
    fi
    chmod 600 "$CONFIG_FILE"
    chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_FILE"
    return 0
  fi

  local jwt; jwt="$(gen_secret)"
  local admin_line=""
  if [ -n "$ADMIN_PASSWORD" ]; then
    # 明文落盘，与 .env 里其它密钥同级；文件权限 600，属主是服务用户
    admin_line="INITIAL_ADMIN_PASSWORD=${ADMIN_PASSWORD}"
  fi

  cat >"$CONFIG_FILE" <<EOF
# ---------------------------------------------------------------------------
# 班级小助手服务端配置（由 install.sh 生成于 $(date '+%F %T')）
#
# 这是**唯一的配置真身**：安装目录里的 .env 是指向本文件的软链，
# systemd 通过 EnvironmentFile 读本文件；改完执行 classhelper restart 生效。
#
# systemd / dotenv / shell source 三种读法都兼容；值含空白时请加双引号。
# 敏感项建议用 classhelper config set（交互输入，不进 shell history）。
# ---------------------------------------------------------------------------

NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}

# 数据库：sqlite（文件在安装目录 data/）或 mysql（连接串里含密码，注意保密）
DATABASE_PROVIDER=${DB_KIND}
DATABASE_URL="$(database_url)"
# 空库首次启动时自动执行随包迁移并创建管理员（SQLite 形态）
AUTO_MIGRATE=true

# 登录令牌签名密钥（随机生成，请勿泄露；轮换用 classhelper key rotate）
JWT_SECRET=${jwt}
JWT_EXPIRES_IN=7d

# 跨域来源：走域名 / 反代时建议改成具体来源，例如 https://class.example.com
CORS_ORIGIN=*
# 前面有 Nginx 等反向代理时设为 1，限流才会按真实客户端 IP 统计
TRUST_PROXY=1

RATE_LIMIT_ENABLED=true
STARTUP_DB_CHECK=true
LOG_LEVEL=info
BCRYPT_ROUNDS=10

# 首次初始化（空库）时创建的管理员
INITIAL_ADMIN_USERNAME=admin
${admin_line}

# 新建班级 / 重置教师账号时的默认密码（学生端用「班级码 + 班级密码」登录）
DEFAULT_CLASS_PASSWORD=123456
DEFAULT_TEACHER_PASSWORD=123456

# 第 1 教学周的周一（留空则按系统时间推算）；格式 YYYY-MM-DD
TERM_START_DATE=
EOF
  chmod 600 "$CONFIG_FILE"
  chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG_FILE"
  log "配置已写入（权限 600，含随机 JWT_SECRET）"
}

link_env_file() {
  # Web 端「数据库管理 → 一键切换」改写的是 <安装目录>/.env，而 systemd 注入的是 config.env；
  # 用软链把两者收成一份真身，否则切换看起来成功、重启后又连回旧库（详见 docs/linux-deploy.md）
  local link="${INSTALL_DIR}/.env"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    warn "安装目录里存在真实文件 .env，已改名保留为 .env.bak.$(date +%s) 再建立软链"
    mv "$link" "${link}.bak.$(date +%s)"
  fi
  ln -sfn "$CONFIG_FILE" "$link"
  log "已建立 ${link} → ${CONFIG_FILE}"
}

# ---------------------------------------------------------------- systemd

install_systemd_unit() {
  step "安装 systemd 服务单元"
  local node_bin="${INSTALL_DIR}/${NODE_DIR_NAME}/bin/node"
  local template="${INSTALL_DIR}/classhelper.service.template"
  if [ -f "$template" ]; then
    sed -e "s#__NODE__#${node_bin}#g" \
        -e "s#__DIR__#${INSTALL_DIR}#g" \
        -e "s#__USER__#${SERVICE_USER}#g" \
        -e "s#__CONFIG__#${CONFIG_FILE}#g" \
        -e "s#__CONFIGDIR__#${CONFIG_DIR}#g" \
        "$template" >"/etc/systemd/system/${SERVICE_NAME}.service"
  else
    cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ClassHelper Server (${PRODUCT}服务端)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${CONFIG_FILE}
ExecStart=${node_bin} server/dist/index.js
Restart=always
RestartSec=3
LimitNOFILE=65535
KillSignal=SIGTERM
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=${INSTALL_DIR} ${CONFIG_DIR}

[Install]
WantedBy=multi-user.target
EOF
  fi
  chmod 644 "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  log "已安装 /etc/systemd/system/${SERVICE_NAME}.service 并设为开机自启"
}

install_aux_files() {
  step "安装运维命令与辅助文件"
  ln -sfn "${INSTALL_DIR}/bin/classhelper" "${BIN_DIR}/classhelper"

  if [ -d /usr/share/bash-completion/completions ]; then
    "${INSTALL_DIR}/bin/classhelper" completion bash >/usr/share/bash-completion/completions/classhelper 2>/dev/null || true
    chmod 644 /usr/share/bash-completion/completions/classhelper 2>/dev/null || true
  fi

  if [ -f "${INSTALL_DIR}/logrotate.d/classhelper" ]; then
    install -m 644 "${INSTALL_DIR}/logrotate.d/classhelper" /etc/logrotate.d/classhelper
  fi

  if [ -f "${INSTALL_DIR}/profile.d/classhelper.sh" ]; then
    sed -e "s#__DIR__#${INSTALL_DIR}#g" \
        -e "s#__CONFIG__#${CONFIG_FILE}#g" \
        -e "s#__LOGDIR__#${LOG_DIR}#g" \
        -e "s#__BACKUPDIR__#${BACKUP_DIR}#g" \
        "${INSTALL_DIR}/profile.d/classhelper.sh" >/etc/profile.d/classhelper.sh
    chmod 644 /etc/profile.d/classhelper.sh
    log "已写入 /etc/profile.d/classhelper.sh"
  fi
  log "已安装 ${BIN_DIR}/classhelper（软链 → ${INSTALL_DIR}/bin/classhelper）"
}

write_meta() { # $1=来源
  cat >"${INSTALL_DIR}/.installed.json" <<EOF
{
  "version": "${VERSION}",
  "mode": "${MODE}",
  "database": "${DB_KIND}",
  "installDir": "${INSTALL_DIR}",
  "configFile": "${CONFIG_FILE}",
  "serviceUser": "${SERVICE_USER}",
  "logDir": "${LOG_DIR}",
  "backupDir": "${BACKUP_DIR}",
  "port": "${PORT}",
  "installedAt": "$(date -Iseconds)",
  "sourceUrl": "$1",
  "sha256": "${PACKAGE_SHA256}",
  "nodeSource": "${NODE_SOURCE}"
}
EOF
  chmod 600 "${INSTALL_DIR}/.installed.json"
}

# ---------------------------------------------------------------- Docker 形态

docker_available() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

install_docker_engine() {
  if docker_available; then return 0; fi
  if [ "$INSTALL_DOCKER" != "1" ] && [ "$ASSUME_YES" != "1" ]; then
    if ! ask_yes_no "未检测到可用的 Docker，是否用官方脚本安装 docker-ce？" "n"; then
      die "Docker 形态需要 docker；也可以改用 --mode native"
    fi
  fi
  info "通过 get.docker.com 安装 docker（官方脚本）"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || die "下载 Docker 安装脚本失败"
  sh /tmp/get-docker.sh >>"$LOG_FILE" 2>&1 || die "Docker 安装失败，详见 ${LOG_FILE}"
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker_available || die "Docker 装好了但连不上（docker info 失败）"
  log "Docker 已就绪：$(docker --version)"
}

write_compose() {
  local compose="${CONFIG_DIR}/compose.yml"
  cat >"$compose" <<EOF
# 班级小助手 · 由 install.sh 生成的 compose 文件（${MODE} 形态）
# 配置见 ${CONFIG_FILE}（改完执行 classhelper restart 重建容器）
# 数据在 Docker 卷 classhelper-data 里；备份用 classhelper backup
#
# 镜像用**稳定标签** classhelper-server:local：版本号写在这里的话，升级替换完程序文件后
# 这个标签就过期了，compose 会一直沿用旧镜像（表现为"升级成功但没有变化"）。
# classhelper 自己按 VERSION 决定要不要重建镜像，再 --force-recreate。
services:
  server:
    image: classhelper-server:local
    container_name: ${SERVICE_NAME}-server
    restart: unless-stopped
    env_file:
      - ${CONFIG_FILE}
    ports:
      - "${PORT}:${PORT}"
    volumes:
      - classhelper-data:/app/data
    extra_hosts:
      - "host.docker.internal:host-gateway"

volumes:
  classhelper-data:
    name: classhelper-data
EOF
  chmod 600 "$compose"
  log "已生成 ${compose}"
}

docker_build_image() {
  step "构建镜像 classhelper-server:local（版本 ${VERSION}）"
  [ -f "${INSTALL_DIR}/Dockerfile" ] || die "安装包缺少 Dockerfile（Docker 形态需要它）"
  # 构建上下文就是安装目录（node_modules 已是 linux 的真实目录，构建时无需联网装依赖）
  if ! docker build -t classhelper-server:local -t "classhelper-server:${VERSION}" \
        -f "${INSTALL_DIR}/Dockerfile" "$INSTALL_DIR" >>"$LOG_FILE" 2>&1; then
    tail -30 "$LOG_FILE" >&2 || true
    die "镜像构建失败，详见 ${LOG_FILE}"
  fi
  # 记下这个镜像对应的版本，classhelper 靠它判断要不要重建（避免每次 restart 都重新构建）
  printf '%s' "$VERSION" >"${INSTALL_DIR}/.docker-image-version"
  log "镜像已构建：classhelper-server:local（另打 tag classhelper-server:${VERSION}）"
}

# ---------------------------------------------------------------- 附加功能

setup_nginx() {
  step "准备 Nginx 反向代理配置"
  local target="${CONFIG_DIR}/nginx.conf"
  if [ -f "${INSTALL_DIR}/nginx.conf" ]; then
    install -m 600 "${INSTALL_DIR}/nginx.conf" "$target"
  else
    cat >"$target" <<EOF
# 班级小助手 · Nginx 反向代理（替换 server_name 与证书路径后启用）
server {
    listen 80;
    server_name class.example.com;

    client_max_body_size 12m;   # 表格导入最大 8MB，base64 后约 11MB

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Socket.IO 长连接
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
EOF
  fi
  log "反向代理配置：${target}（改好后复制到 /etc/nginx/conf.d/ 并 nginx -s reload）"
}

setup_firewall() {
  step "配置防火墙"
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null && firewall-cmd --reload >/dev/null
    log "firewalld 已放行 ${PORT}/tcp"
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${PORT}/tcp" >/dev/null
    log "ufw 已放行 ${PORT}/tcp"
  else
    warn "未检测到启用中的 firewalld / ufw，跳过（云服务器还要在安全组放行 ${PORT}）"
  fi
}

# ---------------------------------------------------------------- 体检

check_only() {
  detect_os
  printf '%s体检报告%s（不改动任何东西）\n\n' "$C_BOLD" "$C_RESET"
  local tools=""
  for tool in curl tar gzip sha256sum; do
    if command -v "$tool" >/dev/null 2>&1; then tools="${tools}${tool} "; else tools="${tools}${tool}(缺) "; fi
  done
  local sys_node="-"; local node_bin; node_bin="$(command -v node 2>/dev/null || true)"
  if [ -n "$node_bin" ]; then sys_node="$("$node_bin" -v)"; fi

  printf '  %-24s %s\n' "系统" "${OS_NAME:-未知}"
  printf '  %-24s %s\n' "包管理器" "${PKG:-未识别（apt/yum/dnf 都没有？）}"
  printf '  %-24s %s\n' "架构" "$(uname -m) → $(asset_arch)"
  printf '  %-24s %s\n' "glibc" "$(glibc_version)（<2.28 时自动改用 glibc-217 版 Node）"
  printf '  %-24s %s\n' "systemd" "$(has_systemd && echo 可用 || echo 不可用)"
  printf '  %-24s %s\n' "docker" "$(docker_available && docker --version || echo 不可用)"
  printf '  %-24s %s\n' "基础工具" "${tools}"
  printf '  %-24s %s\n' "系统 Node" "${sys_node}（安装器默认用内置运行时，不依赖它）"
  printf '  %-24s %s\n' "内存" "$(free -h 2>/dev/null | awk 'NR==2 {print $2}' || echo 未知)"
  printf '  %-24s %s\n' "磁盘 $(dirname "$INSTALL_DIR")" "$(df -h "$(dirname "$INSTALL_DIR")" 2>/dev/null | awk 'NR==2 {print $4" 可用"}' || echo 未知)"
  printf '  %-24s %s\n' "端口 ${PORT}" "$(port_in_use "$PORT" && echo '已被占用 ⚠' || echo 空闲)"
  printf '  %-24s %s\n' "安装目录 ${INSTALL_DIR}" "$(is_installed && echo "已安装 v$(existing_version)（重跑=覆盖安装）" || echo 尚未安装)"
  printf '  %-24s %s\n' "配置 ${CONFIG_FILE}" "$([ -f "$CONFIG_FILE" ] && echo 已存在（会被保留） || echo 尚未创建)"
  printf '\n'

  local problems=0
  command -v curl >/dev/null 2>&1 || { warn "缺少 curl"; problems=1; }
  has_systemd || { warn "没有 systemd：直接安装形态不可用（可用 --mode docker）"; problems=1; }
  [ "$PKG" != "" ] || { warn "未识别包管理器：自动装依赖会失败"; problems=1; }
  if [ "$problems" = "1" ]; then return 1; fi
  log "体检通过：可以执行 sudo bash install.sh"
}

# ---------------------------------------------------------------- 卸载

do_uninstall() {
  if [ -x "${INSTALL_DIR}/bin/classhelper" ]; then
    exec "${INSTALL_DIR}/bin/classhelper" uninstall "$@"
  fi
  step "卸载（找不到 classhelper，执行内置清理）"
  if [ "$MODE" = "docker" ]; then
    if [ -f "${CONFIG_DIR}/compose.yml" ]; then
      docker compose -f "${CONFIG_DIR}/compose.yml" down --remove-orphans 2>/dev/null || true
    fi
  else
    systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service" /etc/systemd/system/classhelper-backup.service /etc/systemd/system/classhelper-backup.timer
  fi
  rm -f /etc/profile.d/classhelper.sh "${BIN_DIR}/classhelper" /etc/logrotate.d/classhelper
  systemctl daemon-reload 2>/dev/null || true
  log "服务已移除；程序与数据仍在 ${INSTALL_DIR}（确认不需要后手工删除）"
}

# ---------------------------------------------------------------- 结果输出

print_result() {
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  ip="${ip:-127.0.0.1}"
  printf '\n%s────────────────────────────────────────────────────────────%s\n' "$C_GREEN" "$C_RESET"
  printf '%s安装完成%s  %s服务端 v%s（%s / %s）\n\n' "$C_BOLD" "$C_RESET" "$PRODUCT" "$VERSION" "$MODE" "$DB_KIND"
  printf '  管理端地址    http://%s:%s/\n' "$ip" "$PORT"
  printf '  健康探针      http://%s:%s/healthz\n' "$ip" "$PORT"
  printf '  配置文件      %s（权限 600）\n' "$CONFIG_FILE"
  printf '  数据目录      %s/data\n' "$INSTALL_DIR"
  printf '  安装日志      %s\n\n' "$LOG_FILE"
  if [ -n "$ADMIN_PASSWORD" ]; then
    printf '  管理员账号    admin（密码为你刚才设置的那个）\n'
  else
    printf '  管理员账号    admin / admin123  %s← 默认密码，公网部署请立刻修改%s\n' "$C_YELLOW" "$C_RESET"
  fi
  printf '\n%s常用命令%s\n' "$C_BOLD" "$C_RESET"
  printf '  classhelper status                 查看状态 / 版本 / 端口\n'
  printf '  classhelper doctor                 完整体检\n'
  printf '  classhelper password admin         改管理员密码（交互输入，不回显）\n'
  printf '  classhelper backup                 备份配置 + 数据库\n'
  printf '  classhelper backup schedule daily  开启每日自动备份\n'
  printf '  classhelper upgrade --check        检查新版本\n'
  printf '  classhelper logs -f                实时日志\n'
  printf '  classhelper help                   全部命令\n'
  printf '\n%s接下来建议%s\n' "$C_BOLD" "$C_RESET"
  printf '  1. 改掉默认密码：%sclasshelper password admin%s\n' "$C_CYAN" "$C_RESET"
  printf '  2. 公网访问请上 HTTPS：改好 %s/nginx.conf 的域名与证书，并把 CORS_ORIGIN\n' "$CONFIG_DIR"
  printf '     收敛到你的域名（classhelper config set CORS_ORIGIN https://your.domain）\n'
  printf '  3. 学生端「服务器地址」填 http://%s:%s 或你的域名\n' "$ip" "$PORT"
  printf '%s────────────────────────────────────────────────────────────%s\n' "$C_GREEN" "$C_RESET"
}

# ---------------------------------------------------------------- 主流程

main() {
  parse_args "$@"

  if [ "$CHECK_ONLY" = "1" ]; then
    banner
    check_only
    exit $?
  fi

  [ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash install.sh（只体检不需要 root：bash install.sh --check）"

  banner
  mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"
  {
    printf '\n===== %s 安装开始 =====\n' "$(date '+%F %T')"
    printf '参数：%s\n' "$*"
  } >>"$LOG_FILE"
  # 后续输出同时进日志（tee 不占 stdin，交互问答照常）
  exec > >(tee -a "$LOG_FILE") 2>&1

  detect_os
  info "系统：${OS_NAME:-未知}｜包管理器：${PKG:-未知}｜架构：$(uname -m)"

  choose_mode_interactive
  collect_answers

  if [ "$UNINSTALL" = "1" ]; then
    do_uninstall --yes
    exit 0
  fi

  if [ "$ADMIN_PASSWORD_FROM_STDIN" = "1" ]; then read_stdin_line ADMIN_PASSWORD; fi

  if [ "$MODE" = "native" ] && ! has_systemd && [ "$FORCE" != "1" ]; then
    die "本机没有 systemd：改用 --mode docker，或加 --force 只铺文件（不装服务）"
  fi

  # 覆盖安装时沿用已有端口与数据库形态，避免"重跑一次配置被改回默认"
  if is_installed && [ -f "$CONFIG_FILE" ] && [ "$FORCE" != "1" ]; then
    local old_port old_db
    old_port="$(config_value PORT)"
    old_db="$(config_value DATABASE_PROVIDER)"
    [ -n "$old_port" ] && PORT="$old_port"
    [ -n "$old_db" ] && DB_KIND="$old_db"
    info "检测到已安装（v$(existing_version)）：按覆盖安装处理，配置与数据保留（端口 ${PORT} / ${DB_KIND}）"
  fi

  if port_in_use "$PORT"; then
    if [ "$MODE" = "native" ] && is_installed; then
      info "端口 ${PORT} 已被占用（可能是本服务在跑，稍后会被重启接管）"
    else
      warn "端口 ${PORT} 已被占用，安装后可能起不来"
      ask "换一个端口" "$PORT" PORT
    fi
  fi

  ensure_dependencies
  if [ "$MODE" = "docker" ]; then install_docker_engine; fi
  ensure_user
  ensure_dirs

  fetch_package
  place_program_files
  # 临时解压目录（含安装包副本，几百 MB）用完即删，避免把小盘服务器塞满
  rm -rf "$(dirname "$STAGE_DIR")"

  if [ "$MODE" = "native" ]; then setup_node; fi

  write_config
  link_env_file
  write_meta "${PACKAGE_URL:-github-release}"

  if [ "$MODE" = "docker" ]; then
    write_compose
    docker_build_image
    step "启动容器"
    if ! docker compose -f "${CONFIG_DIR}/compose.yml" --env-file "$CONFIG_FILE" up -d >>"$LOG_FILE" 2>&1; then
      tail -30 "$LOG_FILE" >&2 || true
      die "容器启动失败，详见 ${LOG_FILE}"
    fi
  elif [ "$FORCE" = "1" ] && ! has_systemd; then
    warn "没有 systemd（--force）：请手工启动"
    printf '  sudo -u %s %s/%s/bin/node %s/server/dist/index.js\n' "$SERVICE_USER" "$INSTALL_DIR" "$NODE_DIR_NAME" "$INSTALL_DIR"
  else
    install_systemd_unit
    step "启动服务"
    systemctl restart "$SERVICE_NAME"
  fi

  install_aux_files
  if [ "$WITH_NGINX" = "1" ]; then setup_nginx; fi
  if [ "$OPEN_FIREWALL" = "1" ]; then setup_firewall; fi

  step "等待服务就绪"
  local ready=0 i=0
  while [ "$i" -lt 90 ]; do
    if curl -fsS --noproxy '*' --max-time 3 -o /dev/null "http://127.0.0.1:${PORT}/healthz" 2>/dev/null; then
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$ready" != "1" ]; then
    warn "90 秒内没通过 /healthz，最近日志："
    if [ "$MODE" = "docker" ]; then
      docker compose -f "${CONFIG_DIR}/compose.yml" logs --tail 50 2>&1 || true
    else
      journalctl -u "$SERVICE_NAME" -n 50 --no-pager 2>&1 || true
    fi
    die "安装未完成：服务没起来。常见原因：端口被占用、MySQL 连接串错误、数据目录权限。日志：${LOG_FILE}"
  fi
  log "服务已就绪 ✅"

  print_result
  printf '\n%s提示：新开一个终端（或 source /etc/profile）后，classhelper 的环境变量也会生效。%s\n' "$C_DIM" "$C_RESET"
  sleep 0.3   # 给 tee 一点时间把最后几行刷进日志
}

main "$@"
