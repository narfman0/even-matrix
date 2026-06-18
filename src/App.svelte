<script lang="ts">
  import { onMount } from 'svelte'
  import {
    waitForEvenAppBridge,
    TextContainerProperty,
    CreateStartUpPageContainer,
  } from '@evenrealities/even_hub_sdk'
  import { createPlugin } from './plugin'
  import { MatrixRestClient } from './matrix-client'
  import { MatrixSdkClient } from './matrix-sdk-client'
  import { formatAge, visibleLines } from './message-utils'
  import {
    STORAGE_HOMESERVER,
    STORAGE_ACCESS_TOKEN,
    STORAGE_USER_ID,
    STORAGE_USERNAME,
    STORAGE_SYNC_TOKEN,
    STORAGE_WHISPER_URL,
    STORAGE_WHISPER_MODEL,
    STORAGE_DEVICE_ID,
  } from './storage-keys'
  import appJson from '../app.json'
  import MessageList from './MessageList.svelte'
  import SettingsPanel from './SettingsPanel.svelte'

  const CONTAINER_ID = 1
  const APP_VERSION: string = appJson.version

  type Plugin = ReturnType<typeof createPlugin>
  type PluginState = ReturnType<Plugin['getState']>

  let state = $state<PluginState>({
    hierarchy: { dms: [], spaces: [], orphans: [] },
    displayedRooms: [],
    selectedRoomId: null,
    lines: [],
    mentions: [],
    mentioned: false,
    view: 'rooms',
    loadingRoomName: '',
    transcribedText: '',
    recognizing: false,
    scrollOffset: 0,
    matrixConnected: false,
    errors: [],
    syncToken: null,
    prevBatch: null,
    loadingMore: false,
    audioLevel: 0,
    lastSyncAt: null,
    whisperConfigured: false,
    audioBufBytes: 0,
    audioMaxBytes: 10 * 1024 * 1024,
    unreadRooms: [],
    verificationRequest: null,
    verificationEmoji: [],
  })
  let settingsOpen = $state(false)
  let previewOpen = $state(false)
  let msgInput = $state('')
  let e2eeTrusted = $state(false)

  // Settings props for SettingsPanel
  let settingsHomeserver = $state('')
  let settingsUsername = $state('')
  let settingsWhisperUrl = $state('')
  let settingsWhisperModel = $state('Systran/faster-distil-whisper-small.en')

  let plugin: Plugin | null = null
  let bridge: any = null
  let matrixClient: import('./matrix-sdk-client').MatrixSdkClient | null = null

  function glassesPreviewText(): string {
    switch (state.view) {
      case 'rooms': return state.displayedRooms.map(r => r.name).join('\n') || '(no rooms)'
      case 'loading': return `Loading ${state.loadingRoomName}...`
      case 'listening': return state.transcribedText || 'Listening...'
      case 'transcribing': return state.transcribedText || 'Transcribing...'
      case 'sending': return `Sending: ${state.transcribedText}`
      case 'messages': {
        const vl = visibleLines(state.lines, state.scrollOffset)
        return vl.join('\n') || '(no messages)'
      }
      case 'verification': return `Verify device\n${state.verificationEmoji.join(' ')}\nTap=confirm Back=reject`
      default: return ''
    }
  }

  async function selectRoom(index: number, id: string) {
    await plugin?.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: index } })
  }

  async function sendText() {
    if (!msgInput.trim()) return
    await plugin?.sendMessage(msgInput.trim())
    msgInput = ''
  }

  async function loadMore() {
    await plugin?.loadMoreHistory()
  }

  onMount(async () => {
    bridge = await waitForEvenAppBridge()

    await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [new TextContainerProperty({
          xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, paddingLength: 4,
          containerID: CONTAINER_ID, containerName: 'status',
          content: 'Connecting...', isEventCapture: 1,
        })],
      })
    )

    const homeserver    = await bridge.getLocalStorage(STORAGE_HOMESERVER).catch(() => '')
    const accessToken   = await bridge.getLocalStorage(STORAGE_ACCESS_TOKEN).catch(() => '')
    const userId        = await bridge.getLocalStorage(STORAGE_USER_ID).catch(() => '')
    const syncToken     = await bridge.getLocalStorage(STORAGE_SYNC_TOKEN).catch(() => null)
    const whisperUrl    = await bridge.getLocalStorage(STORAGE_WHISPER_URL).catch(() => null)
    const whisperMdl    = await bridge.getLocalStorage(STORAGE_WHISPER_MODEL).catch(() => null)
    const savedUser     = await bridge.getLocalStorage(STORAGE_USERNAME).catch(() => '')
    const deviceId      = await bridge.getLocalStorage(STORAGE_DEVICE_ID).catch(() => '')

    settingsHomeserver = homeserver
    settingsUsername = savedUser
    settingsWhisperUrl = whisperUrl ?? ''
    if (whisperMdl) settingsWhisperModel = whisperMdl

    if (!homeserver || !accessToken) {
      settingsOpen = true
      return
    }

    matrixClient = new MatrixSdkClient(homeserver, accessToken, userId, deviceId || '')
    const matrix = matrixClient
    plugin = createPlugin(bridge, matrix, whisperUrl || null, settingsWhisperModel, () => {
      state = plugin!.getState()
      const s = plugin!.getState()
      if (s.syncToken) bridge.setLocalStorage(STORAGE_SYNC_TOKEN, s.syncToken)
    }, userId)
    bridge.onEvenHubEvent(plugin.handleEvenHubEvent)
    await plugin.start(syncToken)
    plugin.setupVerificationHandler()
    matrix.getCrossSigningStatus?.().then((s: string) => { e2eeTrusted = s === 'ready' }).catch(() => {})
  })
