import { join } from 'node:path';
import { fsError } from '../lib/fs.js';
import { validateSafeIdentifier } from '../utils/validate-identifier.js';

export const DIPTYCH_DIR = '.diptych';
export const CODEX_DIR = '.codex';
export const SKILLS_DIR = 'skills';
export const SESSIONS_DIR = 'sessions';
export const ACTIVE_FILE = 'active';

export const activeFile = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR, ACTIVE_FILE);

export const sessionsRoot = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR, SESSIONS_DIR);

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

export function sessionDir(projectDir: string, sessionId: string): string {
  validateSessionId(sessionId);
  return join(projectDir, DIPTYCH_DIR, SESSIONS_DIR, sessionId);
}

export const reviewPacketJsonPath = (projectDir: string, sessionId: string): string =>
  join(sessionDir(projectDir, sessionId), REVIEW_PACKET_JSON_FILE);

export const reviewPacketMarkdownPath = (projectDir: string, sessionId: string): string =>
  join(sessionDir(projectDir, sessionId), REVIEW_PACKET_MARKDOWN_FILE);

export const getDiptychPath = (projectDir: string, ...parts: string[]): string =>
  join(projectDir, DIPTYCH_DIR, ...parts);

const APPROVALS_FILE = 'approvals.json';

export const approvalsFile = (projectDir: string): string =>
  join(projectDir, DIPTYCH_DIR, APPROVALS_FILE);

export const SPEC_FILE = 'spec.md';
export const PLAN_FILE = 'plan.md';
export const TASKS_FILE = 'tasks.md';
export const RESEARCH_FILE = 'research.md';
export const REVIEW_FILE = 'review.md';
export const STATE_FILE = 'state.json';
export const SUMMARY_FILE = 'summary.json';
export const SESSION_LOG_FILE = 'session.jsonl';
export const CONFIG_FILE = 'config.yaml';
export const CLARIFICATIONS_FILE = 'clarifications.md';
export const CONSTITUTION_CHECK_FILE = 'constitution-check.json';
export const ANALYZE_FILE = 'analyze.json';
export const EVIDENCE_FILE = 'evidence.json';
export const DRIFT_REPORT_FILE = 'drift-report.json';
export const DRIFT_CHAINS_FILE = 'drift-chains.json';
export const BRIEF_QUALITY_FILE = 'brief-quality.json';
export const READINESS_FILE = 'readiness.json';
export const REVIEW_PACKET_JSON_FILE = 'review-packet.json';
export const REVIEW_PACKET_MARKDOWN_FILE = 'review-packet.md';
export const LOCKFILE = 'lockfile.json';
export const SERVER_LOG_FILE = 'server.log';
export const IPC_SOCK_FILE = 'ipc.sock';

export const TREES_DIR = '.trees';

export const worktreePath = (projectDir: string, slug: string): string =>
  join(projectDir, TREES_DIR, slug);

export const SNAPSHOTS_DIR = 'snapshots';
export const SNAPSHOT_BASELINE_ID = 'baseline';
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json';
const SNAPSHOT_FILES_DIR = 'files';
const SNAPSHOT_LOCK_FILE = '.lock';

export const snapshotsDir = (projectDir: string, sessionId: string): string =>
  join(sessionDir(projectDir, sessionId), SNAPSHOTS_DIR);

export const snapshotDir = (projectDir: string, sessionId: string, snapshotId: string): string =>
  join(snapshotsDir(projectDir, sessionId), snapshotId);

export const baselineDir = (projectDir: string, sessionId: string): string =>
  snapshotDir(projectDir, sessionId, SNAPSHOT_BASELINE_ID);

export const snapshotManifestPath = (
  projectDir: string,
  sessionId: string,
  snapshotId: string,
): string => join(snapshotDir(projectDir, sessionId, snapshotId), SNAPSHOT_MANIFEST_FILE);

export const snapshotFilesDir = (
  projectDir: string,
  sessionId: string,
  snapshotId: string,
): string => join(snapshotDir(projectDir, sessionId, snapshotId), SNAPSHOT_FILES_DIR);

export const snapshotLockPath = (projectDir: string, sessionId: string): string =>
  join(snapshotsDir(projectDir, sessionId), SNAPSHOT_LOCK_FILE);
