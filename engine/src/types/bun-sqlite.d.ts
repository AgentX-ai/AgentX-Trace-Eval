// Minimal ambient declaration for Bun's built-in sqlite driver.
//
// This replaces the whole-package `/// <reference types="bun-types" />` that used to sit at the
// top of storage/db.ts. bun-types merges its own event overloads into NodeJS.Process (for
// example removeListener(event: "memoryPressure", ...)), and because @types/node 24 declares
// removeListener/off only on the EventEmitter base, that merged own member HIDES the inherited
// signature: plain Node code like `process.removeListener("SIGINT", handler)` stops compiling
// with TS2345 ('"SIGINT"' is not assignable to '"memoryPressure"'). skipLibCheck silences the
// invalid merge itself, so the failure only ever surfaced at our call sites.
//
// The engine's only use of Bun's type surface is the `bun:sqlite` module (db.ts guards every
// use behind an isBun runtime check and drives it through its own SqliteHandle shape), so
// declare exactly that module and nothing global. drizzle-orm/bun-sqlite's typings import
// Database/Statement/Changes from here; skipLibCheck covers any drift inside their .d.ts.
declare module "bun:sqlite" {
  export interface Changes {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): Changes;
    values(...params: unknown[]): unknown[][];
    finalize(): void;
  }

  export class Database {
    constructor(filename?: string, options?: number | { readonly?: boolean; create?: boolean; readwrite?: boolean });
    exec(sql: string): void;
    run(sql: string, ...params: unknown[]): Changes;
    prepare(sql: string): Statement;
    query(sql: string): Statement;
    close(throwOnError?: boolean): void;
  }
}