</script>

<div id="status-bar">
  <span id="view-label">{settingsOpen ? 'settings' : state.view}</span>
  <button id="preview-btn" title="Glasses Preview" onclick={() => (previewOpen = !previewOpen)}>
    {previewOpen ? '🕶' : '👓'}
  </button>
  <button id="settings-btn" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}>
    {settingsOpen ? '✕' : '⚙'}
  </button>
</div>

{#if !settingsOpen}
  <div id="health-strip">
    <span class:dot-green={state.matrixConnected} class:dot-grey={!state.matrixConnected}>●</span>
    Matrix
    {#if state.lastSyncAt}· {formatAge(state.lastSyncAt)} ago{/if}
    &nbsp;&nbsp;
    <span class:dot-green={state.whisperConfigured} class:dot-grey={!state.whisperConfigured}>◉</span>
    STT
    &nbsp;&nbsp;
    <span class:dot-green={e2eeTrusted} class:dot-grey={!e2eeTrusted}>🔐</span>
    E2EE
    {#if state.mentioned}&nbsp;&nbsp;<span class="mention-flag">● mention</span>{/if}
  </div>
{/if}

{#if previewOpen && !settingsOpen}
  <div id="glasses-preview">
    <div id="glasses-screen">
      <pre>{glassesPreviewText()}</pre>
    </div>
  </div>
{/if}

{#if !settingsOpen && (state.view === 'messages' || state.view === 'listening' || state.view === 'loading')}
  <div id="controls">
    {#if state.view === 'messages'}
      <button class="ctrl-btn" onclick={() => plugin?.handleEvenHubEvent({ sysEvent: {} })}>Back</button>
      <input id="msg-input" type="text" placeholder="Type a message..."
        bind:value={msgInput}
        onkeydown={(e) => e.key === 'Enter' && sendText()} />
      <button class="ctrl-btn primary" onclick={sendText}>Send</button>
      <button class="ctrl-btn" onclick={() => plugin?.startAudio()}>🎤</button>
    {:else if state.view === 'loading'}
      <button class="ctrl-btn" onclick={() => plugin?.showRoomList()}>Back</button>
    {:else}
      <button class="ctrl-btn danger" onclick={() => plugin?.stopAudio()}>Stop</button>
    {/if}
  </div>
{/if}

{#if settingsOpen}
  <SettingsPanel
    errors={state.errors}
    {bridge}
    homeserver={settingsHomeserver}
    username={settingsUsername}
    whisperUrl={settingsWhisperUrl}
    whisperModel={settingsWhisperModel}
    appVersion={APP_VERSION}
    matrix={matrixClient}
  />
{:else}
  <div id="content">
    {#if state.view === 'rooms'}
      {#if state.displayedRooms.length === 0}
        <div class="no-rooms">No rooms</div>
      {:else}
        {#each state.displayedRooms as item, index}
          {#if item.isHeader}
            <div class="section-header">{item.name}</div>
          {:else}
            <div
              class="room-item"
              class:selected={item.id === state.selectedRoomId}
              onclick={() => selectRoom(index, item.id)}
            >
              {item.name}
              {#if state.unreadRooms.includes(item.id)}<span class="unread-dot"></span>{/if}
            </div>
          {/if}
        {/each}
      {/if}
    {:else if state.view === 'loading'}
      <div class="loading-indicator">
        <div class="spinner">↻</div>
        Loading {state.loadingRoomName}...
      </div>
    {:else if state.view === 'listening'}
      <div class="listening-indicator">
        <div class="pulse"></div>{state.transcribedText || 'Listening...'}
      </div>
      <div class="level-track">
        <div class="level-bar" style="width: {Math.round(state.audioLevel * 100)}%"></div>
      </div>
      <div class="buf-gauge">
        🎙 {(state.audioBufBytes / 32000).toFixed(1)}s / {(state.audioMaxBytes / 32000).toFixed(0)}s
      </div>
    {:else if state.view === 'transcribing'}
      <div class="transcribing-indicator">
        <div class="spinner">↻</div>
        {state.transcribedText || 'Transcribing...'}
      </div>
    {:else if state.view === 'sending'}
      <div class="sending-indicator">
        <div class="spinner">↻</div>
        Sending: {state.transcribedText}
      </div>
    {:else if state.view === 'verification'}
      <div class="verification-view">
        <div class="verif-heading">Verify Device</div>
        {#if state.verificationEmoji.length === 0}
          <div class="verif-waiting">Waiting for emoji…</div>
        {:else}
          <div class="verif-emoji">{state.verificationEmoji.join(' ')}</div>
          <div class="verif-hint">Match these on your other device</div>
          <div class="verif-actions">
            <button class="ctrl-btn primary" onclick={() => plugin?.confirmVerification()}>✓ Match</button>
            <button class="ctrl-btn danger" onclick={() => plugin?.rejectVerification()}>✗ No match</button>
          </div>
        {/if}
      </div>
    {:else}
      <MessageList lines={state.lines} scrollOffset={state.scrollOffset} mentions={state.mentions} />
      {#if state.prevBatch !== null}
        <button class="load-more-btn" onclick={loadMore} disabled={state.loadingMore}>
          {state.loadingMore ? 'Loading...' : 'Load more'}
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  :global(*) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) { font-family: monospace; background: #111; color: #eee; font-size: 14px; }

  #status-bar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 12px; background: #222; border-bottom: 1px solid #333;
    position: sticky; top: 0; z-index: 10;
  }
  #view-label { font-size: 12px; color: #888; }
  #settings-btn {
    background: none; border: none; color: #888; font-size: 16px;
    cursor: pointer; padding: 0 4px; line-height: 1;
  }
  #settings-btn:hover { color: #eee; }
  #content { padding: 8px 12px; min-height: 200px; }
  .room-item {
    padding: 6px 8px; border-radius: 4px; cursor: pointer;
    border: 1px solid #333; margin-bottom: 4px;
  }
  .room-item.selected { border-color: #4caf50; background: #1a2e1a; }
  .room-item:hover { background: #1e1e1e; }
  .section-header {
    padding: 4px 8px; font-size: 11px; color: #888;
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid #333; margin-top: 8px; cursor: default;
  }
  .no-rooms { color: #555; padding: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .load-more-btn {
    display: block; width: 100%; margin-top: 8px; padding: 6px;
    background: none; border: 1px solid #333; color: #666;
    font-family: monospace; font-size: 13px; cursor: pointer; border-radius: 4px;
  }
  .load-more-btn:hover { border-color: #555; color: #aaa; }
  .loading-indicator {
    display: flex; align-items: center; gap: 8px;
    padding: 16px; color: #888; font-size: 16px;
  }
  .spinner {
    display: inline-block; animation: spin 0.7s linear infinite; font-size: 20px;
  }
  .listening-indicator {
    display: flex; align-items: center; gap: 8px;
    padding: 16px; color: #4caf50; font-size: 16px;
  }
  .transcribing-indicator {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 16px; color: #7eb8f7; font-size: 16px;
    white-space: pre-wrap; word-break: break-word;
  }
  .sending-indicator {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 16px; color: #f7c67e; font-size: 16px;
    white-space: pre-wrap; word-break: break-word;
  }
  .pulse {
    width: 12px; height: 12px; border-radius: 50%; background: #4caf50;
    animation: pulse 1s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; } 50% { opacity: 0.3; }
  }
  .level-track {
    height: 6px; background: #222; border-radius: 3px;
    margin: 4px 12px; overflow: hidden;
  }
  .level-bar {
    height: 100%; background: #4caf50; border-radius: 3px;
    transition: width 0.1s ease;
    max-width: 100%;
  }
  #controls {
    display: flex; justify-content: space-between; align-items: center;
    padding: 6px 12px; background: #1a1a1a; border-bottom: 1px solid #333;
    gap: 8px;
  }
  .ctrl-btn {
    padding: 6px 14px; border-radius: 4px; border: 1px solid #444;
    background: #2a2a2a; color: #eee; font-family: monospace; font-size: 13px;
    cursor: pointer;
  }
  .ctrl-btn:active { background: #3a3a3a; }
  .ctrl-btn.primary { border-color: #4caf50; color: #4caf50; }
  .ctrl-btn.danger  { border-color: #f44336; color: #f44336; }
  #msg-input {
    flex: 1; min-width: 0; background: #1e1e1e; border: 1px solid #444; color: #eee;
    font-family: monospace; font-size: 13px; padding: 5px 8px;
    border-radius: 4px; outline: none;
  }
  #msg-input:focus { border-color: #666; }
  #health-strip {
    font-size: 10px; padding: 3px 12px; background: #181818;
    border-bottom: 1px solid #2a2a2a; color: #666; white-space: nowrap;
    display: flex; align-items: center; gap: 4px;
  }
  .dot-green { color: #4caf50; }
  .dot-grey  { color: #444; }
  .mention-flag { color: #f7c67e; font-weight: bold; }
  #preview-btn {
    background: none; border: none; color: #888; font-size: 16px;
    cursor: pointer; padding: 0 4px; line-height: 1;
  }
  #preview-btn:hover { color: #eee; }
  #glasses-preview {
    display: flex; justify-content: center; padding: 8px; background: #111;
    border-bottom: 1px solid #2a2a2a;
  }
  #glasses-screen {
    width: 288px; height: 144px; background: #000; border: 1px solid #333;
    font-size: 10px; font-family: monospace; overflow: hidden;
    padding: 4px; white-space: pre-wrap;
  }
  #glasses-screen pre { margin: 0; font-family: inherit; font-size: inherit; }
  .buf-gauge {
    font-size: 11px; color: #555; padding: 2px 12px;
  }
  .unread-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #4caf50;
    display: inline-block; margin-left: 6px; vertical-align: middle;
  }
  .verification-view { padding: 16px; }
  .verif-heading { font-size: 13px; color: #f7c67e; margin-bottom: 8px; font-weight: bold; }
  .verif-waiting { font-size: 12px; color: #888; }
  .verif-emoji { font-size: 28px; letter-spacing: 4px; margin: 12px 0; }
  .verif-hint { font-size: 11px; color: #888; margin-bottom: 12px; }
  .verif-actions { display: flex; gap: 12px; }
</style>
