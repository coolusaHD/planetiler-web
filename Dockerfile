FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-25-jre-headless curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY server.ts tsconfig.json ./
COPY public ./public

RUN mkdir -p /data/input /data/output \
  && curl -fsSL -o /app/planetiler.jar https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar

EXPOSE 8080

CMD ["pnpm", "start"]
