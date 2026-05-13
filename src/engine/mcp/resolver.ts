import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafeAsync, readFileSafeAsync } from '../../lib/fs.js';
import { warnError } from '../../lib/warn.js';
import { isRecord } from '../../utils/type-guards.js';
import type { McpResourceDescriptor, McpResourceContent } from './types.js';
import { sessionDir, SPEC_FILE, PLAN_FILE, TASKS_FILE, STATE_FILE, EVIDENCE_FILE, DRIFT_REPORT_FILE } from '../../core/paths.js';
import { SUMMARY_FILE } from '../orchestrator/explain/artifacts.js';
import { listAllSessions } from '../../core/sessions/io.js';
import { SessionSchema } from '../../core/schemas/session.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import { parseTasks, splitTaskBlocks } from '../spec/parser.js';
import { hashTaskBrief } from '../../core/brief-hash.js';

export type McpResolverConfig = {
  projectDir: string;
  sessionIds: string[];
  diptychVersion: string;
};

export type McpResolver = {
  listResources(): Promise<McpResourceDescriptor[]>;
  readResource(uri: string): Promise<McpResourceContent | null>;
};

const BASE = 'mcp://diptych';

function sessionsUri(): string {
  return `${BASE}/sessions`;
}

function sessionBase(id: string): string {
  return `${BASE}/sessions/${id}`;
}

function parseTasksSafe(tasksContent: string) {
  try {
    return parseTasks(tasksContent);
  } catch {
    return [];
  }
}

function extractTaskBlock(tasksContent: string, taskId: string): string | null {
  const blocks = splitTaskBlocks(tasksContent);

  for (const block of blocks) {
    const blockId = extractIdFromBlock(block);
    if (blockId === taskId) {
      return block;
    }
  }

  return null;
}

function extractIdFromBlock(block: string): string | null {
  const lines = block.split('\n');
  let inFrontmatter = false;
  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      break;
    }
    if (inFrontmatter) {
      const m = line.match(/^id:\s*(.+)/);
      if (m?.[1]) return m[1].trim();
    }
  }
  return null;
}

async function readBriefHash(projectDir: string, sessionId: string): Promise<string | null> {
  const path = join(sessionDir(projectDir, sessionId), 'brief-hash.json');
  const content = await readFileSafeAsync(path);
  if (!content) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.hash === 'string') {
      return parsed.hash;
    }
    return null;
  } catch {
    return null;
  }
}

async function readGitHead(projectDir: string): Promise<string | null> {
  const path = join(projectDir, '.git', 'HEAD');
  const content = await readFileSafeAsync(path);
  if (!content) return null;
  const trimmed = content.trim();
  if (/^[0-9a-f]{40}$/i.test(trimmed)) return trimmed;
  return null;
}

async function hasCanonicalManifestArtifacts(projectDir: string, sessionId: string): Promise<boolean> {
  const sDir = sessionDir(projectDir, sessionId);
  const summaryResult = SessionSchema.safeParse(await readJsonSafeAsync(join(sDir, SUMMARY_FILE)));
  const stateResult = WorkflowStateSchema.safeParse(await readJsonSafeAsync(join(sDir, STATE_FILE)));
  return summaryResult.success && summaryResult.data.summary !== null && stateResult.success;
}

