<script lang="ts">
  import { MatrixRestClient, getLoginFlows } from './matrix-client'
  import { pcmToWav } from './plugin'
  import { probeWasm } from './wasm-probe'
  import {
    STORAGE_HOMESERVER,
    STORAGE_ACCESS_TOKEN,
    STORAGE_USER_ID,
    STORAGE_USERNAME,
    STORAGE_WHISPER_URL,
    STORAGE_WHISPER_MODEL,
  } from './storage-keys'

  let {
    errors,
    bridge,
    homeserver,
    username,
    whisperUrl,
    whisperModel: whisperModelProp,
    appVersion,
    matrix,
  }: {
    errors: string[]
    bridge: any
    homeserver: string
    username: string
    whisperUrl: string
    whisperModel: string
    appVersion: string
    matrix: any
  } = $props()

  let hsValue = $state(homeserver)
  let userValue = $state(username)
  let passValue = $state('')
  let whisperValue = $state(whisperUrl)
  let whisperModel = $state(whisperModelProp)
  let tokenValue = $state('')
  let saveStatus = $state('')
  let saveColor = $state('#888')
  let wasmStatus = $state('')
  let wasmColor = $state('#888')
  let errorLogOpen = $state(false)

  let e2eeStatus = $state<'checking' | 'ready' | 'not-setup' | 'unavailable' | 'error'>('checking')
  let e2eePassphrase = $state('')
  let e2eeSetupStatus = $state('')
  let e2eeSetupColor = $state('#888')

  $effect(() => {
    if (matrix) {
      matrix.getCrossSigningStatus?.().then((s: string) => { e2eeStatus = s as any }).catch(() => { e2eeStatus = 'unavailable' })
    } else {
      e2eeStatus = 'unavailable'
    }
  })

  async function setupE2EE() {
    if (!e2eePassphrase) { e2eeSetupStatus = 'Enter a passphrase.'; e2eeSetupColor = '#f44336'; return }
    e2eeSetupStatus = 'Setting up…'; e2eeSetupColor = '#888'
    try {
      await matrix.bootstrapE2EE(e2eePassphrase)
      e2eeStatus = 'ready'
      e2eeSetupStatus = 'Done! Cross-signing ready.'
      e2eeSetupColor = '#4caf50'
      e2eePassphrase = ''
    } catch (e) {
      e2eeSetupStatus = `Failed: ${e}`
      e2eeSetupColor = '#f44336'
    }
  }

  async function testWasmProbe() {
    wasmStatus = 'Testing WASM…'
    wasmColor = '#888'
    const result = await probeWasm()
    wasmStatus = result.ok
      ? `WASM OK ✓ (${result.durationMs}ms) — ${result.detail}`
      : `WASM FAILED: ${result.detail}`
    wasmColor = result.ok ? '#4caf50' : '#f44336'
  }

  async function saveCredentials() {
    try {
      const flows = await getLoginFlows(hsValue.trim())
      const hasPassword = flows.includes('m.login.password')
      const hasSso = flows.some(f => f === 'm.login.sso' || f === 'm.login.cas')

      if (!hasPassword && hasSso) {
        saveStatus = 'This server requires SSO login. Use Element or your browser to log in, then paste the access token below.'
        saveColor = '#f7c67e'
        return
      }

      const result = await MatrixRestClient.login(hsValue.trim(), userValue.trim(), passValue)
      await bridge.setLocalStorage(STORAGE_HOMESERVER, hsValue.trim())
      await bridge.setLocalStorage(STORAGE_USERNAME, userValue.trim())
      await bridge.setLocalStorage(STORAGE_ACCESS_TOKEN, result.access_token)
      await bridge.setLocalStorage(STORAGE_USER_ID, result.user_id)
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

  async function saveToken() {
    if (!tokenValue.trim() || !hsValue.trim() || !userValue.trim()) {
      saveStatus = 'Fill in Homeserver, Username, and Access Token.'
      saveColor = '#f44336'
      return
    }
    try {
      const hs = hsValue.trim().replace(/\/$/, '')
      const res = await fetch(`${hs}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${tokenValue.trim()}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { user_id: string; device_id?: string }
      await bridge.setLocalStorage(STORAGE_HOMESERVER, hs)
      await bridge.setLocalStorage(STORAGE_USERNAME, userValue.trim())
      await bridge.setLocalStorage(STORAGE_ACCESS_TOKEN, tokenValue.trim())
      await bridge.setLocalStorage(STORAGE_USER_ID, data.user_id)
      if (data.device_id) await bridge.setLocalStorage('even_matrix_device_id', data.device_id)
      tokenValue = ''
      saveStatus = 'Token saved. Reloading...'
      saveColor = '#4caf50'
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      saveStatus = `Token invalid: ${e}`
      saveColor = '#f44336'
    }
  }

  async function saveWhisper() {
    const url = whisperValue.trim()
    const model = whisperModel.trim()
    if (!model) { saveStatus = 'Whisper model cannot be empty.'; saveColor = '#f44336'; return }
    try {
      await bridge.setLocalStorage(STORAGE_WHISPER_URL, url)
      await bridge.setLocalStorage(STORAGE_WHISPER_MODEL, model)
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
</script>

<div id="settings-panel">
  <div class="settings-heading">Settings</div>
  {#if !homeserver}
    <div class="onboarding">
      <div class="onboarding-title">Welcome to even-matrix</div>
      <div class="onboarding-body">Enter your Matrix homeserver and credentials below to connect. Use <strong>matrix.org</strong> or any Matrix-compatible server. If your server uses SSO (e.g. Google login), grab your access token from Element → Settings → Help &amp; About.</div>
    </div>
  {/if}
  <div class="settings-row">
    <span class="settings-label">Version</span>
    <span class="settings-value">v{appVersion}</span>
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
    <label class="settings-label" for="token-input">Access Token</label>
    <input id="token-input" type="password" placeholder="syt_... (from Element)" bind:value={tokenValue} />
    <button class="save-btn" onclick={saveToken}>Save</button>
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

  <div class="settings-row diag-row">
    <span class="settings-label">Diagnostics</span>
    <button class="save-btn" onclick={testWasmProbe}>Test WASM</button>
  </div>
  {#if wasmStatus}
    <div id="wasm-status" style="color: {wasmColor}">{wasmStatus}</div>
  {/if}

  <div class="settings-heading e2ee-heading">E2EE Trust</div>
  {#if e2eeStatus === 'checking'}
    <div class="e2ee-status" style="color: #888">Checking…</div>
  {:else if e2eeStatus === 'ready'}
    <div class="e2ee-status" style="color: #4caf50">✓ Cross-signing ready</div>
  {:else if e2eeStatus === 'not-setup'}
    <div class="e2ee-status" style="color: #f7c67e">⚠ Cross-signing not set up</div>
    <div class="settings-row">
      <label class="settings-label" for="e2ee-pass">Passphrase</label>
      <input id="e2ee-pass" type="password" placeholder="Recovery passphrase" bind:value={e2eePassphrase} />
      <button class="save-btn" onclick={setupE2EE}>Setup</button>
    </div>
    <div id="e2ee-setup-status" style="color: {e2eeSetupColor}">{e2eeSetupStatus}</div>
  {:else}
    <div class="e2ee-status" style="color: #555">E2EE unavailable (not logged in)</div>
  {/if}

  <div class="settings-row diag-row">
    <span class="settings-label">Error Log</span>
    <button class="save-btn" onclick={() => errorLogOpen = !errorLogOpen}>
      {errorLogOpen ? 'Hide' : 'Show'} ({errors.length})
    </button>
  </div>
  {#if errorLogOpen}
    <div id="error-log">
      {#if errors.length === 0}
        <div id="no-errors">none</div>
      {:else}
        {#each [...errors].reverse() as err}
          <div class="error-entry">{err}</div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  #settings-panel { padding: 12px; }
  .onboarding { background: #1a1a2e; border: 1px solid #444; border-radius: 6px; padding: 10px 12px; margin-bottom: 14px; }
  .onboarding-title { font-size: 12px; font-weight: bold; color: #7eb8f7; margin-bottom: 4px; }
  .onboarding-body { font-size: 11px; color: #aaa; line-height: 1.5; }
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
  #hs-input, #user-input, #pass-input, #token-input, #whisper-input, #whisper-model-input {
    flex: 1; background: #1e1e1e; border: 1px solid #444; color: #eee;
    font-family: monospace; font-size: 12px; padding: 4px 8px;
    border-radius: 4px; outline: none;
  }
  #hs-input:focus, #user-input:focus, #pass-input:focus, #token-input:focus, #whisper-input:focus, #whisper-model-input:focus { border-color: #666; }
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
  .diag-row { border-top: 1px solid #333; padding-top: 8px; margin-top: 4px; }
  #wasm-status { font-size: 11px; margin-bottom: 8px; word-break: break-all; }
  .e2ee-heading { margin-top: 12px; }
  .e2ee-status { font-size: 11px; margin-bottom: 8px; }
  #e2ee-setup-status { font-size: 11px; margin-bottom: 8px; min-height: 16px; }
  #e2ee-pass { flex: 1; background: #1e1e1e; border: 1px solid #444; color: #eee; font-family: monospace; font-size: 12px; padding: 4px 8px; border-radius: 4px; outline: none; }
  #e2ee-pass:focus { border-color: #666; }
</style>
