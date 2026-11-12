// Minimal types for the built-in `node:sqlite` module (Node >= 22.13, Electron 44 bundles Node 24).
// The workspace still resolves @types/node 20, which predates it. Delete this file when
// @types/node moves to 24.
declare module "node:sqlite" {
  type SqlValue = string | number | bigint | null | Uint8Array;
  export interface StatementSync {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Record<string, SqlValue>[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
