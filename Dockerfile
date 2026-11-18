FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openssl \
    tar \
    unzip \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app

# Copy package manifests and prisma schema first (postinstall runs prisma generate)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Ensure runtime storage directory exists
RUN mkdir -p /app/storage

EXPOSE 5000

CMD ["sh", "-c", "pnpm db:deploy && pnpm start"]
