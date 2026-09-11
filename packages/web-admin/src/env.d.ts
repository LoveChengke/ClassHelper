/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 API 基地址，默认 http://127.0.0.1:4000/api */
  readonly VITE_API_BASE_URL?: string;
  /** Socket.IO 服务地址，默认 http://127.0.0.1:4000 */
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
