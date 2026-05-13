import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileNode } from './types.js';

const PARSE_VERSION = 2;

export type Metrics = { hits: number; misses: number };

export interface ParseCache {
  getOrParse(absPath: string, parse: (p: string) => Promise<FileNode | null>): Promise<FileNode | null>;
  metrics: Metrics;
  close(): void;
}

type CacheRow = {
  mtime_ms: number;
  size_bytes: number;
  symbols_json: string;
  imports_json: string;
  parse_version: number;
};

export function createParseCache(dbPath: string): ParseCache {
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      symbols_json TEXT NOT NULL,
      imports_json TEXT NOT NULL,
      parse_version INTEGER NOT NULL
    );
  `);

  const select = db.prepare<[string], CacheRow>(
    'SELECT mtime_ms, size_bytes, symbols_json, imports_json, parse_version FROM files WHERE path = ?',
  );
  const upsert = db.prepare<[string, number, number, string, string, number]>(
    `INSERT INTO files (path, mtime_ms, size_bytes, symbols_json, imports_json, parse_version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes,
       symbols_json = excluded.symbols_json,
       imports_json = excluded.imports_json,
       parse_version = excluded.parse_version`,
  );

  const metrics: Metrics = { hits: 0, misses: 0 };

  async function getOrParse(absPath: string, parse: (p: string) => Promise<FileNode | null>): Promise<FileNode | null> {
    const fileStat = await stat(absPath);
    const row = select.get(absPath);

    if (
      row !== undefined &&
      row.mtime_ms === fileStat.mtimeMs &&
      row.size_bytes === fileStat.size &&
      row.parse_version === PARSE_VERSION
    ) {
      metrics.hits++;
      return {
        path: absPath,
        symbols: JSON.parse(row.symbols_json),
        imports: JSON.parse(row.imports_json),
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
      };
    }

    metrics.misses++;
    const node = await parse(absPath);
    if (node === null) return null;
    upsert.run(absPath, fileStat.mtimeMs, fileStat.size, JSON.stringify(node.symbols), JSON.stringify(node.imports), PARSE_VERSION);
    return node;
  }

  function close(): void {
    if (db.open) db.close();
  }

  return { getOrParse, metrics, close };
}
