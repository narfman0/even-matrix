<script lang="ts">
  import { onMount } from 'svelte'
  import {
    waitForEvenAppBridge,
    TextContainerProperty,
    CreateStartUpPageContainer,
  } from '@evenrealities/even_hub_sdk'
  import { createPlugin, pcmToWav } from './plugin'
  import { MatrixRestClient } from './matrix-client'
  import appJson from '../app.json'

  const CONTAINER_ID = 1
  const APP_VERSION: string = appJson.version

  type Plugin = ReturnType<typeof createPlugin>
  type PluginState = ReturnType<Plugin['getState']>

  let state = $state<PluginState>({
    hierarchy: { dms: [], spaces: [], orphans: [] },
    displayedRooms: [],
    selectedRoomId: null,
    lines: [],
    view: 'rooms',
    loadingRoomName: '',
    transcribedText: '',
    recognizing: false,
    scrollOffset: 0,
    matrixConnected: false,
    errors: [],
    syncToken: null,
  })
  let settingsOpen = $state(false)
  let hsValue = $state('')
  let userValue = $state('')
  let passValue = $state('')
  let whisperValue = $state('')
  let whisperModel = $state('Systran/faster-distil-whisper-small.en')
  let saveStatus = $state('')
  let saveColor = $state('#888')
  let msgInput = $state('')

  let plugin: Plugin | null = null
  let bridge: any = null

  function visibleLines(): string[] {
    const { lines, scrollOffset } = state
    return lines
      .slice(Math.max(0, lines.length - 20 - scrollOffset), lines.length - scrollOffset)
      .reverse()
  }

  const SENDER_COLORS = [
    '#7eb8f7', '#f7c67e', '#b8f77e', '#f77eb8',
    '#7ef7e8', '#c67ef7', '#f7f07e', '#f7907e',
  ]

  function senderColor(sender: string): string {
    let hash = 0
    for (let i = 0; i < sender.length; i++) hash = (hash * 31 + sender.charCodeAt(i)) >>> 0
    return SENDER_COLORS[hash % SENDER_COLORS.length]
  }

  function parseLine(line: string): { sender: string; text: string } | null {
    const colon = line.indexOf(': ')
    if (colon === -1) return null
    return { sender: line.slice(0, colon), text: line.slice(colon + 2) }
  }

  async function saveCredentials() {
    try {
      const result = await MatrixRestClient.login(hsValue.trim(), userValue.trim(), passValue)
      await bridge.setLocalStorage('even_matrix_homeserver', hsValue.trim())
      await bridge.setLocalStorage('even_matrix_username', userValue.trim())
      await bridge.setLocalStorage('even_matrix_access_token', result.access_token)
      await bridge.setLocalStorage('even_matrix_user_id', result.user_id)
      await bridge.setLocalStorage('even_matrix_device_id', result.device_id)
      passValue = ''
      saveStatus = 'Logged in. Reloading...'
      saveColor = '#4caf50'
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      saveStatus = `Login failed: ${e}`
      saveColor = '#f44336'
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

  async function saveWhisper() {
    try {
      await bridge.setLocalStorage('even_matrix_whisper_url', whisperValue.trim())
      await bridge.setLocalStorage('even_matrix_whisper_model', whisperModel.trim())
      saveStatus = 'Saved. Reloading...'
      saveColor = '#4caf50'
      setTimeout(() => window.location.reload(), 800)
    } catch {
      saveStatus = 'Save failed.'
      saveColor = '#f44336'
    }
  }

  async function testWhisper() {
    const url = whisperValue.trim()
    if (!url) { saveStatus = 'Enter a Whisper URL first.'; saveColor = '#f44336'; return }
    saveStatus = 'Testing...'
    saveColor = '#888'
    try {
      const silence = new Uint8Array(16000 * 2)
      const wav = pcmToWav(silence, 16000)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'test.wav')
      form.append('model', whisperModel.trim())
      const res = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(10000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      const json = await res.json() as { text?: string }
      saveStatus = 'OK ✓'
      saveColor = '#4caf50'
    } catch (e) {
      saveStatus = `Whisper test failed: ${e}`
      saveColor = '#f44336'
    }
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

    const homeserver    = await bridge.getLocalStorage('even_matrix_homeserver').catch(() => '')
    const accessToken   = await bridge.getLocalStorage('even_matrix_access_token').catch(() => '')
    const userId        = await bridge.getLocalStorage('even_matrix_user_id').catch(() => '')
    const syncToken     = await bridge.getLocalStorage('even_matrix_sync_token').catch(() => null)
    const whisperUrl    = await bridge.getLocalStorage('even_matrix_whisper_url').catch(() => null)
    const whisperMdl    = await bridge.getLocalStorage('even_matrix_whisper_model').catch(() => null)
    const savedUser     = await bridge.getLocalStorage('even_matrix_username').catch(() => '')
    const savedRoomId   = await bridge.getLocalStorage('even_matrix_selected_room').catch(() => null)

    hsValue = homeserver
    userValue = savedUser
    whisperValue = whisperUrl ?? ''
    if (whisperMdl) whisperModel = whisperMdl

    if (!homeserver || !accessToken) {
      settingsOpen = true
      return
    }

    const matrix = new MatrixRestClient(homeserver, accessToken, userId)
    plugin = createPlugin(bridge, matrix, whisperUrl || null, whisperModel, () => {
      state = plugin!.getState()
      const s = plugin!.getState()
      if (s.syncToken) bridge.setLocalStorage('even_matrix_sync_token', s.syncToken)
      if (s.selectedRoomId) bridge.setLocalStorage('even_matrix_selected_room', s.selectedRoomId)
    })
    bridge.onEvenHubEvent(plugin.handleEvenHubEvent)
    await plugin.start(syncToken)
    if (savedRoomId) await plugin.navigateToRoom(savedRoomId)
  })
</script>

<div id="status-bar">
  <span id="view-label">{settingsOpen ? 'settings' : state.view}</span>
  <button id="settings-btn" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}>
    {settingsOpen ? '✕' : '⚙'}
  </button>
