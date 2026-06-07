import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafeAsync } from '../../lib/fs.js';
import { isRecord } from '../../utils/type-guards.js';
import {
  sessionDir,
  SPEC_FILE,
  PLAN_FILE,
  STATE_FILE,
  SUMMARY_FILE,
  BRIEF_HASH_FILE,
} from '../../core/paths.js';
import { SessionSchema } from '../../core/schemas/session.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import { hashTaskBrief } from '../brief-hash.js';
import { getCurrentCommitSha } from '../../lib/git.js';

async function readBriefHash(projectDir: string, sessionId: string): Promise<string | null> {
  const parsed = await readJsonSafeAsync(join(sessionDir(projectDir, sessionId), BRIEF_HASH_FILE));
  return isRecord(parsed) && typeof parsed.hash === 'string' ? parsed.hash : null;
}

export async function hasCanonicalManifestArtifacts(
  projectDir: string,
  sessionId: string,
): Promise<boolean> {
  const sDir = sessionDir(projectDir, sessionId);
  const summaryResult = SessionSchema.safeParse(await readJsonSafeAsync(join(sDir, SUMMARY_FILE)));
  const stateResult = WorkflowStateSchema.safeParse(
    await readJsonSafeAsync(join(sDir, STATE_FILE)),
  );
  return summaryResult.success && summaryResult.data.summary !== null && stateResult.success;
}

export async function buildManifest(
  projectDir: string,
  sessionId: string,
  diptychVersion: string,
): Promise<Record<string, unknown> | null> {
  const sDir = sessionDir(projectDir, sessionId);

  const summaryRaw = await readJsonSafeAsync(join(sDir, SUMMARY_FILE));
  const stateRaw = await readJsonSafeAsync(join(sDir, STATE_FILE));
  const summaryResult = SessionSchema.safeParse(summaryRaw);
  const stateResult = WorkflowStateSchema.safeParse(stateRaw);

  if (!summaryResult.success || !stateResult.success) {
    return null;
  }

  const session = summaryResult.data;
  const summary = session.summary;
  if (summary === null) {
    return null;
  }
  const state = stateResult.data;

  const specExists = existsSync(join(sDir, SPEC_FILE));
  const planExists = existsSync(join(sDir, PLAN_FILE));
  const taskIds = state.tasks.map((t) => t.id);
  const existingTaskFiles = taskIds.map((id) => `tasks/${id}`);

  const briefHashFromFile = await readBriefHash(projectDir, sessionId);
  const briefHash = briefHashFromFile ?? hashTaskBrief(state.tasks);
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
