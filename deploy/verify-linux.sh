#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ClassHelper · Linux 安装与运维链路验收（在**已安装的服务器上**运行）
#
# 覆盖：安装结果 → 服务可用性 → API 登录 → 改密（含回滚与审计）→ 备份 →
#       配置读写 → key rotate →（可选）升级 / 回滚 / 卸载
#
# 用法（在服务器上，需要 root）：
#   sudo bash verify-linux.sh                        # 基础链路
#   sudo bash verify-linux.sh --full --package /tmp/xxx.tar.gz   # 追加升级/回滚
#   sudo bash verify-linux.sh --admin-password-stdin # 密码从 stdin 读一行（不进 argv/history）
#
# 说明：
#   - 本脚本会**真的**改一次管理员密码（换成随机强密码，再改回去），并真的发一条备份；
#   - 除了 --purge 的卸载测试，不会删除任何数据；
#   - 全程不需要外网（升级测试用 --package 指向本地包）。
# ---------------------------------------------------------------------------
set -uo pipefail

INSTALL_DIR="/opt/classhelper"
CONFIG_FILE="/etc/classhelper/config.env"
LOG_DIR="/var/log/classhelper"
BACKUP_DIR="/var/backups/classhelper"
PORT=""
ADMIN_USER="admin"
ADMIN_PASSWORD=""
ADMIN_PASSWORD_FROM_STDIN=0
DO_FULL=0
PACKAGE=""

TOTAL=0; PASS=0; FAIL=0
FAILED=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --user) ADMIN_USER="$2"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2 ;;
    --admin-password-stdin) ADMIN_PASSWORD_FROM_STDIN=1; shift ;;
    --package) PACKAGE="$2"; shift 2 ;;
    --full) DO_FULL=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; B=$'\033[1m'; N=$'\033[0m'; else G=; R=; Y=; D=; B=; N=; fi

section() { printf '\n%s▶ %s%s\n' "$B" "$1" "$N"; }
check() { # $1=描述 $2=0 通过
  TOTAL=$((TOTAL + 1))
  if [ "$2" = "0" ]; then
    PASS=$((PASS + 1)); printf '  %s✔%s %s\n' "$G" "$N" "$1"
  else
    FAIL=$((FAIL + 1)); FAILED+=("$1"); printf '  %s✘%s %s\n' "$R" "$N" "$1"
  fi
}
note() { printf '  %s· %s%s\n' "$D" "$1" "$N"; }

[ "$(id -u)" = "0" ] || { echo "请用 root 运行：sudo bash verify-linux.sh" >&2; exit 1; }

if [ ! -f "$CONFIG_FILE" ]; then
  echo "找不到安装：${CONFIG_FILE} 不存在（用 --config 指定，或先跑 install.sh）" >&2
  exit 1
fi
read_cfg() { sed -n "s/^[[:space:]]*$1=//p" "$CONFIG_FILE" | tail -n 1 | tr -d '"'; }
[ -n "$PORT" ] || PORT="$(read_cfg PORT)"
[ -n "$PORT" ] || PORT=4000
CLASSHELPER="${INSTALL_DIR}/bin/classhelper"
API="http://127.0.0.1:${PORT}"
CURL=(curl -fsS --noproxy '*')

if [ "$ADMIN_PASSWORD_FROM_STDIN" = "1" ]; then IFS= read -r ADMIN_PASSWORD || true; fi

printf '%sClassHelper · Linux 安装验收%s\n' "$B" "$N"
note "安装目录 ${INSTALL_DIR}｜配置 ${CONFIG_FILE}｜端口 ${PORT}"

# ---------------------------------------------------------------- 1. 安装结果

section "安装结果"
check "安装目录存在且含 server/dist/index.js" "$([ -f "${INSTALL_DIR}/server/dist/index.js" ] && echo 0 || echo 1)"
check "版本文件 VERSION 可读" "$([ -s "${INSTALL_DIR}/VERSION" ] && echo 0 || echo 1)"
check "安装元数据 .installed.json 存在" "$([ -f "${INSTALL_DIR}/.installed.json" ] && echo 0 || echo 1)"

