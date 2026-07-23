import { join } from 'node:path';
import { confinedExists, confinedReadFileAsync } from '../../lib/confined-fs.js';
import {
  DIPTYCH_DIR,
  SESSIONS_DIR,
  SPEC_FILE,
  PLAN_FILE,
  STATE_FILE,
  SUMMARY_FILE,
} from '../../core/paths.js';
import { parsePersistedSession } from '../../core/sessions/summary-parser.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import { hashTaskBrief } from '../brief-hash.js';
import { getCurrentCommitSha } from '../../lib/git/refs.js';

function sessionResourcePath(sessionId: string, file: string): string {
  return join(DIPTYCH_DIR, SESSIONS_DIR, sessionId, file);
}

async function readSessionJson(
  projectDir: string,
  sessionId: string,
  file: string,
): Promise<unknown | null> {
  const relativePath = sessionResourcePath(sessionId, file);
  try {
    if (!confinedExists(projectDir, relativePath)) return null;
    const raw = await confinedReadFileAsync(projectDir, relativePath);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function hasCanonicalManifestArtifacts(
  projectDir: string,
  sessionId: string,
): Promise<boolean> {
  const summaryResult = parsePersistedSession(
    await readSessionJson(projectDir, sessionId, SUMMARY_FILE),
  );
  const stateResult = WorkflowStateSchema.safeParse(
    await readSessionJson(projectDir, sessionId, STATE_FILE),
  );
  return (
    summaryResult.status === 'ok' && summaryResult.session.summary !== null && stateResult.success
  );
}

export async function buildManifest(
  projectDir: string,
  sessionId: string,
  diptychVersion: string,
): Promise<Record<string, unknown> | null> {
  const summaryResult = parsePersistedSession(
    await readSessionJson(projectDir, sessionId, SUMMARY_FILE),
  );
  const stateResult = WorkflowStateSchema.safeParse(
    await readSessionJson(projectDir, sessionId, STATE_FILE),
  );

  if (summaryResult.status === 'invalid' || !stateResult.success) {
    return null;
  }

  const session = summaryResult.session;
  const summary = session.summary;
  if (summary === null) {
    return null;
  }
  const state = stateResult.data;

  const specExists = confinedExists(projectDir, sessionResourcePath(sessionId, SPEC_FILE));
  const planExists = confinedExists(projectDir, sessionResourcePath(sessionId, PLAN_FILE));
  const taskIds = state.tasks.map((t) => t.id);
  const existingTaskFiles = taskIds.map((id) => `tasks/${id}`);

  const briefHash = hashTaskBrief(state.tasks);
  let sourceCommit: string | null = null;
  try {
    sourceCommit = await getCurrentCommitSha(projectDir);
  } catch {
    sourceCommit = null;
  }
  const generatedAt =
    session.completedAt !== null
      ? new Date(session.completedAt).toISOString()
      : new Date(session.startedAt).toISOString();

  const manifest: Record<string, unknown> = {
    packVersion: '1',
    diptychVersion,
    generatedAt,
    sessionId: session.id,
    briefHash,
    ...(sourceCommit !== null ? { sourceCommit } : {}),
    target: 'live-mcp',
    mode: summary.mode,
    taskIds,
    artifacts: {
      ...(specExists ? { spec: 'spec.md' } : {}),
      ...(planExists ? { plan: 'plan.md' } : {}),
      tasks: existingTaskFiles,
    },
    validation: {},
  };

  return manifest;
}
