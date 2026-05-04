# Stage 1: Build
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /build

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/app/package.json packages/app/

RUN pnpm install --frozen-lockfile

COPY packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src/
COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src packages/server/src/
COPY packages/app/tsconfig.json packages/app/tsconfig.node.json packages/app/vite.config.ts packages/app/tailwind.config.ts packages/app/postcss.config.js packages/app/index.html packages/app/
COPY packages/app/src packages/app/src/

RUN pnpm -r build
RUN pnpm --filter @todograph/app build:web

# Stage 2: Runtime
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app

COPY --from=builder /build/packages/core/dist /app/packages/core/dist
COPY --from=builder /build/packages/core/package.json /app/packages/core/package.json
COPY --from=builder /build/packages/shared/dist /app/packages/shared/dist
COPY --from=builder /build/packages/shared/package.json /app/packages/shared/package.json
COPY --from=builder /build/packages/server/dist /app/packages/server/dist
COPY --from=builder /build/packages/server/package.json /app/packages/server/package.json
COPY --from=builder /build/packages/app/dist /app/packages/app/dist

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod

EXPOSE 3000
CMD ["node", "packages/server/dist/main.js"]
