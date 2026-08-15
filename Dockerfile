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

# ── 공용 거래소 모듈 ──
#
# 워커는 웹(Vercel)이 쓰는 바로 그 모듈을 컴파일한다
# (`src/lib/exchanges/futuresExec.ts` · `futuresAdapter.ts`와 그것이 부르는
# `binanceFutures` · `gateFutures` · `gatePlan` · `quantize`).
#
# 워커용 사본을 두지 않는 이유는 하나다 — 사본이 있으면 한쪽만 고쳐지고,
# 그 실수가 **Gate 키를 들고 바이낸스에 서명 요청을 보내는** 모양으로 나온다.
# 실제로 그 상태였다.
#
# 이 파일들은 node 내장 모듈(crypto)과 fetch만 쓴다. next·react가 딸려오지
# 않고, 최종 스테이지는 `/app/worker`만 가져가므로 이미지에는 컴파일된 JS만
# 남는다.
COPY src/lib ./src/lib

COPY worker/ ./worker/
RUN cd worker && npm run build

# 런타임에 필요한 것만 남긴다.
RUN cd worker && npm prune --omit=dev

# ── 실행 ──
FROM base

COPY --from=build /app/worker /app/worker

# **root로 돌리지 않는다.**
USER node

# ── 이 이미지가 어느 커밋인가 ──
#
# **"main에 있으니 배포됐겠지"가 이 저장소에서 두 번 사고를 냈다.**
# 8/13에는 fly-deploy가 안 돌아 워커가 8/9 코드로 돌았고, 8/15에는
# #128(고아주문 정리)·#129(반복 스모크)가 워커에 없는 채로 스모크를
# 돌렸다. 두 번 다 **확인할 방법 자체가 없었다** — 워커는 자기가 어느
# 코드인지 말하지 못했다.
#
# 그래서 빌드할 때 커밋을 새겨 넣는다. 워커는 이 값을 heartbeat에 적고,
# `/api/system/deployment`가 Vercel의 SHA와 나란히 보여 준다.
# 값이 비어 있으면 **"모름"이지 "같음"이 아니다.**
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

# 요청을 받지 않으므로 EXPOSE도 없다. 이 프로세스는 스스로 돈다.
#
# fly.toml의 [processes]가 이 명령을 덮어쓰지만, 여기에도 같은 것을 둔다 —
# 로컬에서 `docker run`으로 확인할 때 웹서버가 뜨면 안 된다.
CMD ["npm", "start", "--prefix", "worker"]
