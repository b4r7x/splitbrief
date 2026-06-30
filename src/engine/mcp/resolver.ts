import { join } from 'node:path';
import { confinedReadFileAsync } from '../../lib/confined-fs.js';
import { warnError } from '../../lib/warn.js';
import type { McpResourceDescriptor, McpResourceContent } from './types.js';
import {
  DIPTYCH_DIR,
  SESSIONS_DIR,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  STATE_FILE,
  EVIDENCE_FILE,
  DRIFT_REPORT_FILE,
} from '../../core/paths.js';
import { SUMMARY_FILE } from '../../core/paths.js';
import { parsePersistedSession } from '../../core/sessions/summary-parser.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import { projectWorkflowStateForTranscriptPolicy } from '../../core/state/persistence.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { readSessionPersistTranscript } from '../../core/sessions/io.js';
import { parseTasks, splitTaskBlocks } from '../spec/parser.js';
import { parseSimpleYamlFrontmatter } from '../../utils/frontmatter.js';
import { buildManifest, hasCanonicalManifestArtifacts } from './manifest.js';

export type McpResolverConfig = {
  projectDir: string;
  sessionIds: string[];
  diptychVersion: string;
  persistTranscript?: boolean | undefined;
};

export type McpResolver = {
  listResources(): Promise<McpResourceDescriptor[]>;
  readResource(uri: string): Promise<McpResourceContent | null>;
};

const BASE = 'mcp://diptych';

const SESSION_RESOURCE_FILES: ReadonlyArray<{
  key: string;
  file: string;
  mimeType: string;
  label: string;
}> = [
  { key: 'spec.md', file: SPEC_FILE, mimeType: 'text/markdown', label: 'Spec' },
  { key: 'plan.md', file: PLAN_FILE, mimeType: 'text/markdown', label: 'Plan' },
  { key: 'evidence.json', file: EVIDENCE_FILE, mimeType: 'application/json', label: 'Evidence' },
  {
    key: 'drift-report.json',
    file: DRIFT_REPORT_FILE,
    mimeType: 'application/json',
    label: 'Drift report',
  },
  { key: 'state.json', file: STATE_FILE, mimeType: 'application/json', label: 'Workflow state' },
  { key: 'summary.json', file: SUMMARY_FILE, mimeType: 'application/json', label: 'Summary' },
];

const STATIC_RESOURCES: Record<string, { file: string; mimeType: string }> = Object.fromEntries(
  SESSION_RESOURCE_FILES.map((r) => [r.key, { file: r.file, mimeType: r.mimeType }]),
);

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
  const id = parseSimpleYamlFrontmatter(block)?.id;
  return typeof id === 'string' ? id : null;
}

