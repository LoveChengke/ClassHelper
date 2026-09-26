#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 班级小助手 · 服务端 Linux 一键部署（systemd + SQLite，单机单实例）
#
# 干什么：
#   在 Linux 服务器上把服务端装成 systemd 服务，布局与已验证的 Windows 免安装目录完全一致：
#     /opt/classhelper/
#     ├── .env                    全部配置（首次安装随机生成 JWT_SECRET）
#     ├── server/dist             后端程序（入口 index.js）
#     ├── server/prisma           迁移 SQL（AUTO_MIGRATE=true 时首启动自动执行）
#     ├── web/                    Web 管理端（由后端托管，单端口 4000）
#     ├── node_modules/           仅生产依赖（npm install --omit=dev）
#     ├── data/                   classhelper.db + server.pid
#     └── logs/                   预留（日志默认进 journald）
#
# 前置条件：
#   - 在**仓库根目录**已执行过构建：pnpm build:shared && pnpm --filter @classhelper/server build \
#       && pnpm --filter @classhelper/web-admin build
#   - 目标机装好 Node.js ≥ 20.19（推荐 22 LTS）；本脚本不代装 Node
#
# 用法（在仓库根目录执行，需要 root）：
#   sudo bash deploy/install-linux.sh                    # 安装/升级，默认端口 4000、目录 /opt/classhelper
#   sudo bash deploy/install-linux.sh --port 8080        # 换端口
#   sudo bash deploy/install-linux.sh --dir /srv/classhelper
#   sudo bash deploy/install-linux.sh --no-service       # 只铺文件，不装 systemd（自己接管进程）
#   bash deploy/install-linux.sh --check                 # 只体检（不需要 root）：校验构建产物/Node 版本/端口探针
#   sudo bash deploy/install-linux.sh --uninstall        # 停止并禁用服务（保留 data 与 .env）
#
# 升级：把新代码构建好后**再跑一次同样的命令**即可。脚本不会覆盖已有 .env（JWT 密钥与端口保持
#      不变，用户不用重新登录），只会补齐缺失项并覆盖程序文件。
#
# 注意：本脚本未在 Linux 实机验证过（开发机是 Windows，无 Docker/WSL 发行版）。
#      它复用的是**已验证**的两套布局：Windows 免安装目录（install/ 结构）与 deploy/Dockerfile
#      的 runtime 阶段（package.runtime.json + prisma/migrations + web/）。
# ---------------------------------------------------------------------------
set -euo pipefail

