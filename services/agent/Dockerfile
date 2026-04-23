FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npx pkg dist/index.js --target node20-linux-x64 --output gctrl-agent

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/gctrl-agent ./gctrl-agent
VOLUME /app/config
EXPOSE 7070
CMD ["./gctrl-agent"]
