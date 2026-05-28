# Multi-stage build for the monocle Rust orchestrator (axum WS server).
# matrix-sdk links against OpenSSL on Linux, so the builder needs
# pkg-config + libssl-dev and the runtime needs libssl3 + ca-certificates.

FROM rust:1.85-bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin monocle

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libssl3 libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/monocle ./monocle
EXPOSE 4000
# config.toml is mounted at runtime (see docker-compose.yml); never baked in.
ENTRYPOINT ["./monocle", "--config", "config.toml"]
