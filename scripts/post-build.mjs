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
import { execSync } from 'node:child_process';
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

/*
 * A build stamp, served at /version.json.
 *
 * "Is the thing I am looking at the thing I just deployed?" is otherwise unanswerable
 * from the outside — a stale cache, an old deployment and a fresh one all look alike.
 * This makes it a single request.
 */
function commitSha() {
  // Cloudflare Workers Builds and Pages both export the commit; fall back to git locally.
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const version = {
  app: 'SPACE RADAR',
  commit: commitSha(),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(dist, 'version.json'), JSON.stringify(version, null, 2) + '\n');
console.log(`post-build: wrote dist/version.json (${version.commit})`);
