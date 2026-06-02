import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
} from '@evenrealities/even_hub_sdk'
import { createPlugin } from './plugin'

const CONTAINER_ID = 1
const DEFAULT_HOST = 'localhost:4000'
const STORAGE_KEY_HOST = 'monocle_host'

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
  const plugin = createPlugin(bridge, `ws://${host}/ws`)
  bridge.onEvenHubEvent(plugin.handleEvenHubEvent)
  plugin.connect()
}

main().catch(console.error)
