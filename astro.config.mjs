// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import cloudflare from '@astrojs/cloudflare';

// SPACE RADAR is one page. Everything interactive is a Preact island hydrated on load,
// plus a Three.js renderer that owns the canvas. `output: 'static'` keeps that page a
// plain prerendered HTML file (instant first paint, cacheable at the edge) while the
// routes under /api opt out with `export const prerender = false` so they run on the
// Worker — which is where API keys live and where the browser-blocked upstreams are
// actually reachable.
export default defineConfig({
  output: 'static',
  adapter: cloudflare({ imageService: 'passthrough' }),
  integrations: [preact()],
  devToolbar: { enabled: false },
  build: { inlineStylesheets: 'always' },
  vite: {
    build: {
      target: 'es2022',
      // three.js is the bulk of the bundle; keeping it in its own chunk means the HUD
      // can paint before the renderer finishes parsing.
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/three')) return 'three';
          },
        },
      },
    },
  },
});