cfg_mode="$(stat -c '%a' "$CONFIG_FILE" 2>/dev/null || echo '?')"
check "配置文件权限 600（实际 ${cfg_mode}）" "$([ "$cfg_mode" = "600" ] && echo 0 || echo 1)"
dir_mode="$(stat -c '%a' "$(dirname "$CONFIG_FILE")" 2>/dev/null || echo '?')"
check "配置目录权限 700（实际 ${dir_mode}）" "$([ "$dir_mode" = "700" ] && echo 0 || echo 1)"

env_link="${INSTALL_DIR}/.env"
check "安装目录 .env 是指向配置真身的软链（Web 端切库依赖它）" \
  "$([ -L "$env_link" ] && [ "$(readlink "$env_link")" = "$CONFIG_FILE" ] && echo 0 || echo 1)"

node_bin="${INSTALL_DIR}/runtime/node/bin/node"
node_ver="$([ -x "$node_bin" ] && "$node_bin" -v 2>/dev/null || echo '')"
check "内置 Node 可用（${node_ver:-未找到}）" "$([ -n "$node_ver" ] && echo 0 || echo 1)"

check "classhelper 命令已装到 /usr/local/bin" "$([ -x /usr/local/bin/classhelper ] && echo 0 || echo 1)"
check "安装日志 ${LOG_DIR}/install.log 存在" "$([ -s "${LOG_DIR}/install.log" ] && echo 0 || echo 1)"
check "审计日志 ${LOG_DIR}/audit.log 存在" "$([ -f "${LOG_DIR}/audit.log" ] && echo 0 || echo 1)"
check "审计/安装日志权限不放行他人（≤640）" \
  "$([ "$(stat -c '%a' "${LOG_DIR}/audit.log" 2>/dev/null || echo 644)" -le 640 ] && echo 0 || echo 1)"
check "/etc/profile.d/classhelper.sh 已写入" "$([ -f /etc/profile.d/classhelper.sh ] && echo 0 || echo 1)"
profile_home="$(bash -lc 'echo "${CLASSHELPER_HOME:-}"' 2>/dev/null)"
check "新登录 shell 里 CLASSHELPER_HOME 生效（${profile_home:-空}）" "$([ -n "$profile_home" ] && echo 0 || echo 1)"

# ---------------------------------------------------------------- 2. 服务

section "服务与探针"
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/classhelper.service ]; then
  check "systemd 单元已安装" 0
  check "服务处于 active" "$(systemctl is-active --quiet classhelper && echo 0 || echo 1)"
  check "服务开机自启（enabled）" "$(systemctl is-enabled --quiet classhelper 2>/dev/null && echo 0 || echo 1)"
else
  check "systemd 单元已安装" 1
fi
check "/healthz 返回 200" "$("${CURL[@]}" -o /dev/null "${API}/healthz" 2>/dev/null && echo 0 || echo 1)"

status_json="$("$CLASSHELPER" status --json 2>/dev/null || true)"
check "classhelper status --json 是合法 JSON" "$(printf '%s' "$status_json" | grep -q '"healthy"' && echo 0 || echo 1)"
check "status 报告 healthy=yes" "$(printf '%s' "$status_json" | grep -q '"healthy": "yes"' && echo 0 || echo 1)"
check "status 报告的端口与实际一致" "$(printf '%s' "$status_json" | grep -q "\"port\": ${PORT}" && echo 0 || echo 1)"
check "classhelper help 可执行（非 root 也能看）" "$("$CLASSHELPER" help >/dev/null 2>&1 && echo 0 || echo 1)"
check "classhelper completion bash 有输出" "$("$CLASSHELPER" completion bash 2>/dev/null | grep -q 'classhelper' && echo 0 || echo 1)"

doctor_out="$("$CLASSHELPER" doctor 2>&1 || true)"
check "classhelper doctor 无待处理项" "$(printf '%s' "$doctor_out" | grep -q '体检通过' && echo 0 || echo 1)"
if ! printf '%s' "$doctor_out" | grep -q '体检通过'; then
  printf '%s' "$doctor_out" | sed 's/^/    /'
fi

# ---------------------------------------------------------------- 3. API

