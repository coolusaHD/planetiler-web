# tileserver-gl renders the optional raster output; its image already ships Node 24 and Xvfb.
FROM maptiler/tileserver-gl:v5.6.0

USER root

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-21-jre-headless curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY server.ts raster.ts tsconfig.json ./
COPY public ./public

RUN mkdir -p /data/input /data/output /data/sources \
  && curl -fsSL -o /app/planetiler.jar https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar

EXPOSE 8080

ENV DISPLAY=:99
# The base entrypoint would start tileserver-gl itself; raster.ts spawns it per render instead.
ENTRYPOINT []
CMD ["sh", "-c", "Xvfb :99 -nolisten unix >/dev/null 2>&1 & exec pnpm start"]
