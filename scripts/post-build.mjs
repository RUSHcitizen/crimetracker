/**
 * Post-build step.
 *
 * The Astro Cloudflare adapter emits the server bundle into `dist/_worker.js/`, and
 * `dist` is also the static asset directory. Without an `.assetsignore`, wrangler refuses
 * the deploy — correctly, because uploading `_worker.js` as a public asset would publish
 * the server bundle to the internet.
 *
 * Generated here rather than kept in `public/` so it can never be served as a real asset,
 * and so the reason lives next to the thing it fixes.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
if (!existsSync(dist)) {
  console.error('post-build: dist/ not found — run `astro build` first');
  process.exit(1);
}

const ignore = ['# Server-side output: never upload these as public assets.', '_worker.js', '_routes.json', ''].join('\n');

writeFileSync(join(dist, '.assetsignore'), ignore);
console.log('post-build: wrote dist/.assetsignore');