section "API 与登录"
TOKEN=""
login() { # $1=密码 → 输出 token（失败则空）
  "${CURL[@]}" -X POST "${API}/api/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"$1\"}" 2>/dev/null \
    | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

if [ -z "$ADMIN_PASSWORD" ]; then
  note "未提供 --admin-password(-stdin)，跳过登录与改密用例"
else
  TOKEN="$(login "$ADMIN_PASSWORD")"
  check "管理员用提供的密码能登录并拿到 token" "$([ -n "$TOKEN" ] && echo 0 || echo 1)"
  if [ -n "$TOKEN" ]; then
    classes="$("${CURL[@]}" -H "Authorization: Bearer ${TOKEN}" "${API}/api/classes" 2>/dev/null || true)"
    check "带 token 能读业务接口 /api/classes" "$(printf '%s' "$classes" | grep -q '"data"' && echo 0 || echo 1)"
    me="$("${CURL[@]}" -H "Authorization: Bearer ${TOKEN}" "${API}/api/auth/me" 2>/dev/null || true)"
    check "/api/auth/me 返回的是 ADMIN" "$(printf '%s' "$me" | grep -q '"ADMIN"' && echo 0 || echo 1)"
  fi
fi

# ---------------------------------------------------------------- 4. 改密

if [ -n "$TOKEN" ]; then
  section "password 子命令（改密 → 回滚 → 审计）"
  # 生成一个一定满足强度要求的密码（大小写+数字+符号，且不落在常见口令里）
  GENERATED="Ch$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')!a9Z"
  before_count="$(grep -c 'action=password' "${LOG_DIR}/audit.log" 2>/dev/null || echo 0)"

  # 密码经管道进 stdin，不出现在 argv / 环境变量 / shell history
  out="$(printf '%s\n%s\n' "$GENERATED" "$GENERATED" | "$CLASSHELPER" password "$ADMIN_USER" 2>&1)"
  check "classhelper password 执行成功" "$(printf '%s' "$out" | grep -q '密码已更新' && echo 0 || echo 1)"

  new_token="$(login "$GENERATED")"
  check "新密码能登录" "$([ -n "$new_token" ] && echo 0 || echo 1)"
  old_token="$(login "$ADMIN_PASSWORD")"
  check "旧密码已失效（登录被拒）" "$([ -z "$old_token" ] && echo 0 || echo 1)"

  hash_backup="$(ls -1t "${BACKUP_DIR}"/password-*.json 2>/dev/null | head -n 1 || true)"
  check "改密前备份了原哈希（${hash_backup:-无}）" "$([ -n "$hash_backup" ] && echo 0 || echo 1)"
  check "哈希备份权限 600" \
    "$([ -n "$hash_backup" ] && [ "$(stat -c '%a' "$hash_backup")" = "600" ] && echo 0 || echo 1)"

  after_count="$(grep -c 'action=password' "${LOG_DIR}/audit.log" 2>/dev/null || echo 0)"
  check "审计日志新增了 password 记录" "$([ "${after_count:-0}" -gt "${before_count:-0}" ] && echo 0 || echo 1)"
  check "审计日志里没有新密码明文" "$(grep -q -- "$GENERATED" "${LOG_DIR}/audit.log" 2>/dev/null && echo 1 || echo 0)"
  check "审计日志里没有原密码明文" "$(grep -q -- "$ADMIN_PASSWORD" "${LOG_DIR}/audit.log" 2>/dev/null && echo 1 || echo 0)"

  # 先把输出收进变量再 grep：`外部命令 | grep -q` 在 `set -o pipefail` 下，grep 命中即退出会让
  # 写端收到 SIGPIPE（退出码 141），于是"匹配到了"被算成失败
  weak_out="$(printf 'abc\nabc\n' | "$CLASSHELPER" password "$ADMIN_USER" 2>&1 || true)"
  check "弱密码被拒绝（长度/种数不足）" "$(printf '%s' "$weak_out" | grep -q '不合规' && echo 0 || echo 1)"
  check "密码不合规时不会卡死（stdin 结束即退出）" \
    "$(printf 'abc\n' | timeout 20 "$CLASSHELPER" password "$ADMIN_USER" >/dev/null 2>&1; [ $? -ne 124 ] && echo 0 || echo 1)"
  list_out="$("$CLASSHELPER" password --list 2>&1 || true)"
  check "password --list 能列出账号" "$(printf '%s' "$list_out" | grep -q "$ADMIN_USER" && echo 0 || echo 1)"

  # 用改密前保存的哈希把账号恢复原样：比再改一次密码更可靠
  # （原密码若是 admin123 这类弱口令，改回去会被强度校验挡下 —— 那是产品的正确行为）
  if [ -n "$hash_backup" ]; then
    restore_hash_out="$(LOG_LEVEL=error DOTENV_CONFIG_QUIET=true "$node_bin" "${INSTALL_DIR}/tools/admin-cli.mjs" restore-hash "$hash_backup" 2>&1 || true)"
    check "restore-hash 能把原哈希回滚回来" "$(printf '%s' "$restore_hash_out" | grep -q '已回滚密码哈希' && echo 0 || echo 1)"
    check "原密码重新可用" "$([ -n "$(login "$ADMIN_PASSWORD")" ] && echo 0 || echo 1)"
  fi
else
  note "跳过改密用例（没有可用的登录会话）"
fi

# ---------------------------------------------------------------- 5. 备份

section "backup 子命令"
backup_out="$("$CLASSHELPER" backup --keep 5 2>&1)"
check "classhelper backup 执行成功" "$(printf '%s' "$backup_out" | grep -q '备份完成' && echo 0 || echo 1)"

latest="$(ls -1dt "${BACKUP_DIR}"/*/ 2>/dev/null | head -n 1)"
check "生成了新的备份目录" "$([ -n "$latest" ] && echo 0 || echo 1)"
if [ -n "$latest" ]; then
  check "备份含 config.env" "$([ -f "${latest}config.env" ] && echo 0 || echo 1)"
  check "备份 meta.json 带版本号" "$(grep -q '"version"' "${latest}meta.json" 2>/dev/null && echo 0 || echo 1)"
  db_kind="$(read_cfg DATABASE_PROVIDER)"
  if [ "$db_kind" = "sqlite" ]; then
    snap="${latest}classhelper.db"
    check "备份含 SQLite 快照" "$([ -s "$snap" ] && echo 0 || echo 1)"
    # 一致性快照必须是完整的 SQLite 文件（VACUUM INTO 产物）
    check "快照是合法 SQLite 文件（文件头正确）" \
      "$([ -n "$snap" ] && [ "$(head -c 15 "$snap" 2>/dev/null)" = "SQLite format 3" ] && echo 0 || echo 1)"
    check "快照权限 600" "$([ -n "$snap" ] && [ "$(stat -c '%a' "$snap")" = "600" ] && echo 0 || echo 1)"
  else
    note "数据库是 MySQL，跳过 SQLite 快照用例"
  fi
  check "备份目录权限 700" "$([ "$(stat -c '%a' "${latest%/}" 2>/dev/null)" = "700" ] && echo 0 || echo 1)"
fi
backup_list_out="$("$CLASSHELPER" backup list 2>&1 || true)"
check "backup list 能列出备份" "$(printf '%s' "$backup_list_out" | grep -qE '^  [0-9]{8}-' && echo 0 || echo 1)"

# ---------------------------------------------------------------- 6. 配置

section "config 子命令"
check "config get PORT 返回当前端口" "$([ "$("$CLASSHELPER" config get PORT)" = "$PORT" ] && echo 0 || echo 1)"
masked="$("$CLASSHELPER" config show 2>/dev/null | grep '^JWT_SECRET=')"
check "config show 对 JWT_SECRET 打码" "$(printf '%s' "$masked" | grep -q '\*\*\*\*' && echo 0 || echo 1)"
check "config show 没打印出真实密钥" \
  "$(secret="$(read_cfg JWT_SECRET)"; [ -n "$secret" ] && printf '%s' "$masked" | grep -q -- "$secret" && echo 1 || echo 0)"

# 用一个无害的键做读写往返（不重启服务）
printf 'CH_VERIFY_PROBE=1\n' >>"$CONFIG_FILE"
probe="$("$CLASSHELPER" config get CH_VERIFY_PROBE 2>/dev/null)"
check "config get 能读到新增键" "$([ "$probe" = "1" ] && echo 0 || echo 1)"
sed -i '/^CH_VERIFY_PROBE=/d' "$CONFIG_FILE"

# ---------------------------------------------------------------- 7. key rotate

if [ -n "$TOKEN" ]; then
  section "key rotate"
  if [ "${CLASSHELPER_VERIFY_SKIP_KEY_ROTATE:-0}" = "1" ]; then
    note "按环境变量跳过"
  else
    old_secret="$(read_cfg JWT_SECRET)"
    # key rotate 无 tty 时会问两次（确认轮换、是否现在重启）；只喂一个 yes 的话第二次读到 EOF，
    # 重启被跳过 —— 新密钥不生效，下面「旧 token 已失效」必然失败。
    # 用 CLASSHELPER_ASSUME_YES=1 跳过问答并强制重启，语义才是"轮换后旧会话立即失效"。
    CLASSHELPER_NO_TTY=1 CLASSHELPER_ASSUME_YES=1 "$CLASSHELPER" key rotate >/dev/null 2>&1 || true
    new_secret="$(read_cfg JWT_SECRET)"
    check "key rotate 改变了 JWT_SECRET" "$([ -n "$new_secret" ] && [ "$new_secret" != "$old_secret" ] && echo 0 || echo 1)"
    check "新密钥长度 ≥32" "$([ "${#new_secret}" -ge 32 ] && echo 0 || echo 1)"
    check "轮换后服务仍可用" "$("${CURL[@]}" -o /dev/null "${API}/healthz" && echo 0 || echo 1)"
    check "轮换前的 token 已失效（/api/auth/me 返回 401）" \
      "$(code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${TOKEN}" "${API}/api/auth/me")"; [ "$code" = "401" ] && echo 0 || echo 1)"
    # 轮换后要重新登录，否则后面的用例会带着失效 token 跑
    TOKEN="$(login "$ADMIN_PASSWORD")"
    check "轮换后重新登录成功" "$([ -n "$TOKEN" ] && echo 0 || echo 1)"
  fi
fi

# ---------------------------------------------------------------- 8. 升级 / 回滚

if [ "$DO_FULL" = "1" ]; then
  section "upgrade / rollback（--full）"
  if [ -z "$PACKAGE" ]; then
    note "未提供 --package，跳过升级用例"
  else
    before_version="$("$CLASSHELPER" version 2>/dev/null | awk '{print $2}')"
    sha="$(sha256sum "$PACKAGE" | awk '{print $1}')"
    up_out="$("$CLASSHELPER" upgrade --url "$PACKAGE" --sha256 "$sha" --force 2>&1)"
    check "upgrade 执行成功" "$(printf '%s' "$up_out" | grep -q '升级完成' && echo 0 || echo 1)"
    check "升级后服务仍就绪" "$("${CURL[@]}" -o /dev/null "${API}/healthz" && echo 0 || echo 1)"
    check "升级后配置未被改动（JWT_SECRET 保持）" \
      "$([ "$(read_cfg JWT_SECRET)" = "${new_secret:-$(read_cfg JWT_SECRET)}" ] && echo 0 || echo 1)"
    check "产生了程序快照（可回滚）" "$(ls -1 "${BACKUP_DIR}/rollback" 2>/dev/null | grep -q . && echo 0 || echo 1)"
    check "坏包被拒绝（sha256 不匹配时不改动任何文件）" \
      "$("$CLASSHELPER" upgrade --url "$PACKAGE" --sha256 0000000000000000000000000000000000000000000000000000000000000000 2>&1 | grep -q '校验失败' && echo 0 || echo 1)"
    check "校验失败后服务仍在运行" "$("${CURL[@]}" -o /dev/null "${API}/healthz" && echo 0 || echo 1)"

    note "（回滚需要交互确认，这里用 yes 管道）"
    rb_out="$(printf 'yes\n' | "$CLASSHELPER" rollback 2>&1)"
    check "rollback 执行成功" "$(printf '%s' "$rb_out" | grep -qE '已回滚到|回滚' && echo 0 || echo 1)"
    check "回滚后服务仍就绪" "$("${CURL[@]}" -o /dev/null "${API}/healthz" && echo 0 || echo 1)"
    note "升级前版本 ${before_version}｜升级后 $("$CLASSHELPER" version 2>/dev/null | awk '{print $2}')"
  fi
fi

# ---------------------------------------------------------------- 结果

printf '\n'
if [ "$FAIL" = "0" ]; then
  printf '%s=== 结果：%s/%s 项通过 ===%s\n' "$G" "$PASS" "$TOTAL" "$N"
else
  printf '%s=== 结果：%s/%s 项通过，%s 项失败 ===%s\n' "$R" "$PASS" "$TOTAL" "$FAIL" "$N"
  printf '%s失败项：%s\n' "$Y" "$N"
  for item in "${FAILED[@]}"; do printf '  · %s\n' "$item"; done
fi
[ "$FAIL" = "0" ] || exit 1
