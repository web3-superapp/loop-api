FROM node:24.19.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY migrations ./migrations
COPY src ./src
RUN pnpm build

FROM build AS migration

CMD ["pnpm", "db:migrate"]

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable \
  && groupadd --system --gid 10001 loop \
  && useradd --system --uid 10001 --gid loop --home-dir /app loop

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile \
  && pnpm store prune

COPY --from=build /app/dist ./dist

USER loop

EXPOSE 3000

CMD ["node", "dist/src/server.js"]
