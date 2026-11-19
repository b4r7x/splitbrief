import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { SPLITBRIEF_DIR } from '../core/paths.js';
import type { SessionRef } from '../core/types/session-ref.js';
import { assertNotHardlink, assertWritablePathConfined } from '../lib/fs/confinement.js';
import { confinedEnsureDir } from '../lib/fs/confined.js';
import { rejectSymlinkTarget, SECURE_FILE_MODE } from '../lib/fs/secure.js';
import { checkProcessIdentity } from '../lib/process/liveness.js';
import { currentProcessStartTimeMs } from '../lib/process/start-time.js';
import { hasErrnoCode } from '../utils/errno.js';

const FILE = join(SPLITBRIEF_DIR, 'checkout-writers.db');
const writeSchema = z.object({
  before: z.string(),
  after: z.string(),
  proven: z.literal(true).optional(),
});
const writesSchema = z.array(z.tuple([z.string(), writeSchema.nullable()]));
const activeWriterSchema = z.object({
  start: z.number(),
  pid: z.number(),
  startedAt: z.number(),
});
const writerSchema = activeWriterSchema.extend({
  session: z.string(),
  end: z.number().nullable(),
  writes: z.string().nullable(),
});

export type CheckoutWrite = z.infer<typeof writesSchema>[number];

