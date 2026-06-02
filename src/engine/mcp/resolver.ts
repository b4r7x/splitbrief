import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSafeAsync } from '../../lib/fs.js';
import { warnError } from '../../lib/warn.js';
import type { McpResourceDescriptor, McpResourceContent } from './types.js';
import {
  sessionDir,
  SPEC_FILE,
  PLAN_FILE,
  TASKS_FILE,
  STATE_FILE,
  EVIDENCE_FILE,
  DRIFT_REPORT_FILE,
} from '../../core/paths.js';
import { SUMMARY_FILE } from '../../core/paths.js';
import { listAllSessions } from '../../core/sessions/io.js';
import { parseTasks, splitTaskBlocks } from '../spec/parser.js';
import { parseSimpleYamlFrontmatter } from '../../utils/frontmatter.js';
import { buildManifest, hasCanonicalManifestArtifacts } from './manifest.js';

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

      for (const entry of SESSION_RESOURCE_FILES) {
        if (existsSync(join(sDir, entry.file))) {
          descriptors.push({
            uri: `${sessionBase(id)}/${entry.key}`,
            name: `${entry.label} (${id})`,
            mimeType: entry.mimeType,
          });
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
        const filtered = allSessions.filter((s) => sessionIds.includes(s.id));
        const result = filtered.map((s) => ({
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

      if (resource === 'tasks') {
        const tasksPath = join(sDir, TASKS_FILE);
        if (!existsSync(tasksPath)) {
          return { uri, mimeType: 'application/json', text: '[]' };
        }
        const content = await readFileSafeAsync(tasksPath);
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
        const taskId = resource.slice('tasks/'.length);
        const tasksPath = join(sDir, TASKS_FILE);
        const content = await readFileSafeAsync(tasksPath);
        if (!content) return null;
        const block = extractTaskBlock(content, taskId);
        if (!block) return null;
        return { uri, mimeType: 'text/markdown', text: block };
      }

      const staticResource = STATIC_RESOURCES[resource];
      if (staticResource) {
        const content = await readFileSafeAsync(join(sDir, staticResource.file));
        if (!content) return null;
        return { uri, mimeType: staticResource.mimeType, text: content };
      }

      return null;
    } catch (err) {
      warnError(`MCP readResource(${uri})`, err);
      return null;
    }
  }

  return { listResources, readResource };
}
