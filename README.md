# even-matrix

A Rust orchestrator that bridges G2 smart glasses to Matrix messaging rooms via the EvenHub platform.

Browse rooms, read message history, and send voice messages — all from your lens.

## How it works

```
G2 glasses (EvenHub plugin)
  — native list UI for room browsing
  — Web Speech API for voice input
  — WebSocket to Rust server
        |
        v
Rust orchestrator (even-matrix)
  — matrix-sdk login + sync
  — room list, history, live messages
        |
        v
Matrix homeserver (Synapse, Conduit, etc.)
```

## Glasses UI

| Gesture | Action |
|---------|--------|
| Up / Down | Scroll room list |
| Single tap | Enter room / back to room list |
| Double tap | Start voice input (sends to current room) |

Rooms are sorted alphabetically. Returning from a room restores cursor to the last-visited position.

## Setup

**1. Configure**

Create `config.toml` (gitignored):

```toml
[matrix]
homeserver = "https://matrix.example.com"
user_id    = "@you:example.com"
password   = "yourpassword"

[g2]
port = 4000
```

**2. Run the server**

Requires Rust 1.78+.

```bash
cargo run
# or for release
cargo build --release && ./target/release/even-matrix
```

The server logs in, does an initial sync to populate the room cache, then listens on the configured port.

```bash
RUST_LOG=debug cargo run
```

**3. Build and load the EvenHub plugin**

```bash
cd plugin && npm install && npm run build
```

Sideload `plugin/dist/` via EvenHub developer mode → Install from file. Grant network + microphone permissions.

The plugin's default server is `localhost:4000`. To override, set the `even-matrix_host` key in EvenHub local storage (format: `host:port`).

**Loading on device via QR code**

Run the dev server, then generate a QR code pointing at your machine's LAN IP:

```bash
cd plugin && npm run dev
# in another terminal:
evenhub qr --url "http://192.168.1.x:5173"
```

Scan the QR code in the Even app to install the plugin directly from your dev server. Replace `192.168.1.x` with your machine's actual LAN IP.

**Packaging for release**

Build the plugin and package it as an `.ehpk` file for distribution:

```bash
cd plugin && npm run build
evenhub package
```

See the [EvenHub packaging reference](https://hub.evenrealities.com/docs/reference/packaging) for signing and submission details.

**4. Develop with the simulator**

```bash
cd plugin && npm run dev
# in another terminal:
evenhub-simulator http://localhost:5173
# or with automation API for scripted testing:
evenhub-simulator http://localhost:5173 --automation-port 9898
```

## Configuration reference

```toml
[matrix]
homeserver = "https://matrix.example.com"   # Matrix server URL
user_id    = "@you:example.com"             # Full Matrix user ID
password   = "yourpassword"                 # Matrix account password

[g2]
port = 4000   # WebSocket listen port

[whisper]
model_path = "models/ggml-small.bin"        # optional; enables on-device STT
```

Download a model with:

```bash
mkdir models
curl -L -o models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

If `[whisper]` is omitted, voice input is disabled and the server logs a warning.

The model path can also be set via the `WHISPER_MODEL_PATH` environment variable, which takes precedence over `config.toml` and enables whisper even if the `[whisper]` section is absent. This is the recommended approach for Docker:

```bash
mkdir models
curl -L -o models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
docker compose up
```

`docker-compose.yml` sets `WHISPER_MODEL_PATH=/app/models/ggml-small.bin` and mounts `./models` into the container automatically.

## WebSocket protocol

**Client → Server**

| Message | Fields | Description |
|---------|--------|-------------|
| `list_rooms` | — | Request room list |
| `select_room` | `room_id` | Enter a room, receive history |
| `transcript` | `text` | Send voice transcript to selected room |
| `ping` | — | Keepalive |

**Server → Client**

| Event | Fields | Description |
|-------|--------|-------------|
| `room_list` | `rooms: [{id, name}]` | All joined rooms |
| `history` | `room_id`, `messages: [{sender, text, ts}]` | Last 100 messages |
| `message` | `room_id`, `room_alias`, `sender`, `text`, `ts` | Live incoming message |
| `status` | `text` | Server status (e.g. "Sent") |
| `pong` | — | Ping reply |

## Extending

- **New glasses platform**: replace the EvenHub plugin with any WS client that sends `{"type":"transcript","text":"..."}` and handles the server events above.
- **Persistent room cache**: `SessionState` in `src/session.rs` keeps 100 messages per room in RAM; swap in a store if needed.

## License

MIT