export function createResolver(config: McpResolverConfig): McpResolver {
  const { projectDir, sessionIds, diptychVersion } = config;
  const fallbackPersistTranscript = config.persistTranscript ?? true;

  function sessionPersistTranscript(id: string): boolean {
    return fallbackPersistTranscript && readSessionPersistTranscript({ projectDir, sessionId: id });
  }

  function sessionTitle(id: string, title: string): string {
    return sessionPersistTranscript(id) ? title : TRANSCRIPT_OMITTED_MESSAGE;
  }

  function sessionResourcePath(id: string, file: string): string {
    return join(DIPTYCH_DIR, SESSIONS_DIR, id, file);
  }

  async function readSessionFile(id: string, file: string): Promise<string | null> {
    try {
      return await confinedReadFileAsync(projectDir, sessionResourcePath(id, file));
    } catch {
      return null;
    }
  }

  async function sessionFileExists(id: string, file: string): Promise<boolean> {
    return (await readSessionFile(id, file)) !== null;
  }

  async function readSessionDescriptor(id: string): Promise<Record<string, unknown> | null> {
    const summaryContent = await readSessionFile(id, SUMMARY_FILE);
    if (summaryContent !== null) {
      try {
        const parsed = parsePersistedSession(JSON.parse(summaryContent));
        if (parsed.status === 'ok') {
          return {
            id,
            title: sessionTitle(id, parsed.session.feature),
            mode: parsed.session.summary?.mode ?? 'unknown',
            startedAt: parsed.session.startedAt,
            status: parsed.session.status,
          };
        }
      } catch {
        return null;
      }
    }

    const stateContent = await readSessionFile(id, STATE_FILE);
    if (stateContent === null) return null;
    try {
      const parsed = WorkflowStateSchema.safeParse(JSON.parse(stateContent));
      if (!parsed.success) return null;
      const startedAt = Date.parse(parsed.data.startedAt);
      return {
        id,
        title: sessionTitle(id, parsed.data.feature),
        mode: 'unknown',
        startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
        status: 'interrupted',
      };
    } catch {
      return null;
    }
  }

  async function listResources(): Promise<McpResourceDescriptor[]> {
    const descriptors: McpResourceDescriptor[] = [];

    descriptors.push({
      uri: sessionsUri(),
      name: 'Sessions list',
      mimeType: 'application/json',
    });

    for (const id of sessionIds) {
      const sessionDescriptor = await readSessionDescriptor(id);
      const tasksContent = await readSessionFile(id, TASKS_FILE);

      if (await hasCanonicalManifestArtifacts(projectDir, id)) {
        descriptors.push({
          uri: `${sessionBase(id)}/manifest.json`,
          name: `Session manifest (${id})`,
          mimeType: 'application/json',
        });
      }

      if (sessionDescriptor !== null || tasksContent !== null) {
        descriptors.push({
          uri: `${sessionBase(id)}/tasks`,
          name: `Task list (${id})`,
          mimeType: 'application/json',
        });
      }

      for (const entry of SESSION_RESOURCE_FILES) {
        if (await sessionFileExists(id, entry.file)) {
          descriptors.push({
            uri: `${sessionBase(id)}/${entry.key}`,
            name: `${entry.label} (${id})`,
            mimeType: entry.mimeType,
          });
        }
      }

      if (tasksContent) {
        const tasks = parseTasksSafe(tasksContent);
        for (const task of tasks) {
          descriptors.push({
            uri: `${sessionBase(id)}/tasks/${task.id}`,
            name: `Task ${task.id} (${id})`,
            mimeType: 'text/markdown',
          });
        }
      }
    }

    return descriptors;
  }

  async function readResource(uri: string): Promise<McpResourceContent | null> {
    try {
      if (uri === sessionsUri()) {
        const result = [];
        for (const id of sessionIds) {
          const descriptor = await readSessionDescriptor(id);
          if (descriptor !== null) result.push(descriptor);
        }
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

      if (resource === 'manifest.json') {
        const manifest = await buildManifest(projectDir, id, diptychVersion);
        if (manifest === null) return null;
        return { uri, mimeType: 'application/json', text: JSON.stringify(manifest, null, 2) };
      }

      if (resource === 'tasks') {
        const content = await readSessionFile(id, TASKS_FILE);
        if (!content) return { uri, mimeType: 'application/json', text: '[]' };
        const tasks = parseTasksSafe(content);
        const result = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          action: t.action,
          file: t.file,
          status: t.status,
        }));
        return { uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) };
      }

      if (resource.startsWith('tasks/')) {
        let taskId = resource.slice('tasks/'.length);
        if (taskId.endsWith('.md')) taskId = taskId.slice(0, -'.md'.length);
        const content = await readSessionFile(id, TASKS_FILE);
        if (!content) return null;
        const block = extractTaskBlock(content, taskId);
        if (!block) return null;
        return { uri, mimeType: 'text/markdown', text: block };
      }

      const staticResource = STATIC_RESOURCES[resource];
      if (staticResource) {
        if (resource === 'state.json') return readStateResource(uri, id);
        const content = await readSessionFile(id, staticResource.file);
        if (!content) return null;
        return { uri, mimeType: staticResource.mimeType, text: content };
      }

      return null;
    } catch (err) {
      warnError(`MCP readResource(${uri})`, err);
      return null;
    }
  }

  async function readStateResource(uri: string, id: string): Promise<McpResourceContent | null> {
    const content = await readSessionFile(id, STATE_FILE);
    if (!content) return null;
    if (sessionPersistTranscript(id)) return { uri, mimeType: 'application/json', text: content };

    try {
      const parsed = WorkflowStateSchema.safeParse(JSON.parse(content));
      if (!parsed.success) return null;
      const state = projectWorkflowStateForTranscriptPolicy(parsed.data, {
        persistTranscript: false,
      });
      return { uri, mimeType: 'application/json', text: `${JSON.stringify(state, null, 2)}\n` };
    } catch {
      return null;
    }
  }

  return { listResources, readResource };
}
