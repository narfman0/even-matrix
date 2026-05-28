# AGENTS.md

Orientation for AI agents working on this repo.

## What this is

A Rust WebSocket server + EvenHub TypeScript plugin. The Rust binary (`src/`) parses voice transcripts into intents, sends Matrix messages, and streams incoming Matrix messages back to the glasses. The plugin (`plugin/`) runs on the phone inside EvenHub, handles Web Speech API STT, and displays the feed on the lens.

## Project layout

```
src/
  main.rs       — wires everything; tokio runtime, event handler, intent dispatch loop
  config.rs     — TOML config loading (Config, MatrixConfig, G2Config)
  intent.rs     — parse(transcript) → Intent enum; pure keyword matching, no ML
  session.rs    — SessionState: in-memory message history, focused room, pending transcript
  matrix.rs     — MatrixClient wrapper around matrix-sdk; connect, send, sync_settings
  api.rs        — axum WebSocket handler; ClientMsg / ServerEvent JSON envelopes
plugin/
  src/index.ts  — EvenHub plugin: STT, WS client, lens display
  app.json      — EvenHub manifest (network + microphone permissions)
```

## Running tests

```bash
cargo test
```

Tests live in `#[cfg(test)]` modules at the bottom of `intent.rs`, `session.rs`, and `config.rs`. No network or Matrix server required — all unit tests.

## Key invariants

- `parse()` in `intent.rs` is pure and must stay that way — no side effects, no async.
- `SessionState` is never persisted; history resets on restart. Keep it that way unless persistence is explicitly added.
- `MatrixClient` is intentionally not `Clone` — it's always wrapped in `Arc` for sharing.
- Intent dispatch runs in a 100ms poll loop in `main.rs`. If you add a new `Intent` variant, add a match arm there too.
- The WS handler (`api.rs`) only queues transcripts into `session.last_transcript`; actual Matrix I/O stays in the main loop.

## Adding a new voice command

1. Add a variant to `Intent` in `intent.rs`.
2. Add a parse branch in `parse()`.
3. Add a `match` arm in the intent dispatch loop in `main.rs`.
4. Add a unit test in `intent.rs`.

## Changing the WebSocket protocol

`ClientMsg` (phone → server) and `ServerEvent` (server → phone) are in `api.rs`. Both are serde JSON. The plugin in `plugin/src/index.ts` must match — update both sides together.

## Dependencies to watch

- `matrix-sdk 0.10` — pinned; the API changes significantly across versions. Check migration notes before bumping.
- `axum 0.7` — WebSocket type is `axum::extract::ws::Message::Text(Utf8Bytes)`, not a plain `String`. Axum 0.8 changes this again.
- Web Speech API in EvenHub — availability depends on the phone's WebView runtime. The plugin falls back gracefully if unavailable.