function registry(projectDir: string): Database.Database {
  assertWritablePathConfined(FILE, projectDir);
  assertWritablePathConfined(`${FILE}-journal`, projectDir);
  confinedEnsureDir(projectDir, SPLITBRIEF_DIR);
  const path = join(projectDir, FILE);
  rejectSymlinkTarget(path);
  rejectSymlinkTarget(`${path}-journal`);
  assertNotHardlink(FILE, path);
  try {
    closeSync(openSync(path, 'wx', SECURE_FILE_MODE));
  } catch (cause) {
    if (!hasErrnoCode(cause, 'EEXIST')) throw cause;
  }
  const db = new Database(path, { fileMustExist: true });
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS clock (revision INTEGER NOT NULL);
      INSERT INTO clock SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM clock);
      CREATE TABLE IF NOT EXISTS writers (
        start INTEGER PRIMARY KEY,
        end INTEGER,
        session TEXT NOT NULL,
        pid INTEGER NOT NULL,
        startedAt REAL NOT NULL,
        overlap INTEGER NOT NULL,
        writes TEXT
      );
    `);
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

function nextRevision(db: Database.Database): number {
  return z
    .number()
    .parse(db.prepare('UPDATE clock SET revision = revision + 1 RETURNING revision').pluck().get());
}

function liveForeignWriters(db: Database.Database, sessionId: string): number[] {
  const rows = z
    .array(activeWriterSchema)
    .parse(
      db
        .prepare('SELECT start, pid, startedAt FROM writers WHERE end IS NULL AND session != ?')
        .all(sessionId),
    );
  return rows.flatMap(({ start, pid, startedAt }) => {
    return isStillWriting(pid, startedAt) ? [start] : [];
  });
}

function isStillWriting(pid: number, startedAt: number): boolean {
  const identity = checkProcessIdentity(pid, startedAt);
  return identity === 'live' || identity === 'unknown';
}

function checkoutWritersSince(
  projectDir: string,
  revision: number,
): { session: string; writes: CheckoutWrite[] | undefined }[] {
  assertWritablePathConfined(FILE, projectDir);
  if (!existsSync(join(projectDir, FILE))) return [];
  const db = registry(projectDir);
  try {
    const rows = z
      .array(writerSchema)
      .parse(
        db
          .prepare('SELECT * FROM writers WHERE end > ? OR end IS NULL ORDER BY start')
          .all(revision),
      );
    return rows
      .filter(
        (row) => row.end !== null || row.start > revision || isStillWriting(row.pid, row.startedAt),
      )
      .map((row) => ({
        session: row.session,
        writes: row.writes === null ? undefined : writesSchema.parse(JSON.parse(row.writes)),
      }));
  } finally {
    db.close();
  }
}

/** Identifies paths another checkout writer may have updated since a backup was taken. */
export function otherCheckoutWritesSince(
  ref: SessionRef,
  revision: number,
  paths: readonly string[],
): Set<string> {
  const known = new Set(paths);
  if (known.size === 0) return known;
  const touched = new Set<string>();
  for (const { session, writes } of checkoutWritersSince(ref.projectDir, revision)) {
    if (session === ref.sessionId) continue;
    if (writes === undefined) return known;
    for (const [path] of writes) if (known.has(path)) touched.add(path);
  }
  return touched;
}

export function checkoutWriterRevision(projectDir: string): number {
  assertWritablePathConfined(FILE, projectDir);
  if (!existsSync(join(projectDir, FILE))) return 0;
  const db = registry(projectDir);
  try {
    return z.number().parse(db.prepare('SELECT revision FROM clock').pluck().get());
  } finally {
    db.close();
  }
}

export function hasOtherLiveCheckoutRun(ref: SessionRef): boolean {
  assertWritablePathConfined(FILE, ref.projectDir);
  if (!existsSync(join(ref.projectDir, FILE))) return false;
  const db = registry(ref.projectDir);
  try {
    return liveForeignWriters(db, ref.sessionId).length > 0;
  } finally {
    db.close();
  }
}

export function beginCheckoutWriter(ref: SessionRef): {
  finish: (writes?: readonly CheckoutWrite[]) => void;
} {
  const db = registry(ref.projectDir);
  let start: number;
  try {
    start = db
      .transaction(() => {
        const others = liveForeignWriters(db, ref.sessionId);
        const start = nextRevision(db);
        db.prepare('INSERT INTO writers VALUES (?, NULL, ?, ?, ?, ?, NULL)').run(
          start,
          ref.sessionId,
          process.pid,
          currentProcessStartTimeMs(),
          Number(others.length > 0),
        );
        const mark = db.prepare('UPDATE writers SET overlap = 1 WHERE start = ?');
        for (const other of others) mark.run(other);
        return start;
      })
      .immediate();
  } finally {
    db.close();
  }
  return {
    finish(writes) {
      const db = registry(ref.projectDir);
      try {
        db.transaction(() => {
          const overlap = db
            .prepare('SELECT overlap FROM writers WHERE start = ?')
            .pluck()
            .get(start);
          const recorded =
            overlap === 1
              ? writes?.map(([path, write]) => [path, write?.proven === true ? write : null])
              : writes;
          db.prepare('UPDATE writers SET end = ?, writes = ? WHERE start = ?').run(
            nextRevision(db),
            recorded === undefined ? null : JSON.stringify(recorded),
            start,
          );
        }).immediate();
      } finally {
        db.close();
      }
    },
  };
}

/** An unbroken chain of this session's observed writes from the given baseline entries. */
export function expectedCheckoutWrites(
  ref: SessionRef,
  revision: number | undefined,
  baseline: ReadonlyMap<string, string>,
): Map<string, string> {
  return traceCheckoutWrites(ref, revision, baseline, (session) => session === ref.sessionId);
}

/** Proven changes by another checkout session, relative to the caller's captured entries. */
export function expectedForeignCheckoutWrites(
  ref: { projectDir: string; sessionId?: string | undefined },
  revision: number,
  baseline: ReadonlyMap<string, string>,
): Map<string, string> {
  return traceCheckoutWrites(
    ref,
    revision,
    baseline,
    (session, write) => session !== ref.sessionId && write.proven === true,
  );
}

function traceCheckoutWrites(
  ref: { projectDir: string; sessionId?: string | undefined },
  revision: number | undefined,
  baseline: ReadonlyMap<string, string>,
  accepts: (session: string, write: z.infer<typeof writeSchema>) => boolean,
): Map<string, string> {
  if (revision === undefined || baseline.size === 0) return new Map();
  const current = new Map(baseline);
  const proven = new Map<string, string>();
  for (const { session, writes } of checkoutWritersSince(ref.projectDir, revision)) {
    if (writes === undefined) {
      if (session !== ref.sessionId) return new Map();
      continue;
    }
    for (const [path, write] of writes) {
      if (write !== null && accepts(session, write) && current.get(path) === write.before) {
        current.set(path, write.after);
        proven.set(path, write.after);
      } else {
        current.delete(path);
        proven.delete(path);
      }
    }
  }
  return proven;
}
