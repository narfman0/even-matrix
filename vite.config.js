import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [
    svelte(),
    // Serve .wasm files with correct MIME type in dev mode
    {
      name: 'wasm-mime',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.includes('.wasm')) res.setHeader('Content-Type', 'application/wasm')
          next()
        })
      },
    },
  ],
  build: {
    outDir: 'dist',
  },
  // Prevent Vite from pre-bundling the WASM package (it handles its own loading)
  optimizeDeps: {
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
})
