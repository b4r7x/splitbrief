import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fsError } from '../lib/fs.js';
import { sha256Hex } from '../utils/sha256.js';
import { validateSafeIdentifier } from '../utils/validate-identifier.js';
import { SPLITBRIEF_IDENTITY } from './identity.js';
import type { SessionRef } from './types/session-ref.js';

export const SPLITBRIEF_DIR = SPLITBRIEF_IDENTITY.stateDir;
export const SANDBOX_DIR = `${SPLITBRIEF_IDENTITY.stateDir}/sandbox`;
export const CODEX_DIR = '.codex';
export const SKILLS_DIR = 'skills';
export const SESSIONS_DIR = 'sessions';
/** The one-shot `review` command's artifact root; it owns no session. */
export const REVIEWS_DIR = 'reviews';
export const ACTIVE_FILE = 'active';

export const activeFile = (projectDir: string): string =>
  join(projectDir, SPLITBRIEF_DIR, ACTIVE_FILE);

export const sessionsRoot = (projectDir: string): string =>
  join(projectDir, SPLITBRIEF_DIR, SESSIONS_DIR);

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateSessionId(sessionId: string): void {
  const result = validateSafeIdentifier(sessionId);
  if (!result.ok) {
    throw fsError.invalidId('session id', sessionId, result.reason);
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw fsError.invalidId(
      'session id',
      sessionId,
      'must contain only letters, numbers, dots, underscores or hyphens and start with a letter or number',
    );
  }
}

export function isValidSessionId(sessionId: string): boolean {
  try {
    validateSessionId(sessionId);
    return true;
  } catch {
    return false;
  }
}

export function sessionDir(projectDir: string, sessionId: string): string {
  validateSessionId(sessionId);
  return join(projectDir, SPLITBRIEF_DIR, SESSIONS_DIR, sessionId);
}

export const reviewPacketJsonPath = (ref: SessionRef): string =>
  join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_PACKET_JSON_FILE);

export const reviewPacketMarkdownPath = (ref: SessionRef): string =>
  join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_PACKET_MARKDOWN_FILE);

export const getSplitbriefPath = (projectDir: string, ...parts: string[]): string =>
  join(projectDir, SPLITBRIEF_DIR, ...parts);

const APPROVALS_FILE = 'approvals.json';

export const approvalsFile = (projectDir: string): string =>
  join(projectDir, SPLITBRIEF_DIR, APPROVALS_FILE);

export const SPEC_FILE = 'spec.md';
export const PLAN_FILE = 'plan.md';
export const TASKS_FILE = 'tasks.md';
export const RESEARCH_FILE = 'research.md';
export const REVIEW_FILE = 'review.md';
export const STATE_FILE = 'state.json';
/** Seat identities the session started on; sits beside state.json (`core/state/seats.ts`). */
export const SEATS_FILE = 'seats.json';
export const SUMMARY_FILE = 'summary.json';
export const SESSION_LOG_FILE = 'session.jsonl';
export const CONFIG_FILE = 'config.yaml';
export const CLARIFICATIONS_FILE = 'clarifications.md';
export const CONSTITUTION_CHECK_FILE = 'constitution-check.json';
export const SPECIFY_CONSTITUTION_FILE = join('.specify', 'memory', 'constitution.md');
export const ANALYZE_FILE = 'analyze.json';
export const EVIDENCE_FILE = 'evidence.json';
export const DRIFT_REPORT_FILE = 'drift-report.json';
export const DRIFT_CHAINS_FILE = 'drift-chains.json';
export const BRIEF_QUALITY_FILE = 'brief-quality.json';
export const BRIEF_READINESS_FILE = 'brief-readiness.json';
export const READINESS_FILE = 'readiness.json';
export const REVIEW_PACKET_JSON_FILE = 'review-packet.json';
export const REVIEW_PACKET_MARKDOWN_FILE = 'review-packet.md';
export const LOCKFILE = 'lockfile.json';
export const UI_PREFS_FILE = 'ui-prefs.json';
export const RUNTIME_CONFORMANCE_FILE = 'runtime-conformance.json';