TARGET_DIR="/opt/classhelper"
SERVICE_USER="classhelper"
PORT="4000"
WITH_SERVICE=1
UNINSTALL=0
CHECK_ONLY=0
SERVICE_NAME="classhelper"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) TARGET_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --no-service) WITH_SERVICE=0; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[32m[classhelper]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[classhelper]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[classhelper]\033[0m %s\n' "$*" >&2; exit 1; }

# 就绪探针：优先 curl（几乎每台 Linux 都有），否则退回 node。
# 注意不要用 `node -e "...process.exit()"` —— 在部分 Node 版本上于 promise 回调里硬退会触发
# libuv 断言崩溃（本机 Windows 实测退出码 -1073740791），改成设置 process.exitCode 让事件循环自然结束。
probe_ready() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1
    return $?
  fi
  "$NODE_BIN" -e "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>{process.exitCode=r.ok?0:1}).catch(()=>{process.exitCode=1})" >/dev/null 2>&1
}

[ "$(id -u)" = "0" ] || { [ "$CHECK_ONLY" = "1" ] || die "请用 root 执行：sudo bash deploy/install-linux.sh"; }

# ---------------------------------------------------------------- 卸载分支
if [ "$UNINSTALL" = "1" ]; then
  if systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
    systemctl disable --now "$SERVICE_NAME" || true
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload
    log "已停止并移除 systemd 服务 ${SERVICE_NAME}"
  else
    warn "没有找到 ${SERVICE_NAME}.service（可能没装成服务）"
  fi
  log "程序文件与数据保留在 ${TARGET_DIR}；确认不需要后再手动删除"
  exit 0
fi

# ---------------------------------------------------------------- 定位仓库与产物
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

SERVER_DIST="packages/server/dist/index.js"
SERVER_PRISMA="packages/server/prisma"
WEB_DIST="packages/web-admin/dist/index.html"
SHARED_DIST="packages/shared/dist/index.js"
RUNTIME_PKG="deploy/package.runtime.json"

for f in "$SERVER_DIST" "$WEB_DIST" "$SHARED_DIST" "$RUNTIME_PKG"; do
  [ -e "$f" ] || die "缺少构建产物：$f
请先在仓库根目录执行：
  pnpm build:shared && pnpm --filter @classhelper/server build && pnpm --filter @classhelper/web-admin build"
done
[ -d "$SERVER_PRISMA/migrations" ] || die "缺少迁移文件目录：$SERVER_PRISMA/migrations"

# ---------------------------------------------------------------- Node 检查
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "未找到 node，请先安装 Node.js ≥ 20.19（推荐 22 LTS）"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
  die "Node 版本过低：$("$NODE_BIN" -v)（要求 ≥ 20.19）"
fi
NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || die "未找到 npm（随 Node 一起安装）"
log "Node $("$NODE_BIN" -v) → $NODE_BIN"

# ---------------------------------------------------------------- 只体检
if [ "$CHECK_ONLY" = "1" ]; then
  echo
  echo "构建产物："
  for f in "$SERVER_DIST" "$WEB_DIST" "$SHARED_DIST" "$RUNTIME_PKG" "$SERVER_PRISMA/migrations"; do
    printf '  %-42s %s\n' "$f" "OK"
  done
  printf '  %-42s %s\n' "迁移文件数量" "$(find "$SERVER_PRISMA/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  echo
  echo "运行环境："
  printf '  %-42s %s\n' "node" "$("$NODE_BIN" -v)（要求 ≥ 20.19）"
  printf '  %-42s %s\n' "npm" "$("$NPM_BIN" -v)"
  printf '  %-42s %s\n' "systemd" "$(command -v systemctl >/dev/null 2>&1 && echo 可用 || echo '不可用（用 --no-service）')"
  printf '  %-42s %s\n' "目标目录 ${TARGET_DIR}" "$([ -e "$TARGET_DIR" ] && echo '已存在（会就地升级，保留 .env）' || echo 尚未创建)"
  printf '  %-42s %s\n' "端口 ${PORT} 上的既有服务" "$(probe_ready && echo '健康（就绪）' || echo '无响应')"
  echo
  log "--check 通过：构建产物与运行环境都满足，可以执行安装（sudo bash deploy/install-linux.sh）"
  exit 0
fi

# ---------------------------------------------------------------- 用户与目录
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --shell /sbin/nologin "$SERVICE_USER"
  log "已创建系统用户 ${SERVICE_USER}"
fi

mkdir -p "${TARGET_DIR}/server" "${TARGET_DIR}/web" "${TARGET_DIR}/data" "${TARGET_DIR}/logs"
log "安装目录：${TARGET_DIR}"

# ---------------------------------------------------------------- 拷贝产物
rm -rf "${TARGET_DIR}/server/dist"
cp -R "packages/server/dist" "${TARGET_DIR}/server/dist"
rm -rf "${TARGET_DIR}/server/prisma"
cp -R "$SERVER_PRISMA" "${TARGET_DIR}/server/prisma"
# 运行时不读 schema，但保留一份便于排查
[ -f packages/server/prisma/schema.prisma ] && cp packages/server/prisma/schema.prisma "${TARGET_DIR}/server/prisma/schema.prisma"

rm -rf "${TARGET_DIR}/web"
cp -R "packages/web-admin/dist" "${TARGET_DIR}/web"

cp "$RUNTIME_PKG" "${TARGET_DIR}/package.json"
cp -R deploy/classhelper.service "${TARGET_DIR}/classhelper.service.template"

# 生产依赖（与 Dockerfile 的 runtime 阶段同一份清单）
if [ ! -d "${TARGET_DIR}/node_modules" ] || [ "${FORCE_NPM_INSTALL:-0}" = "1" ]; then
  log "安装生产依赖（npm install --omit=dev，约 1~3 分钟）..."
  ( cd "$TARGET_DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund )
else
  log "复用已有 node_modules（如需强制重装：FORCE_NPM_INSTALL=1 再跑一次）"
fi

# workspace 共享包（后端 import '@classhelper/shared'）：拷进 node_modules 里
mkdir -p "${TARGET_DIR}/node_modules/@classhelper/shared"
rm -rf "${TARGET_DIR}/node_modules/@classhelper/shared/dist"
cp -R "packages/shared/dist" "${TARGET_DIR}/node_modules/@classhelper/shared/dist"
cp packages/shared/package.json "${TARGET_DIR}/node_modules/@classhelper/shared/package.json"

# ---------------------------------------------------------------- .env（已存在则不覆盖）
ENV_FILE="${TARGET_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  log "检测到已有 .env：保留现有配置（含 JWT_SECRET），只补齐缺失项"
else
  JWT_SECRET="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  cat > "$ENV_FILE" <<EOF
# 班级小助手服务端（install-linux.sh 生成，请妥善保管）
# 修改后重启服务生效：systemctl restart ${SERVICE_NAME}

NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}

# 数据库：SQLite 文件放在安装根目录的 data 下（备份只需复制该目录）
DATABASE_PROVIDER=sqlite
DATABASE_URL="file:../data/classhelper.db"
# 空库首启动自动执行随包迁移并创建管理员
AUTO_MIGRATE=true

# 令牌签名密钥（随机生成；更换后所有用户需重新登录）
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

# 允许的跨域来源：走域名/反代时建议改成具体来源，例如 https://class.example.com
CORS_ORIGIN=*
# 前面有 Nginx 等反向代理时设为 1，限流才会按真实客户端 IP 统计
TRUST_PROXY=1

RATE_LIMIT_ENABLED=true
STARTUP_DB_CHECK=true
PID_FILE=../data/server.pid
LOG_LEVEL=info

BCRYPT_ROUNDS=10
DEFAULT_STUDENT_PASSWORD=123456
DEFAULT_CLASS_PASSWORD=123456
DEFAULT_TEACHER_PASSWORD=123456
TERM_START_DATE=
EOF
  log "已生成 ${ENV_FILE}（含随机 JWT_SECRET）"
fi

# data/logs 必须可写；程序文件只读即可
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${TARGET_DIR}/data" "${TARGET_DIR}/logs"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${TARGET_DIR}/node_modules"
chown "${SERVICE_USER}:${SERVICE_USER}" "$ENV_FILE"
chown -R root:root "${TARGET_DIR}/server" "${TARGET_DIR}/web"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------- systemd
if [ "$WITH_SERVICE" = "1" ]; then
  command -v systemctl >/dev/null 2>&1 || die "本机没有 systemd；请加 --no-service 自行托管进程"

  sed -e "s#__NODE__#${NODE_BIN}#g" \
      -e "s#__DIR__#${TARGET_DIR}#g" \
      -e "s#__USER__#${SERVICE_USER}#g" \
      deploy/classhelper.service > "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  systemctl restart "$SERVICE_NAME"

  log "等待服务就绪..."
  ready=0
  for _ in $(seq 1 60); do
    if probe_ready; then
      ready=1
      break
    fi
    sleep 1
  done

  if [ "$ready" != "1" ]; then
    warn "60 秒内没通过 /healthz，最近日志："
    journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
    die "启动失败，请按上面的日志排查（常见：端口被占用、数据目录权限、JWT_SECRET 未生成）"
  fi

  log "服务已就绪 ✅"
else
  log "已跳过 systemd（--no-service）。手动启动："
  echo "  sudo -u ${SERVICE_USER} sh -c 'cd ${TARGET_DIR} && ${NODE_BIN} server/dist/index.js'"
fi

# ---------------------------------------------------------------- 结果
cat <<EOF

------------------------------------------------------------------
安装完成
  访问管理端：http://<服务器IP>:${PORT}/
  健康探针：  http://<服务器IP>:${PORT}/healthz  ·  /readyz
  配置文件：  ${ENV_FILE}
  数据目录：  ${TARGET_DIR}/data（备份只需复制这里）
  查看日志：  journalctl -u ${SERVICE_NAME} -f
  重启服务：  systemctl restart ${SERVICE_NAME}

首次启动会自动建表并创建管理员：admin / admin123（登录后请立即在右上角「修改密码」改掉）。
公网部署请在前面加 Nginx + HTTPS（deploy/nginx.conf 可直接用），并把 .env 里的
TRUST_PROXY 设为 1、CORS_ORIGIN 收敛到你的域名。
学生端客户端登录时填的「服务器地址」就是 https://你的域名（或 http://IP:${PORT}）。
------------------------------------------------------------------
EOF
