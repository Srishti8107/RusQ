# RusQ – single container: API + PWA. Put HTTPS in front (required for service workers).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
# Self-hosted vision models (~94 MB) – downloaded at build time so phones never depend on Hugging Face.
RUN node apps/web/scripts/fetch-models.mjs && npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 RUSQ_STATIC=/app/apps/web/dist RUSQ_DB=/app/apps/server/data/rusq.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/web/dist ./apps/web/dist
VOLUME ["/app/apps/server/data"]
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
