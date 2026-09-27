# 班级小助手服务端 · 生产镜像
#
# 两阶段构建：
#   build   —— 安装依赖并编译 shared / server / web-admin
#   runtime —— 仅保留运行时所需内容（生产依赖 + 构建产物），镜像更小
#
# 构建（在仓库根目录执行）：
#   docker build -f deploy/Dockerfile -t classhelper-server:0.1.0 .
#
# 运行（SQLite + 数据卷）：
#   docker run -d --name classhelper -p 4000:4000 \
#     -e JWT_SECRET=<48字节随机串> \
#     -v classhelper-data:/app/data \
#     classhelper-server:0.1.0
#
# 生产推荐用 docker compose（见 deploy/docker-compose.yml，含 MySQL 与 HTTPS 反代）

# ---------------------------------------------------------------- 构建阶段
FROM node:22-slim AS build
WORKDIR /app

# 启用 pnpm（用 corepack 保证版本与仓库一致）
RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

# 先只拷贝清单以提高缓存命中率
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web-admin/package.json packages/web-admin/
COPY packages/desktop-client/package.json packages/desktop-client/
RUN pnpm install --frozen-lockfile --ignore-scripts

# 再拷贝源码并构建（只构建服务端与 Web 管理端，桌面客户端不参与）
COPY packages ./packages
COPY scripts ./scripts

# 必须先生成 Prisma Client：`pnpm install --ignore-scripts` 跳过了 postinstall，
# 而生成产物 `packages/server/src/generated/prisma` 是 gitignored 的（clone 下来没有），
# 少了这一步下面的 tsc 会报 "Cannot find module '../generated/prisma/client.js'"。
RUN pnpm build:shared \
 && pnpm --filter @classhelper/server run db:generate \
 && pnpm --filter @classhelper/server build \
 && pnpm --filter @classhelper/web-admin build

# ---------------------------------------------------------------- 运行时阶段
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    LOG_LEVEL=info \
    TRUST_PROXY=1 \
    RATE_LIMIT_ENABLED=true \
    STARTUP_DB_CHECK=true

# 生产依赖（清单由 scripts/dist-server.mjs 依据 packages/server/package.json 生成）
COPY deploy/package.runtime.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# 后端产物 + 迁移文件 + Web 管理端 + 工作区共享包
COPY --from=build /app/packages/server/dist ./server/dist
COPY --from=build /app/packages/server/prisma/migrations ./server/prisma/migrations
COPY --from=build /app/packages/web-admin/dist ./web
COPY --from=build /app/packages/shared/dist ./node_modules/@classhelper/shared/dist
COPY packages/shared/package.json ./node_modules/@classhelper/shared/package.json

# 数据目录（SQLite 文件 / PID 文件），建议挂载数据卷
RUN mkdir -p /app/data /app/logs
VOLUME ["/app/data"]

EXPOSE 4000

# 容器健康检查：就绪探针（数据库不可用会返回 503）
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
