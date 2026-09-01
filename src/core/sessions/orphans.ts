import { existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertWritablePathConfined } from '../../lib/path-confinement.js';
import { warnError } from '../../lib/warn.js';
import {
  isValidSessionId,
  READINESS_FILE,
  sessionDir,
  sessionsRoot,
  validateSessionId,
} from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import { readActiveRecord, withSessionMutationLock } from './active-pointer.js';
import { sessionPreparationError } from './errors.js';
import {
  claimRelativePath,
  directoryIdentity,
  ownershipFailure,
  pathExists,
  sessionRelativePath,
} from './ownership-marker.js';

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

function isCollectableOrphanDirectory(ref: SessionRef, relativeDirectory: string): boolean {
  const entries = readdirSync(join(ref.projectDir, relativeDirectory));
  if (entries.length === 0) return true;
  if (entries.length !== 1 || entries[0] !== READINESS_FILE) return false;
  return lstatSync(join(ref.projectDir, relativeDirectory, READINESS_FILE)).isFile();
}

function discardOrphanSessionDirectoryLocked(ref: SessionRef): boolean {
  if (activeSessionId(ref.projectDir) === ref.sessionId) return false;
  const original = sessionRelativePath(ref.sessionId);
  const originalPath = join(ref.projectDir, original);
  if (!pathExists(originalPath)) return false;
  const identity = directoryIdentity(ref, original);
  if (!isCollectableOrphanDirectory(ref, original)) return false;
  const claim = claimRelativePath(ref, 'directory');
  const claimPath = join(ref.projectDir, claim);
  assertWritablePathConfined(original, ref.projectDir);
  assertWritablePathConfined(claim, ref.projectDir);
  renameSync(originalPath, claimPath);
  directoryIdentity(ref, claim, identity);
  if (!isCollectableOrphanDirectory(ref, claim)) {
    if (pathExists(originalPath)) {
      throw ownershipFailure(ref, 'the canonical session path was recreated');
    }
    renameSync(claimPath, originalPath);
    return false;
  }
  if (pathExists(originalPath)) {
    throw ownershipFailure(ref, 'the canonical session path was recreated');
  }
  rmSync(claimPath, { recursive: true });
  return true;
}

export function discardOrphanSessionDirectory(ref: SessionRef): boolean {
  try {
    validateSessionId(ref.sessionId);
    return withSessionMutationLock(ref.projectDir, () => discardOrphanSessionDirectoryLocked(ref));
  } catch (cause) {
    throw sessionPreparationError.io('discard-orphan-session', ref, cause);
  }
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
