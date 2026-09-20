import { applySchema, type SqlDriver, type SqlParam } from '@crimetracker/shared';

/**
 * Adapts a Durable Object's embedded SQLite to the runtime-neutral `SqlDriver`.
 *
 * `SqlStorage.exec` is synchronous and returns a cursor, which is exactly the shape the
 * repository expects — so every query in `IncidentRepository` runs here unchanged.
 */
export class DurableObjectSqlDriver implements SqlDriver {
  constructor(private readonly sql: SqlStorage) {}

  all<T>(query: string, ...params: SqlParam[]): T[] {
    return this.sql.exec(query, ...(params as never[])).toArray() as unknown as T[];
  }

  get<T>(query: string, ...params: SqlParam[]): T | undefined {
    const rows = this.sql.exec(query, ...(params as never[])).toArray();
    return rows[0] as T | undefined;
  }

  run(query: string, ...params: SqlParam[]): { changes: number } {
    const cursor = this.sql.exec(query, ...(params as never[]));
    // Draining the cursor is what actually applies the statement.
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }

  exec(query: string): void {
    this.sql.exec(query);
  }
}

export function migrate(sql: SqlStorage): DurableObjectSqlDriver {
  const driver = new DurableObjectSqlDriver(sql);
  applySchema(driver);
  return driver;
}
