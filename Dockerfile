FROM node:20-bookworm-slim

WORKDIR /app

ARG GIT_COMMIT_SHORT=

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client unzip \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN BUILD_COMMIT="${GIT_COMMIT_SHORT:-$(git rev-parse --short HEAD 2>/dev/null || printf unknown)}" \
  && printf '%s\n' "$BUILD_COMMIT" > /app/.build-commit \
  && mkdir -p /app/games/crossword/data /tmp/crossword-data \
  && if [ -f /app/games/crossword/data.zip ]; then \
    unzip -q -o /app/games/crossword/data.zip -d /tmp/crossword-data \
    && cp -R /tmp/crossword-data/gxd/. /app/games/crossword/data/ \
    && rm -rf /tmp/crossword-data /app/games/crossword/data.zip; \
  fi \
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
