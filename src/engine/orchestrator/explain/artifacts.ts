import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DRIFT_REPORT_FILE,
  EVIDENCE_FILE,
  READINESS_FILE,
  REVIEW_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  SESSION_LOG_FILE,
  STATE_FILE,
  SUMMARY_FILE,
  sessionDir,
} from '../../../core/paths.js';
import { loadState } from '../../../core/state/persistence.js';
import { SessionSchema } from '../../../core/schemas/session.js';
import { SummarySchema, type Summary } from '../../../core/schemas/summary.js';
import { ReviewPacketSchema, type ReviewPacket } from '../../../core/schemas/review-packet.js';
import type { SessionLogEventEntry } from '../../../core/schemas/session-log.js';
import { readEvents } from '../../../core/sessions/log-reader.js';
import { readJsonSafeAsync } from '../../../lib/fs.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { error } from '../../../utils/error.js';
import { narrowRecord, optionalString } from '../../../utils/type-guards.js';
import type {
  ExplainArtifactInputs,
  ReadinessSummary,
  RunExplainArtifact,
} from './types.js';

export const explainArtifactsError = {
  sessionPathNotDirectory: (sessionId: string) =>
    error('explain-session-path-not-directory', `Session path is not a directory: ${sessionId}`, { sessionId }),
  sessionNotFound: (sessionId: string) =>
    error('explain-session-not-found', `No session found: ${sessionId}`, { sessionId }),
} as const;

const ARTIFACT_FILES = [
  { key: 'summary', file: SUMMARY_FILE },
  { key: 'state', file: STATE_FILE },
  { key: 'sessionLog', file: SESSION_LOG_FILE },
  { key: 'readiness', file: READINESS_FILE },
  { key: 'review', file: REVIEW_FILE },
  { key: 'reviewPacketJson', file: REVIEW_PACKET_JSON_FILE },
  { key: 'reviewPacketMarkdown', file: REVIEW_PACKET_MARKDOWN_FILE },
  { key: 'evidence', file: EVIDENCE_FILE },
  { key: 'drift', file: DRIFT_REPORT_FILE },
] as const;

export function artifactPath(sessionId: string, file: string): string {
  return `.diptych/sessions/${sessionId}/${file}`;
}

export async function assertSessionDirectory(projectDir: string, sessionId: string): Promise<void> {
  try {
    const stats = await stat(sessionDir(projectDir, sessionId));
    if (!stats.isDirectory()) throw explainArtifactsError.sessionPathNotDirectory(sessionId);
  } catch (err) {
    if (isENOENT(err)) throw explainArtifactsError.sessionNotFound(sessionId);
    throw err;
  }
}

export async function readExplainArtifacts(projectDir: string, sessionId: string): Promise<ExplainArtifactInputs> {
  const [summary, reviewPacket, state, readiness, events, artifacts] = await Promise.all([
    readSummary(projectDir, sessionId),
    readReviewPacket(projectDir, sessionId),
    Promise.resolve(loadState(projectDir, sessionId)),
    readReadiness(projectDir, sessionId),
    readLogEvents(projectDir, sessionId),
    readArtifacts(projectDir, sessionId),
  ]);
  return { summary, reviewPacket, state, readiness, events, artifacts };
}

async function hasArtifact(projectDir: string, sessionId: string, file: string): Promise<boolean> {
  try {
    const stats = await stat(join(sessionDir(projectDir, sessionId), file));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function readArtifacts(projectDir: string, sessionId: string): Promise<RunExplainArtifact[]> {
  return Promise.all(ARTIFACT_FILES.map(async ({ key, file }) => ({
    key,
    path: artifactPath(sessionId, file),
    present: await hasArtifact(projectDir, sessionId, file),
  })));
}

async function readJson(projectDir: string, sessionId: string, file: string): Promise<unknown | null> {
  return readJsonSafeAsync(join(sessionDir(projectDir, sessionId), file));
}

async function readSummary(projectDir: string, sessionId: string): Promise<Summary | null> {
  const raw = await readJson(projectDir, sessionId, SUMMARY_FILE);
  if (raw === null) return null;
  const session = SessionSchema.safeParse(raw);
  if (session.success) return session.data.summary;
  const summary = SummarySchema.safeParse(raw);
  return summary.success ? summary.data : null;
}

async function readReviewPacket(projectDir: string, sessionId: string): Promise<ReviewPacket | null> {
  const raw = await readJson(projectDir, sessionId, REVIEW_PACKET_JSON_FILE);
  if (raw === null) return null;
  const parsed = ReviewPacketSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readReadiness(projectDir: string, sessionId: string): Promise<ReadinessSummary | null> {
  const raw = await readJson(projectDir, sessionId, READINESS_FILE);
  const record = narrowRecord(raw);
  if (!record || record.type !== 'start-readiness') return null;
  return {
    present: true,
    status: optionalString(record.status, { trim: true, nonEmpty: true }) ?? null,
    checks: readinessChecks(record.checks),
  };
}

function readinessChecks(value: unknown): ReadinessSummary['checks'] {
  if (!Array.isArray(value)) return [];
  const checks: ReadinessSummary['checks'] = [];
  for (const entry of value) {
    const record = narrowRecord(entry);
    const id = optionalString(record?.id, { trim: true, nonEmpty: true });
    const severity = optionalString(record?.severity, { trim: true, nonEmpty: true });
    const summary = optionalString(record?.summary, { trim: true, nonEmpty: true });
    if (id && severity && summary) checks.push({ id, severity, summary });
  }
  return checks;
}

async function readLogEvents(projectDir: string, sessionId: string): Promise<SessionLogEventEntry[]> {
  const events: SessionLogEventEntry[] = [];
  for await (const event of readEvents({ projectDir: projectDir, sessionId: sessionId })) {
    events.push(event);
  }
  return events;
}
