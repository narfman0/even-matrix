import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk'
import { createPlugin } from './plugin'

const CONTAINER_ID = 1
const DEFAULT_HOST = 'srv:4000'
const STORAGE_KEY_HOST = 'even_matrix_host'

function renderState(plugin: ReturnType<typeof createPlugin>) {
  const state = plugin.getState()

  const wsEl = document.getElementById('ws-status')
  if (wsEl) {
    wsEl.textContent = state.wsConnected ? 'WS: connected' : 'WS: disconnected'
    wsEl.className = state.wsConnected ? 'connected' : 'disconnected'
  }

  const viewEl = document.getElementById('view-label')
  if (viewEl) viewEl.textContent = state.view

  const controls = document.getElementById('controls')
  const backBtn = document.getElementById('ctrl-back') as HTMLButtonElement | null
  const actionBtn = document.getElementById('ctrl-action') as HTMLButtonElement | null
  if (controls && backBtn && actionBtn) {
    if (state.view === 'rooms') {
      controls.classList.remove('visible')
    } else if (state.view === 'messages') {
      controls.classList.add('visible')
      backBtn.style.display = ''
      actionBtn.textContent = 'Talk'
      actionBtn.className = 'ctrl-btn primary'
      actionBtn.style.display = ''
    } else if (state.view === 'listening') {
      controls.classList.add('visible')
      backBtn.style.display = 'none'
      actionBtn.textContent = 'Stop'
      actionBtn.className = 'ctrl-btn danger'
      actionBtn.style.display = ''
    }
  }

  const contentEl = document.getElementById('content')
  if (contentEl) {
    if (state.view === 'rooms') {
      contentEl.innerHTML = ''
      if (state.displayedRooms.length === 0) {
        contentEl.innerHTML = '<div style="color:#555;padding:8px">No rooms</div>'
      } else {
        state.displayedRooms.forEach((r, index) => {
          const div = document.createElement('div')
          div.className = 'room-item' + (r.id === state.selectedRoomId ? ' selected' : '')
          div.textContent = r.name
          div.addEventListener('click', () => {
            plugin.handleEvenHubEvent({ listEvent: { currentSelectItemIndex: index } })
          })
          contentEl.appendChild(div)
        })
      }
    } else if (state.view === 'listening') {
      contentEl.innerHTML = '<div class="listening-indicator"><div class="pulse"></div>Listening...</div>'
    } else {
      const visibleLines = state.lines.slice(
        Math.max(0, state.lines.length - 20 - state.scrollOffset),
        state.lines.length - state.scrollOffset
      ).reverse()
      contentEl.innerHTML = `<div class="messages">${escapeHtml(visibleLines.join('\n') || '(no messages)')}</div>`
    }
  }

  const errorLog = document.getElementById('error-log')
  const noErrors = document.getElementById('no-errors')
  if (errorLog && noErrors) {
    const existing = errorLog.querySelectorAll('.error-entry')
    existing.forEach(el => el.remove())
    if (state.errors.length === 0) {
      noErrors.style.display = ''
    } else {
      noErrors.style.display = 'none'
      for (const err of [...state.errors].reverse()) {
        const div = document.createElement('div')
        div.className = 'error-entry'
        div.textContent = err
        errorLog.appendChild(div)
      }
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function main() {
  const bridge = await waitForEvenAppBridge()

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
  const plugin = createPlugin(bridge, `ws://${host}/ws`, () => renderState(plugin))
  bridge.onEvenHubEvent(plugin.handleEvenHubEvent)
  plugin.connect()

  document.getElementById('ctrl-back')?.addEventListener('click', () => {
    plugin.handleEvenHubEvent({ sysEvent: {} })
  })
  document.getElementById('ctrl-action')?.addEventListener('click', () => {
    const { view } = plugin.getState()
    if (view === 'messages') plugin.startAudio()
    else if (view === 'listening') plugin.stopAudio()
  })
}

main().catch(console.error)
