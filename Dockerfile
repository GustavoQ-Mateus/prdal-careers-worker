FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build

FROM build AS deps
RUN npm prune --omit=dev --omit=optional --ignore-scripts

FROM base
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/storage && chown node:node /app /app/storage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 3001
USER node
CMD ["node", "dist/main.js"]