/**
 * The in-project worktree root: `.trees/<slug>`. Nothing creates one any more —
 * it was the root of the removed `start --worktree` flag — but a checkout made
 * before that removal still has the directory on disk, so file discovery
 * (`INTERNAL_SKIP_DIRS`), git status (`GIT_STATUS_INTERNAL_DIRS`), the gitignore
 * the loader writes and the staged-project walker all still have to skip it.
 * It is not the run's own isolation worktree — that one is `ISOLATION_TREES_DIR`
 * below and lives outside the project entirely.
 */
export const TREES_DIR = '.trees';

// Run isolation lives outside `.git/` because direct-writing CLIs refuse paths
// there as sensitive. It also lives outside the project root so project-rooted
// test discovery never walks into the second checkout.
export const ISOLATION_TREES_DIR = 'trees';

export const INTERNAL_SKIP_DIRS = ['.git', SPLITBRIEF_DIR, 'node_modules', TREES_DIR];

const GIT_STATUS_INTERNAL_DIRS = [SPLITBRIEF_DIR, TREES_DIR];

export function isInternalGitStatusPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return GIT_STATUS_INTERNAL_DIRS.some(
    (dir) =>
      normalized === dir || normalized.startsWith(`${dir}/`) || normalized.includes(`/${dir}/`),
  );
}

/**
 * Where a worktree would land inside the project when no caller named a
 * directory. Only `resolveConfinedWorktreePath` reaches it, and only to prove a
 * symlinked `.trees` cannot carry one out of the project root; every production
 * caller passes its own directory, and run isolation's lives outside entirely.
 */
export const worktreePath = (projectDir: string, slug: string): string =>
  join(projectDir, TREES_DIR, slug);

function userStateDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME;
  return xdgStateHome && isAbsolute(xdgStateHome)
    ? xdgStateHome
    : join(homedir(), '.local', 'state');
}

export const isolationTreesRoot = (): string =>
  join(userStateDir(), SPLITBRIEF_IDENTITY.slug, ISOLATION_TREES_DIR);

export const isolationWorktreeRoot = (gitCommonDir: string): string =>
  join(isolationTreesRoot(), sha256Hex(realpathSync(gitCommonDir)).slice(0, 12));

export const isolationWorktreePath = (gitCommonDir: string, slug: string): string =>
  join(isolationWorktreeRoot(gitCommonDir), slug);

const ISOLATION_MARKER_FILE = 'isolation-marker';

export const isolationMarkerPath = (worktreeDir: string): string =>
  join(worktreeDir, SPLITBRIEF_DIR, ISOLATION_MARKER_FILE);

export const SNAPSHOTS_DIR = 'snapshots';
export const SNAPSHOT_BASELINE_ID = 'baseline';
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
const SNAPSHOT_FILES_DIR = 'files';
const SNAPSHOT_LOCK_FILE = '.lock';

export const snapshotsDir = (ref: SessionRef): string =>
  join(sessionDir(ref.projectDir, ref.sessionId), SNAPSHOTS_DIR);

export const snapshotDir = (ref: SessionRef, snapshotId: string): string =>
  join(snapshotsDir(ref), snapshotId);

export const baselineDir = (ref: SessionRef): string => snapshotDir(ref, SNAPSHOT_BASELINE_ID);

export const snapshotManifestPath = (ref: SessionRef, snapshotId: string): string =>
  join(snapshotDir(ref, snapshotId), SNAPSHOT_MANIFEST_FILE);

export const snapshotFilesDir = (ref: SessionRef, snapshotId: string): string =>
  join(snapshotDir(ref, snapshotId), SNAPSHOT_FILES_DIR);

export const snapshotLockPath = (ref: SessionRef): string =>
  join(snapshotsDir(ref), SNAPSHOT_LOCK_FILE);
