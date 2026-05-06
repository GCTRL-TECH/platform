FROM rust:1.85 AS build
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN CARGO_PROFILE_RELEASE_LTO=false cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/gctrl-agent .
EXPOSE 7070
CMD ["./gctrl-agent"]
