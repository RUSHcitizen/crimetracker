import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema, type SqlDriver, type SqlParam } from '@crimetracker/shared';

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

/** Adapts `node:sqlite` to the runtime-neutral `SqlDriver` the repository speaks. */
export class NodeSqlDriver implements SqlDriver {
  constructor(private readonly db: DatabaseSync) {}

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes ?? 0) };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }
}

export interface OpenedDatabase {
  readonly driver: SqlDriver;
  readonly handle: Database;
  close(): void;
}

/**
 * Open (and migrate) the incident store.
 *
 * `node:sqlite` ships with Node >= 22.5, so there is no native build step. The schema
 * lives in `@crimetracker/shared` and is applied with `CREATE TABLE IF NOT EXISTS`, which
 * is enough for a single-file local database; a real deployment would swap this for a
 * versioned migration runner.
 */
export function openDatabase(path: string): OpenedDatabase {
  const resolved = resolveDatabasePath(path);
  if (resolved !== ':memory:') {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const handle = new DatabaseSync(resolved);

  // Pragmas are node-specific: a Durable Object manages its own storage settings.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA foreign_keys = ON');

  const driver = new NodeSqlDriver(handle);
  applySchema(driver);

  return { driver, handle, close: () => handle.close() };
}
