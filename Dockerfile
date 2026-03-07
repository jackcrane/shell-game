FROM node:20-bookworm-slim

WORKDIR /app

ARG GIT_COMMIT_SHORT=

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN BUILD_COMMIT="${GIT_COMMIT_SHORT:-$(git rev-parse --short HEAD 2>/dev/null || printf unknown)}" \
  && printf '%s\n' "$BUILD_COMMIT" > /app/.build-commit \
  && rm -rf /app/.git \
  && mkdir -p /app/data \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV APP_BUILD_COMMIT=unknown

VOLUME ["/app/data"]

EXPOSE 22

USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
