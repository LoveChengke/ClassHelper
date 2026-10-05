#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 兼容壳：早期文档、脚本与 README 里写的是 deploy/install-linux.sh，
# 现在安装器统一在 deploy/install.sh（避免两份实现漂移）。
#
# 两者参数完全一致：
#   sudo bash deploy/install-linux.sh --port 8080
# 等价于
#   sudo bash deploy/install.sh --port 8080
# ---------------------------------------------------------------------------
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '\033[33m[classhelper]\033[0m install-linux.sh 已更名为 install.sh，本次自动转发（后续请直接用 install.sh）\n' >&2
exec bash "${DIR}/install.sh" "$@"
