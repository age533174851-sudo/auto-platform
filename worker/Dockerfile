# worker/Dockerfile
#
# Worker만 담는다. Next.js 빌드를 하지 않는다 — 웹은 Vercel에 있고,
# 여기에 웹까지 담으면 이미지가 커지고 배포가 느려진다.
FROM node:22-alpine

WORKDIR /app

# 의존성 없이 돈다 (fetch는 Node 18+ 내장). package.json을 넣지 않는 이유는
# 웹 의존성이 딸려 들어오는 것을 막기 위해서다 — Worker는 순수 Node로 돈다.
COPY worker/main.mjs ./worker/main.mjs

# **root로 돌리지 않는다.**
USER node

CMD ["node", "worker/main.mjs"]
