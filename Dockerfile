FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=2222
ENV HOST_KEY_PATH=/app/data/host.key

VOLUME ["/app/data"]

EXPOSE 2222

USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
