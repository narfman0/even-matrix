# AGENTS.md

Orientation for AI agents working on this repo.

## What this is

A Rust WebSocket server + EvenHub TypeScript plugin. The Rust binary logs into Matrix, syncs rooms, and streams messages to/from the glasses. The plugin runs on the phone inside EvenHub, shows a native room list UI, handles voice input via Web Speech API, and displays messages on the lens.

## Project layout

```
src/
  main.rs       — tokio runtime; Matrix event handler; transcript dispatch loop
  config.rs     — TOML config loading (Config, MatrixConfig, G2Config)
  session.rs    — SessionState: per-room message cache, selected room, pending transcript
  matrix.rs     — MatrixClient: login, sync_once on startup, list_rooms, send_to_room_id
  api.rs        — axum WebSocket handler; ClientMsg / ServerEvent JSON envelopes
plugin/
  src/index.ts  — EvenHub plugin: room list UI, navigation, voice STT, WS client
  app.json      — EvenHub manifest (network + microphone permissions)
config.toml     — local config (gitignored; see README for format)
```

## Running tests

```bash
cargo test
```

Tests live in `#[cfg(test)]` modules in `session.rs` and `config.rs`. No network or Matrix server required.

## Key invariants

- `MatrixClient::connect()` calls `sync_once()` before returning, so `joined_rooms()` is populated by the time the WebSocket server starts accepting connections.
- `MatrixClient` is intentionally not `Clone` — always wrapped in `Arc`.
- `SessionState` is never persisted; history resets on restart.
- The transcript dispatch loop in `main.rs` polls every 100ms. It sends to `selected_room` if set, otherwise falls back to the first joined room.
- The WS handler only queues transcripts into `session.last_transcript`; actual Matrix I/O stays in the dispatch loop.
- `matrix-sdk` is built with `default-features = false, features = ["native-tls"]` — no SQLite dependency (avoids LNK1181 on Windows).

## Plugin navigation model

The glasses have three input events (via `onEvenHubEvent`):

| Event | When fired |
|-------|-----------|
| `listEvent` (no eventType or CLICK=0) | User clicks a list item — `currentSelectItemIndex` is set, `currentSelectItemName` is not |
| `sysEvent` (no eventType) | Single tap in text/message view |
| `sysEvent` eventType=3 (DOUBLE_CLICK) | Double tap anywhere |

Plugin state machine:

- **rooms view**: `listEvent` click → send `select_room`, switch to messages view
- **messages view**: `sysEvent` click (no eventType) → back to rooms view
- **messages view**: `sysEvent` DOUBLE_CLICK → start voice → send `transcript`

Rooms are sorted alphabetically. `displayedRooms` tracks the current sorted order (used to map click index → room id). `lastSelectedIndex` records the last clicked index for future cursor-restore support.

## Changing the WebSocket protocol

`ClientMsg` (phone → server) and `ServerEvent` (server → phone) are in `api.rs`. Both are serde JSON with `#[serde(tag = "type", rename_all = "snake_case")]`. The plugin in `plugin/src/index.ts` must match — update both sides together.

## Simulator

Use `evenhub-simulator http://localhost:5173` for local development. Add `--automation-port 9898` to enable the HTTP automation API:

- `GET /api/console` — webview console logs (supports `?since_id=N`)
- `POST /api/input` — send `{"action": "up"|"down"|"click"|"double_click"}`
- `GET /api/screenshot/glasses` — current glasses display as PNG

The simulator fires `currentSelectItemIndex` on list clicks but not `currentSelectItemName` — always use the index for room lookup.

## Dependencies to watch

- `matrix-sdk 0.10` — pinned; API changes significantly across versions. Check migration notes before bumping. Built with `default-features = false` to avoid the SQLite system dependency.
- `axum 0.7` — WebSocket message is `Message::Text(Utf8Bytes)`. Axum 0.8 changes this again.
- Web Speech API — availability depends on the phone's WebView. Plugin falls back gracefully if unavailable.
- `@evenrealities/even_hub_sdk` — install `@evenrealities/evenhub-simulator` globally for local dev.
