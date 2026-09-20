import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// `<repo>/server/src/db` in development, `<repo>/server/dist/db` once built — three
// levels up is the repository root either way.
const REPO_ROOT = resolve(here, '../../..');

export type Database = DatabaseSync;

/**
 * Resolve a configured database path.
 *
 * A relative `DATABASE_PATH` is resolved against the repository root rather than the
 * process working directory, because the server is started from several places (`npm run
 * dev` runs it inside the `server` workspace, `npm start` from wherever you are). Without
 * this, the same configuration silently points at different files.
 */
export function resolveDatabasePath(path: string): string {
  if (path === ':memory:') return path;
  return isAbsolute(path) ? path : resolve(REPO_ROOT, path);
}

/**
 * Open (and migrate) the incident store.
 *
 * `node:sqlite` ships with Node >= 22.5, so there is no native build step. The schema is
 * applied with `CREATE TABLE IF NOT EXISTS`, which is enough for a single-file local
 * database; a real deployment would swap this for a versioned migration runner.
 */
export function openDatabase(path: string): Database {
  const resolved = resolveDatabasePath(path);
  if (resolved !== ':memory:') {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  const schema = readFileSync(resolve(here, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}
