# syntax = docker/dockerfile:1
#
# TRAIGO **Worker** 이미지.
#
# Fly launch가 만든 원본은 Next.js 웹앱용이었다 — `npm ci`로 웹 의존성을
# 전부 깔고 `next build`를 돌리고 `npm run start`로 웹서버를 띄웠다.
# 그건 Vercel이 하는 일이고, 여기서 또 하면:
#
#   · 이미지가 몇 배로 커지고 배포가 느려진다
#   · 브라우저 전용 코드가 Worker 이미지에 섞인다
#   · 무엇보다 **웹서버가 뜨고 Worker는 안 뜬다**
#
# 그래서 `worker/`만 빌드한다. Worker는 이미 저장소에 있고 자체
# package.json·tsconfig를 갖고 있다 — 새로 만들지 않고 그것을 쓴다.

ARG NODE_VERSION=22.21.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="TRAIGO Worker"

WORKDIR /app
ENV NODE_ENV="production"

# ── 빌드 ──
FROM base AS build

# **worker의 의존성만 깐다.** 루트 package.json을 쓰지 않는 이유가 여기 있다 —
# 웹 의존성(next·react·lucide 등)이 Worker 이미지에 들어올 이유가 없다.
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker && npm ci --include=dev

COPY worker/ ./worker/
RUN cd worker && npm run build

# 런타임에 필요한 것만 남긴다.
RUN cd worker && npm prune --omit=dev

# ── 실행 ──
FROM base

COPY --from=build /app/worker /app/worker

# **root로 돌리지 않는다.**
USER node

# 요청을 받지 않으므로 EXPOSE도 없다. 이 프로세스는 스스로 돈다.
#
# fly.toml의 [processes]가 이 명령을 덮어쓰지만, 여기에도 같은 것을 둔다 —
# 로컬에서 `docker run`으로 확인할 때 웹서버가 뜨면 안 된다.
CMD ["npm", "start", "--prefix", "worker"]
