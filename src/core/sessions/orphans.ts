import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { warnError } from '../../lib/warn.js';
import { isValidSessionId, READINESS_FILE, sessionDir, sessionsRoot } from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import { readActiveRecord } from './lifecycle.js';
import { discardOrphanSessionDirectory } from './prepare.js';

export const ORPHAN_SESSION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface OrphanScanInput {
  projectDir: string;
  nowMs?: number | undefined;
}

export interface OrphanPruneResult {
  scanned: number;
  removed: string[];
}

function listSessionIds(projectDir: string): string[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    warnError('orphan sessions: cannot list sessions', err);
    return [];
  }
}

function activeSessionId(projectDir: string): string | null {
  const active = readActiveRecord(projectDir);
  if (active === null) return null;
  return active.kind === 'legacy' ? active.sessionId : active.receipt.sessionId;
}

function olderThanGrace(directory: string, nowMs: number): boolean {
  return nowMs - lstatSync(directory).mtimeMs >= ORPHAN_SESSION_GRACE_MS;
}

function isCollectableOrphan(ref: SessionRef, nowMs: number): boolean {
  if (activeSessionId(ref.projectDir) === ref.sessionId) return false;
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  const entries = readdirSync(directory);
  if (entries.length === 0) return olderThanGrace(directory, nowMs);
  if (entries.length !== 1 || entries[0] !== READINESS_FILE) return false;
  if (!lstatSync(join(directory, READINESS_FILE)).isFile()) return false;
  return olderThanGrace(directory, nowMs);
}

export function listOrphanSessionIds(input: OrphanScanInput): string[] {
  const nowMs = input.nowMs ?? Date.now();
  const orphans: string[] = [];
  for (const sessionId of listSessionIds(input.projectDir)) {
    try {
      if (isCollectableOrphan({ projectDir: input.projectDir, sessionId }, nowMs)) {
        orphans.push(sessionId);
      }
    } catch (err) {
      warnError(`orphan sessions: skipping session ${sessionId}`, err);
    }
  }
  return orphans;
}

export function pruneOrphanSessions(input: OrphanScanInput): OrphanPruneResult {
  const nowMs = input.nowMs ?? Date.now();
  const sessionIds = listSessionIds(input.projectDir);
  const removed: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      const ref: SessionRef = { projectDir: input.projectDir, sessionId };
      if (isCollectableOrphan(ref, nowMs) && discardOrphanSessionDirectory(ref)) {
        removed.push(sessionId);
      }
    } catch (err) {
      warnError(`orphan sessions: skipping session ${sessionId}`, err);
    }
  }
  return { scanned: sessionIds.length, removed };
}
