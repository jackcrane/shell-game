FROM node:20-bookworm-slim

WORKDIR /app

ARG GIT_COMMIT_SHORT=dev

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
ENV APP_BUILD_COMMIT=$GIT_COMMIT_SHORT

VOLUME ["/app/data"]

EXPOSE 22

USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
