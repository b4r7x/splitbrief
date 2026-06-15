import { lstatSync, mkdirSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { FileNode } from './types.js';
import { error, matches } from '../../utils/error.js';
import { isNodeError } from '../../lib/process/errors.js';

const repomapCacheError = {
  dbPathEscapes: (dbPath: string) =>
    error('repomap-cache-escapes', `repomap cache db path escapes cache directory: ${dbPath}`, {
      dbPath,
    }),
  isDbPathEscapes: matches('repomap-cache-escapes'),
} as const;

const PARSE_VERSION = 2;

const CORRUPTION_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB']);

function isCorruptionError(err: unknown): boolean {
  return isNodeError(err) && err.code !== undefined && CORRUPTION_CODES.has(err.code);
}

export type Metrics = { hits: number; misses: number };

export interface ParseCache {
  getOrParse(
    absPath: string,
    parse: (p: string, s: Stats) => Promise<FileNode | null>,
  ): Promise<FileNode | null>;
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

export interface ParseCacheOptions {
  onWarn?: (message: string) => void;
}

export async function createParseCache(
  dbPath: string,
  opts: ParseCacheOptions = {},
): Promise<ParseCache> {
  const { default: Database } = await import('better-sqlite3');

  const resolvedDbPath = resolve(dbPath);
  const cacheDir = dirname(resolvedDbPath);

  mkdirSync(cacheDir, { recursive: true });
  if (lstatSync(cacheDir).isSymbolicLink()) {
    throw repomapCacheError.dbPathEscapes(dbPath);
  }

  try {
    const realDbPath = realpathSync(resolvedDbPath);
    const realCacheDir = realpathSync(cacheDir);
    if (!realDbPath.startsWith(`${realCacheDir}/`) && realDbPath !== realCacheDir) {
      throw repomapCacheError.dbPathEscapes(dbPath);
    }
  } catch (err) {
    if (repomapCacheError.isDbPathEscapes(err)) {
      throw err;
    }
    // File doesn't exist yet — check the parent is real
  }

  function openDb(): Database {
    const handle = new Database(dbPath);
    try {
      handle.pragma('journal_mode = WAL');
      handle.exec(`
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          mtime_ms INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          symbols_json TEXT NOT NULL,
          imports_json TEXT NOT NULL,
          parse_version INTEGER NOT NULL
        );
      `);
    } catch (err) {
      if (handle.open) handle.close();
      throw err;
    }
    return handle;
  }

  function discardCorruptDb(): void {
    for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
      rmSync(path, { force: true });
    }
  }

  let db: Database;
  try {
    db = openDb();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    discardCorruptDb();
    db = openDb();
    opts.onWarn?.(`repo-map cache was corrupt and has been reset: ${dbPath}`);
  }

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

  async function getOrParse(
    absPath: string,
    parse: (p: string, s: Stats) => Promise<FileNode | null>,
  ): Promise<FileNode | null> {
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
    const node = await parse(absPath, fileStat);
    if (node === null) return null;
    upsert.run(
      absPath,
      fileStat.mtimeMs,
      fileStat.size,
      JSON.stringify(node.symbols),
      JSON.stringify(node.imports),
      PARSE_VERSION,
    );
    return node;
  }

  function close(): void {
    if (db.open) db.close();
  }

  return { getOrParse, metrics, close };
}
