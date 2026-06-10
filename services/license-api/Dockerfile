FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 4000
# Reconcile schema on every boot (idempotent), then start the API.
# If migrate.ts fails fatally the container exits and Docker restarts it —
# but the script is written to log warnings and continue on per-statement errors.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
