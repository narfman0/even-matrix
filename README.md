# even-matrix

Matrix messaging from your even glasses.

An EvenHub plugin that talks directly to your Matrix homeserver — no backend server required.

Browse rooms, read message history, and send voice messages — all from your lens.

## How it works

```
G2 glasses (EvenHub plugin)
  — native list UI for room browsing
  — voice input via optional Whisper server
  — Matrix Client-Server API (fetch directly)
        |
        v
Matrix homeserver (Synapse, Conduit, etc.)
```

## Glasses UI

| Gesture | Action |
|---------|--------|
| Up / Down | Scroll room list |
| Single tap | Enter room |
| Back gesture | Return to room list |
| Double tap | Start voice input |

## Setup

**1. Build and load the plugin**

```bash
cd plugin && npm install && npm run build
```

Sideload `plugin/dist/` via EvenHub developer mode → Install from file. Grant network + microphone permissions.

**2. Configure credentials**

Open the plugin settings (⚙ button), enter your homeserver URL and username, then tap **Login**. The plugin stores the access token in EvenHub local storage — your password is never saved.

**Optional: voice input**

Set a Whisper URL (e.g. `http://yourserver:8000`) in settings and tap **Save**. The plugin records audio on double-tap and POSTs it to `POST /v1/audio/transcriptions` (OpenAI-compatible). Leaving the field blank disables voice send (recording still works but audio is discarded).

[speaches](https://github.com/speaches-ai/speaches) is a good self-hosted option.

**3. Load on device via QR code**

```bash
cd plugin && npm run dev
# in another terminal:
evenhub qr --url "http://192.168.1.x:5173"
```

Scan the QR code in the Even app. Replace `192.168.1.x` with your machine's LAN IP.

**4. Package for release**

```bash
cd plugin && npm run package
```

See the [EvenHub packaging reference](https://hub.evenrealities.com/docs/reference/packaging) for signing and submission details.

**5. Develop with the simulator**

```bash
cd plugin && npm run dev
# in another terminal:
evenhub-simulator http://localhost:5173
```

## Running tests

```bash
cd plugin && npm test
```

## License

MIT
