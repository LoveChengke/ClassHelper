# ---------------------------------------------------------------------------
# 班级小助手 · 登录 shell 环境变量
#
# 由 deploy/install.sh 安装到 /etc/profile.d/classhelper.sh（占位符替换成真实路径）。
# 生效方式：重新登录，或 `source /etc/profile.d/classhelper.sh`。
#
# 说明：`classhelper` 命令本身装在 /usr/local/bin（软链到 $CLASSHELPER_HOME/bin/classhelper），
#       不依赖这个文件也能用；这里提供的是路径类变量，方便写脚本时引用。
# ---------------------------------------------------------------------------

# 只在目录真实存在时导出：卸载后残留的 profile.d 不应该污染别人的环境
if [ -d '__DIR__' ]; then
  export CLASSHELPER_HOME='__DIR__'
  export CLASSHELPER_CONFIG='__CONFIG__'
  export CLASSHELPER_LOG_DIR='__LOGDIR__'
  export CLASSHELPER_BACKUP_DIR='__BACKUPDIR__'
  export CLASSHELPER_SERVICE='classhelper'

  case ":${PATH}:" in
    *":${CLASSHELPER_HOME}/bin:"*) ;;
    *) export PATH="${PATH}:${CLASSHELPER_HOME}/bin" ;;
  esac
fi

# 让 `classhelper` 在非 root 登录时也能补全（bash 补全由 `classhelper completion bash` 输出）
if [ -n "${BASH_VERSION:-}" ] && [ -r /usr/share/bash-completion/completions/classhelper ]; then
  . /usr/share/bash-completion/completions/classhelper
fi