async function buildManifest(
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
  const taskIds = state.tasks.map(t => t.id);
  const existingTaskFiles = taskIds.map(id => `tasks/${id}.md`);

  const briefHashFromFile = await readBriefHash(projectDir, sessionId);
  const briefHash = briefHashFromFile ?? hashTaskBrief(state.tasks);
  const sourceCommit = await readGitHead(projectDir);
  const generatedAt = session.completedAt !== null
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

export function createResolver(config: McpResolverConfig): McpResolver {
  const { projectDir, sessionIds, diptychVersion } = config;

  async function listResources(): Promise<McpResourceDescriptor[]> {
    const descriptors: McpResourceDescriptor[] = [];

    descriptors.push({
      uri: sessionsUri(),
      name: 'Sessions list',
      mimeType: 'application/json',
    });

    for (const id of sessionIds) {
      const sDir = sessionDir(projectDir, id);

      if (await hasCanonicalManifestArtifacts(projectDir, id)) {
        descriptors.push({
          uri: `${sessionBase(id)}/manifest.json`,
          name: `Session manifest (${id})`,
          mimeType: 'application/json',
        });
      }

      descriptors.push({
        uri: `${sessionBase(id)}/tasks`,
        name: `Task list (${id})`,
        mimeType: 'application/json',
      });

      const conditionalFiles: Array<{ file: string; uri: string; name: string; mimeType: string }> = [
        { file: SPEC_FILE, uri: `${sessionBase(id)}/spec.md`, name: `Spec (${id})`, mimeType: 'text/markdown' },
        { file: PLAN_FILE, uri: `${sessionBase(id)}/plan.md`, name: `Plan (${id})`, mimeType: 'text/markdown' },
        { file: EVIDENCE_FILE, uri: `${sessionBase(id)}/evidence.json`, name: `Evidence (${id})`, mimeType: 'application/json' },
        { file: DRIFT_REPORT_FILE, uri: `${sessionBase(id)}/drift-report.json`, name: `Drift report (${id})`, mimeType: 'application/json' },
        { file: STATE_FILE, uri: `${sessionBase(id)}/state.json`, name: `Workflow state (${id})`, mimeType: 'application/json' },
        { file: SUMMARY_FILE, uri: `${sessionBase(id)}/summary.json`, name: `Summary (${id})`, mimeType: 'application/json' },
      ];

      for (const entry of conditionalFiles) {
        if (existsSync(join(sDir, entry.file))) {
          descriptors.push({ uri: entry.uri, name: entry.name, mimeType: entry.mimeType });
        }
      }

      const tasksPath = join(sDir, TASKS_FILE);
      if (existsSync(tasksPath)) {
        const content = await readFileSafeAsync(tasksPath);
        if (content) {
          const tasks = parseTasksSafe(content);
          for (const task of tasks) {
            descriptors.push({
              uri: `${sessionBase(id)}/tasks/${task.id}`,
              name: `Task ${task.id} (${id})`,
              mimeType: 'text/markdown',
            });
          }
        }
      }
    }

    return descriptors;
  }

  async function readResource(uri: string): Promise<McpResourceContent | null> {
    try {
      if (uri === sessionsUri()) {
        const allSessions = listAllSessions(projectDir);
        const filtered = allSessions.filter(s => sessionIds.includes(s.id));
        const result = filtered.map(s => ({
          id: s.id,
          title: s.feature,
          mode: s.summary?.mode ?? 'unknown',
          startedAt: s.startedAt,
          status: s.status,
        }));
        return { uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
      }

      const prefix = `${BASE}/sessions/`;
      if (!uri.startsWith(prefix)) return null;

      const rest = uri.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx === -1) return null;

      const id = rest.slice(0, slashIdx);
      if (!sessionIds.includes(id)) return null;

      const resource = rest.slice(slashIdx + 1);
      const sDir = sessionDir(projectDir, id);

      if (resource === 'manifest.json') {
        const manifest = await buildManifest(projectDir, id, diptychVersion);
        if (manifest === null) return null;
        return { uri, mimeType: 'application/json', text: JSON.stringify(manifest, null, 2) };
      }

      if (resource === 'spec.md') {
        const content = await readFileSafeAsync(join(sDir, SPEC_FILE));
        if (!content) return null;
        return { uri, mimeType: 'text/markdown', text: content };
      }

      if (resource === 'plan.md') {
        const content = await readFileSafeAsync(join(sDir, PLAN_FILE));
        if (!content) return null;
        return { uri, mimeType: 'text/markdown', text: content };
      }

      if (resource === 'tasks') {
        const tasksPath = join(sDir, TASKS_FILE);
        if (!existsSync(tasksPath)) {
          return { uri, mimeType: 'application/json', text: '[]' };
        }
        const content = await readFileSafeAsync(tasksPath);
        if (!content) return { uri, mimeType: 'application/json', text: '[]' };
        const tasks = parseTasksSafe(content);
        const result = tasks.map(t => ({
          id: t.id,
          title: t.title,
          action: t.action,
          file: t.file,
          status: t.status,
        }));
        return { uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
      }

      if (resource.startsWith('tasks/')) {
        const taskId = resource.slice('tasks/'.length);
        const tasksPath = join(sDir, TASKS_FILE);
        const content = await readFileSafeAsync(tasksPath);
        if (!content) return null;
        const block = extractTaskBlock(content, taskId);
        if (!block) return null;
        return { uri, mimeType: 'text/markdown', text: block };
      }

      if (resource === 'evidence.json') {
        const content = await readFileSafeAsync(join(sDir, EVIDENCE_FILE));
        if (!content) return null;
        return { uri, mimeType: 'application/json', text: content };
      }

      if (resource === 'drift-report.json') {
        const content = await readFileSafeAsync(join(sDir, DRIFT_REPORT_FILE));
        if (!content) return null;
        return { uri, mimeType: 'application/json', text: content };
      }

      if (resource === 'state.json') {
        const content = await readFileSafeAsync(join(sDir, STATE_FILE));
        if (!content) return null;
        return { uri, mimeType: 'application/json', text: content };
      }

      if (resource === 'summary.json') {
        const content = await readFileSafeAsync(join(sDir, SUMMARY_FILE));
        if (!content) return null;
        return { uri, mimeType: 'application/json', text: content };
      }

      return null;
    } catch (err) {
      warnError(`MCP readResource(${uri})`, err);
      return null;
    }
  }

  return { listResources, readResource };
}
