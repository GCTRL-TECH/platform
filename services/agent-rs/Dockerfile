FROM rust:1.78-alpine AS build
RUN apk add --no-cache musl-dev pkgconfig perl make openssl-dev openssl-libs-static
WORKDIR /app
COPY . .
RUN CARGO_PROFILE_RELEASE_LTO=false cargo build --release

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build /app/target/release/gctrl-agent .
EXPOSE 7070
CMD ["./gctrl-agent"]
