import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser only ever talks to this origin; the dev server proxies through to the
    // API so no API host or key is ever baked into the client bundle.
    proxy: {
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // MapLibre is large and stable — keeping it in its own chunk keeps app rebuilds
        // out of the user's cache invalidation path.
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
  optimizeDeps: {
    // Workspace source, transpiled by Vite directly.
    exclude: ['@crimetracker/shared'],
  },
});
