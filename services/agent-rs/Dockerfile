FROM rust:1.78-alpine AS build
RUN apk add --no-cache musl-dev pkgconfig
WORKDIR /app

# Cache dependencies layer
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs \
    && cargo build --release --locked \
    && rm -f target/release/gctrl-agent target/release/deps/gctrl_agent*

# Build actual binary
COPY src ./src
RUN cargo build --release --locked

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /app/target/release/gctrl-agent .
EXPOSE 7070
CMD ["./gctrl-agent"]
