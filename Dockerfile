FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /repo/apps/worker
COPY apps/api/prisma/schema.prisma /repo/apps/api/prisma/schema.prisma
COPY apps/worker/package.json apps/worker/package-lock.json ./
COPY apps/worker/scripts ./scripts
RUN npm ci --omit=dev
RUN npm prune --omit=dev --omit=optional --ignore-scripts

FROM base AS build
WORKDIR /repo/apps/worker
COPY apps/api/prisma/schema.prisma /repo/apps/api/prisma/schema.prisma
COPY apps/worker/package.json apps/worker/package-lock.json ./
COPY apps/worker/scripts ./scripts
RUN npm ci
COPY apps/worker/tsconfig.json ./
COPY apps/worker/src ./src
RUN npm run build

FROM base
WORKDIR /app
ENV NODE_ENV=production
RUN chown node:node /app
COPY --from=deps /repo/apps/worker/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
EXPOSE 3001
USER node
CMD ["node", "dist/main.js"]
