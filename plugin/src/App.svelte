<script lang="ts">
  import { onMount } from 'svelte'
  import {
    waitForEvenAppBridge,
    TextContainerProperty,
    CreateStartUpPageContainer,
  } from '@evenrealities/even_hub_sdk'
  import { createPlugin } from './plugin'

  const CONTAINER_ID = 1
  const DEFAULT_HOST = 'srv:4000'
  const STORAGE_KEY_HOST = 'even_matrix_host'
  const APP_VERSION = '0.1.2'

  type Plugin = ReturnType<typeof createPlugin>
  type PluginState = ReturnType<Plugin['getState']>

  let state = $state<PluginState>({
    hierarchy: { dms: [], spaces: [], orphans: [] },
    displayedRooms: [],
    selectedRoomId: null,
    lines: [],
    view: 'rooms',
    recognizing: false,
    scrollOffset: 0,
    wsConnected: false,
    errors: [],
  })
  let settingsOpen = $state(false)
  let hostValue = $state(DEFAULT_HOST)
  let saveStatus = $state('')
  let saveColor = $state('#888')

  let plugin: Plugin | null = null
  let bridge: any = null

  function visibleLines(): string[] {
    const { lines, scrollOffset } = state
    return lines
      .slice(Math.max(0, lines.length - 20 - scrollOffset), lines.length - scrollOffset)
      .reverse()
  }

  async function saveHost() {
    try {
      await bridge.setLocalStorage(STORAGE_KEY_HOST, hostValue.trim())
      saveStatus = 'Saved. Reload to apply.'
      saveColor = '#4caf50'
    } catch {
      saveStatus = 'Save failed.'
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

    const savedHost = await bridge.getLocalStorage(STORAGE_KEY_HOST).catch(() => '')
    const host = savedHost || DEFAULT_HOST
    hostValue = host

    plugin = createPlugin(bridge, `ws://${host}/ws`, () => {
      state = plugin!.getState()
    })
    bridge.onEvenHubEvent(plugin.handleEvenHubEvent)
    plugin.connect()
  })
</script>

<div id="status-bar">
  <span class="ws-status" class:connected={state.wsConnected} class:disconnected={!state.wsConnected}>
    WS: {state.wsConnected ? 'connected' : 'disconnected'}
  </span>
  <span id="view-label">{settingsOpen ? 'settings' : state.view}</span>
  <button id="settings-btn" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}>
    {settingsOpen ? '✕' : '⚙'}
  </button>
</div>

{#if !settingsOpen && (state.view === 'messages' || state.view === 'listening')}
  <div id="controls">
    {#if state.view === 'messages'}
      <button class="ctrl-btn" onclick={() => plugin?.handleEvenHubEvent({ sysEvent: {} })}>Back</button>
      <button class="ctrl-btn primary" onclick={() => plugin?.startAudio()}>Talk</button>
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
      <label class="settings-label" for="host-input">Home Server</label>
      <input id="host-input" type="text" placeholder="srv:4000" bind:value={hostValue} />
      <button id="save-host-btn" onclick={saveHost}>Save</button>
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
              onclick={() => plugin?.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: index } })}
            >{item.name}</div>
          {/if}
        {/each}
      {/if}
    {:else if state.view === 'listening'}
      <div class="listening-indicator">
        <div class="pulse"></div>Listening...
      </div>
    {:else}
      <div class="messages">{visibleLines().join('\n') || '(no messages)'}</div>
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
  .ws-status { font-size: 12px; }
  .ws-status.connected { color: #4caf50; }
  .ws-status.disconnected { color: #f44336; }
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
  .messages { white-space: pre-wrap; line-height: 1.5; }
  .listening-indicator {
    display: flex; align-items: center; gap: 8px;
    padding: 16px; color: #4caf50; font-size: 16px;
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
  #host-input {
    flex: 1; background: #1e1e1e; border: 1px solid #444; color: #eee;
    font-family: monospace; font-size: 12px; padding: 4px 8px;
    border-radius: 4px; outline: none;
  }
  #host-input:focus { border-color: #666; }
  #save-host-btn {
    padding: 4px 10px; border-radius: 4px; border: 1px solid #4caf50;
    background: #1a2e1a; color: #4caf50; font-family: monospace; font-size: 12px;
    cursor: pointer;
  }
  #save-host-btn:active { background: #2a3e2a; }
  #save-status { font-size: 11px; margin-bottom: 12px; min-height: 16px; }
  #error-log { margin-top: 16px; border-top: 1px solid #333; padding-top: 10px; }
  #error-log h3 { font-size: 11px; color: #888; margin-bottom: 6px; }
  .error-entry {
    font-size: 11px; color: #f44336; padding: 2px 0;
    border-bottom: 1px solid #222; word-break: break-all;
  }
  #no-errors { font-size: 11px; color: #555; }
</style>
