FROM node:20-alpine

# docker compose (v2 プラグイン) を使ってコンテナ設定の変更をホストへ反映するために必要。
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY containers.config.json ./
COPY src ./src
COPY public ./public

# docker.sock を読むために root のまま実行する（ホスト側の socket は root 所有）。
EXPOSE 4590
CMD ["node", "src/index.js"]
