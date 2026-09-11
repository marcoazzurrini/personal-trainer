FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Coolify supplies the revision it checks out. Never bake runtime credentials in.
ARG SOURCE_COMMIT
RUN node --input-type=module -e 'if (!/^[a-f0-9]{40}$/.test(process.env.SOURCE_COMMIT ?? "")) throw new Error("SOURCE_COMMIT must identify the checked-out source")' \
  && npm run build \
  && printf '%s\n' "$SOURCE_COMMIT" > .output/build-revision.txt

FROM node:24-bookworm-slim
WORKDIR /app
# The standalone output and revision stay root-owned and read-only to Node.
COPY --from=build /app/.output ./.output
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node --input-type=module -e 'const r = await fetch("http://127.0.0.1:3000/api/health"); process.exit(r.ok ? 0 : 1)'

STOPSIGNAL SIGTERM
CMD ["node", ".output/server/index.mjs"]
