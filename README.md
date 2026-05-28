# g2-matrix

Voice-driven Matrix messaging for Even Realities G2 smart glasses.

Say a command, get a reply on your lens. No phone required.

---

## Architecture

```
G2 Glasses (EvenHub plugin)
        |
        |  WebSocket (ws://localhost:4000/ws)
        |  JSON messages both directions
        v
Rust orchestrator  (g2-matrix binary)
        |
        |  matrix-sdk (HTTPS + sync)
        |
        v
Matrix homeserver  (Synapse / Conduit / etc.)
```

### Component summary

| Component | Path | Role |
|-----------|------|------|
| Rust binary | `src/` | WebSocket server, intent parsing, Matrix SDK |
| EvenHub plugin | `plugin/` | Glasses UI, Web Speech API STT, ring gesture input |

### Data flow

1. User holds ring button → plugin starts Web Speech recognition
2. Transcript sent to Rust via `{"type":"transcript","text":"..."}` WebSocket message
3. Rust parses intent (`tell`, `reply`, `focus`, `check`, fallback)
4. On `send`/`reply`: matrix-sdk posts to the target room
5. Incoming Matrix messages arrive via background sync → broadcast to all WS clients
6. Plugin renders the last status line + up to 6 feed lines on the lens display

---

## Setup

### 1. Matrix access token

You need a Matrix user and an access token. The easiest way:

```bash
curl -XPOST https://matrix.example.com/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","user":"you","password":"secret"}'
# copy "access_token" from the response
```

### 2. config.toml

```bash
cp config.example.toml config.toml
$EDITOR config.toml
```

Fill in:
- `matrix.homeserver` — your Matrix server URL
- `matrix.user_id` — your full Matrix ID (`@you:example.com`)
- `matrix.token` — access token from step 1
- `[rooms]` — friendly alias → room ID mappings
- `g2.port` — port the WS server listens on (default 4000)
- `g2.token` — optional bearer token (not yet enforced, reserved for future auth)

Room IDs look like `!abc123:example.com`. Find them in your Matrix client's room settings.

### 3. Build and run the Rust orchestrator

Requires Rust 1.78+ and the `sqlite` feature dependencies (OpenSSL / pkg-config on Linux):

```bash
cargo build --release
./target/release/g2-matrix --config config.toml
```

Or during development:

```bash
cargo run -- --config config.toml
```

The server logs to stdout. Set `RUST_LOG=debug` for verbose output.

### 4. Build the EvenHub plugin

```bash
cd plugin
npm install
npm run build
# output: plugin/dist/
```

### 5. Sideload the plugin onto G2

Follow the [EvenHub developer docs](https://docs.evenrealities.com/evenapp/developer/) to sideload:

1. Open EvenHub on your phone
2. Developer mode → Install from file
3. Select `plugin/dist/` (or zip it first if required)
4. Grant network + microphone permissions when prompted

The plugin connects to `ws://localhost:4000/ws` — your phone and the machine running the Rust binary must be on the same network, **or** you can run the binary on the phone itself if you have a local Linux environment (e.g. Termux).

---

## Voice commands

| You say | What happens |
|---------|-------------|
| `tell wife I'm on my way` | Sends "I'm on my way" to the `wife` room |
| `send to work meeting in 5` | Sends "meeting in 5" to the `work` room |
| `reply sounds good` | Replies in the currently focused room |
| `switch to wife` | Focuses the `wife` room |
| `focus work` | Focuses the `work` room |
| `check messages` | Summarises the last 3 messages on the lens |
| Anything else | Echoed back as "Unknown: ..." for debugging |

### Ring gestures

| Gesture | Action |
|---------|--------|
| Single tap | Ping (keep-alive / future: cycle rooms) |
| Double tap | Start voice recognition |

---

## Configuration reference

```toml
[matrix]
homeserver = "https://matrix.example.com"   # Matrix server base URL
user_id    = "@you:example.com"             # Your Matrix user ID (informational)
token      = "syt_..."                      # Access token

[rooms]
# Friendly alias = room ID
# Add as many rooms as you like
default = "!abc:example.com"
wife    = "!def:example.com"
work    = "!ghi:example.com"

[g2]
port  = 4000        # WebSocket listen port
token = "changeme"  # Reserved — not yet enforced
```

---

## Development notes

- The intent parser (`src/intent.rs`) is plain keyword matching — no ML dependency.
  Extend `parse()` to add new commands.
- `SessionState` keeps the last 20 messages in memory; no persistence between restarts.
- The plugin uses Web Speech API which is Chromium-based; availability on EvenHub depends on the runtime. If unavailable, the status line will say "No STT available".
- `matrix-sdk` stores its E2EE session state in an SQLite file alongside the binary (feature flag `sqlite`). Delete it to force a fresh login.
