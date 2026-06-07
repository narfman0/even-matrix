// SPIKE: one-shot WASM probe — remove after E2EE migration is confirmed
export async function probeWasm(): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  const t0 = Date.now()
  try {
    // Basic WebAssembly API availability check
    if (typeof WebAssembly === 'undefined') {
      return { ok: false, detail: 'WebAssembly global not available', durationMs: Date.now() - t0 }
    }
    if (typeof WebAssembly.instantiate !== 'function') {
      return { ok: false, detail: 'WebAssembly.instantiate not available', durationMs: Date.now() - t0 }
    }

    // Load and init the exact WASM module matrix-js-sdk uses for E2EE
    const { initAsync, OlmMachine, UserId, DeviceId } = await import('@matrix-org/matrix-sdk-crypto-wasm')
    await initAsync()

    // Sanity-check: construct a real OlmMachine (proves crypto is functional, not just loaded)
    const userId = new UserId('@probe:example.org')
    const deviceId = new DeviceId('PROBEDEV1')
    const machine = await OlmMachine.initialize(userId, deviceId)
    const identity = machine.identityKeys
    const ed25519 = identity.ed25519.toBase64()

    return {
      ok: true,
      detail: `initAsync OK · OlmMachine created · ed25519=${ed25519.slice(0, 8)}…`,
      durationMs: Date.now() - t0,
    }
  } catch (err) {
    return {
      ok: false,
      detail: String(err),
      durationMs: Date.now() - t0,
    }
  }
}
