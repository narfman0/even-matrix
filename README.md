# monocle

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
Rust orchestrator (monocle)
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
cargo build --release && ./target/release/monocle
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

The plugin's default server is `srv.blastedstudios.com:4000`. To override, set the `monocle_host` key in EvenHub local storage (format: `host:port`).

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
```

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
