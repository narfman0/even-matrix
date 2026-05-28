# g2-matrix

A lightweight Rust orchestrator that bridges smart glasses voice commands to Matrix messaging rooms.

Say a command → it sends or reads a Matrix message → the response appears on your lens.

## How it works

```
EvenHub plugin (phone)
  — Web Speech API STT
  — WebSocket to Rust server
        |
        v
Rust orchestrator
  — keyword intent routing
  — matrix-sdk (HTTPS + E2EE-capable)
        |
        v
Matrix homeserver (Synapse, Conduit, etc.)
```

## Voice commands

| Say | Action |
|-----|--------|
| `tell wife I'm boarding` | Send to `wife` room |
| `send to work server down` | Send to `work` room |
| `reply sounds good` | Reply in focused room |
| `switch to wife` / `focus work` | Change active room |
| `check messages` | Summarise last 3 messages on lens |

Ring gestures: **single tap** → ping / **double tap** → start voice.

## Setup

**1. Get a Matrix access token**

```bash
curl -XPOST https://matrix.example.com/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"you","password":"secret"}'
```

Copy `access_token` from the response.

**2. Configure**

```bash
cp config.example.toml config.toml
$EDITOR config.toml
```

Fill in homeserver, user_id, token, and your room aliases. Room IDs (`!abc:example.com`) are in your Matrix client's room settings.

**3. Run the Rust server**

Requires Rust 1.78+, OpenSSL/pkg-config on Linux.

```bash
cargo build --release
./target/release/g2-matrix --config config.toml
```

```bash
RUST_LOG=debug cargo run -- --config config.toml
```

**4. Build the EvenHub plugin**

```bash
cd plugin && npm install && npm run build
```

Sideload `plugin/dist/` via EvenHub developer mode → Install from file. Grant network + microphone permissions. The plugin connects to `ws://localhost:4000/ws` — the Rust server and your phone must be on the same network (or use Tailscale).

## Configuration reference

```toml
[matrix]
homeserver = "https://matrix.example.com"
user_id    = "@you:example.com"
token      = "syt_..."

[rooms]
default = "!abc:example.com"
wife    = "!def:example.com"
work    = "!ghi:example.com"

[g2]
port  = 4000      # WebSocket listen port
token = "changeme" # reserved for future bearer auth
```

## Extending

- **New voice commands**: edit `src/intent.rs` — pure keyword matching, no ML.
- **New glasses platform**: replace the EvenHub plugin with any WS client that sends `{"type":"transcript","text":"..."}`.
- **Persistent history**: `SessionState` in `src/session.rs` keeps 20 messages in RAM; swap in SQLite if needed.

## License

MIT
