# GCTRL dashboard (React + nginx). Built multi-arch (amd64 + arm64) in CI so it
# runs natively on Apple Silicon — no platform-mismatch warning on a Mac install.
# Stage 1: Build
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first (cache layer)
COPY package*.json ./
RUN npm ci --prefer-offline --legacy-peer-deps

# Copy source and build. APP_VERSION is stamped in by CI
# (--build-arg APP_VERSION=0.1.<run_number>); Vite bakes VITE_BUILD_VERSION
# into the bundle so the dashboard can show which build is running.
COPY . .
ARG APP_VERSION=dev
ENV VITE_BUILD_VERSION=$APP_VERSION
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy built assets (includes public/install, public/update, etc. from Vite build)
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
