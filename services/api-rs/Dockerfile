# amd64 only (Rust + OpenSSL, no cross build). CI pushes it as a plain single-platform
# manifest so that arm64 hosts can pull it and run it under emulation.
FROM rust:1.95 AS build
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN CARGO_PROFILE_RELEASE_LTO=false cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Build version stamped in by CI (--build-arg APP_VERSION=0.1.<run_number>).
# Exposed at runtime via current_version() → GET /api/config/public { version }.
ARG APP_VERSION=dev
ENV GCTRL_VERSION=$APP_VERSION
COPY --from=build /app/target/release/gctrl-api .
EXPOSE 4000
CMD ["./gctrl-api"]