</div>

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
  <div id="settings-panel">
    <div class="settings-heading">Settings</div>
    <div class="settings-row">
      <span class="settings-label">Version</span>
      <span class="settings-value">v{APP_VERSION}</span>
    </div>
    <div class="settings-row">
      <label class="settings-label" for="hs-input">Homeserver</label>
      <input id="hs-input" type="text" placeholder="https://matrix.example.com" bind:value={hsValue} />
    </div>
    <div class="settings-row">
      <label class="settings-label" for="user-input">Username</label>
      <input id="user-input" type="text" placeholder="alice" bind:value={userValue} />
    </div>
    <div class="settings-row">
      <label class="settings-label" for="pass-input">Password</label>
      <input id="pass-input" type="password" bind:value={passValue} />
      <button class="save-btn" onclick={saveCredentials}>Login</button>
    </div>
    <div class="settings-row">
      <label class="settings-label" for="whisper-input">Whisper URL</label>
      <input id="whisper-input" type="text" placeholder="http://whisper-server:8080 (optional)" bind:value={whisperValue} />
      <button class="save-btn" onclick={testWhisper}>Test</button>
      <button class="save-btn" onclick={saveWhisper}>Save</button>
    </div>
    <div class="settings-row">
      <label class="settings-label" for="whisper-model-input">Whisper Model</label>
      <input id="whisper-model-input" type="text" placeholder="Systran/faster-distil-whisper-small.en" bind:value={whisperModel} />
    </div>
    <div id="save-status" style="color: {saveColor}">{saveStatus}</div>
    <div id="error-log">
      <h3>ERRORS</h3>
      {#if state.errors.length === 0}
        <div id="no-errors">none</div>
      {:else}
        {#each [...state.errors].reverse() as err}
          <div class="error-entry">{err}</div>
        {/each}
      {/if}
    </div>
  </div>
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
        <div class="pulse"></div>Listening...
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
    {:else}
      <div class="messages">
        {#if visibleLines().length === 0}
          <span class="no-msg">(no messages)</span>
        {:else}
          {#each visibleLines() as line}
            {@const parsed = parseLine(line)}
            <div class="msg-line">
              {#if parsed}
                <span class="msg-sender" style="color: {senderColor(parsed.sender)}">{parsed.sender}:</span>
                <span class="msg-text"> {parsed.text}</span>
              {:else}
                {line}
              {/if}
            </div>
          {/each}
        {/if}
      </div>
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
  .messages { white-space: pre-wrap; }
  .msg-line { line-height: 1.5; }
  .msg-sender { font-weight: bold; }
  .msg-text { color: #ccc; }
  .no-msg { color: #555; }
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
  #settings-panel { padding: 12px; }
  .settings-heading {
    font-size: 13px; color: #aaa; font-weight: bold;
    text-transform: uppercase; letter-spacing: 0.05em;
    margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #333;
  }
  .settings-row {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 8px;
  }
  .settings-label { font-size: 12px; color: #888; min-width: 80px; }
  .settings-value { font-size: 12px; color: #ccc; }
  #hs-input, #user-input, #pass-input, #whisper-input, #whisper-model-input {
    flex: 1; background: #1e1e1e; border: 1px solid #444; color: #eee;
    font-family: monospace; font-size: 12px; padding: 4px 8px;
    border-radius: 4px; outline: none;
  }
  #hs-input:focus, #user-input:focus, #pass-input:focus, #whisper-input:focus, #whisper-model-input:focus { border-color: #666; }
  .save-btn {
    padding: 4px 10px; border-radius: 4px; border: 1px solid #4caf50;
    background: #1a2e1a; color: #4caf50; font-family: monospace; font-size: 12px;
    cursor: pointer;
  }
  .save-btn:active { background: #2a3e2a; }
  #save-status { font-size: 11px; margin-bottom: 12px; min-height: 16px; }
  #error-log { margin-top: 16px; border-top: 1px solid #333; padding-top: 10px; }
  #error-log h3 { font-size: 11px; color: #888; margin-bottom: 6px; }
  .error-entry {
    font-size: 11px; color: #f44336; padding: 2px 0;
    border-bottom: 1px solid #222; word-break: break-all;
  }
  #no-errors { font-size: 11px; color: #555; }
</style>
