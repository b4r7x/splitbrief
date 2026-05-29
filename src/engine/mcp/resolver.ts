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

const STATIC_RESOURCES: Record<string, { file: string; mimeType: string }> = {
  'spec.md': { file: SPEC_FILE, mimeType: 'text/markdown' },
  'plan.md': { file: PLAN_FILE, mimeType: 'text/markdown' },
  'evidence.json': { file: EVIDENCE_FILE, mimeType: 'application/json' },
  'drift-report.json': { file: DRIFT_REPORT_FILE, mimeType: 'application/json' },
  'state.json': { file: STATE_FILE, mimeType: 'application/json' },
  'summary.json': { file: SUMMARY_FILE, mimeType: 'application/json' },
};

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

      const conditionalFiles: Array<{ file: string; uri: string; name: string; mimeType: string }> =
        [
          {
            file: SPEC_FILE,
            uri: `${sessionBase(id)}/spec.md`,
            name: `Spec (${id})`,
            mimeType: 'text/markdown',
          },
          {
            file: PLAN_FILE,
            uri: `${sessionBase(id)}/plan.md`,
            name: `Plan (${id})`,
            mimeType: 'text/markdown',
          },
          {
            file: EVIDENCE_FILE,
            uri: `${sessionBase(id)}/evidence.json`,
            name: `Evidence (${id})`,
            mimeType: 'application/json',
          },
          {
            file: DRIFT_REPORT_FILE,
            uri: `${sessionBase(id)}/drift-report.json`,
            name: `Drift report (${id})`,
            mimeType: 'application/json',
          },
          {
            file: STATE_FILE,
            uri: `${sessionBase(id)}/state.json`,
            name: `Workflow state (${id})`,
            mimeType: 'application/json',
          },
          {
            file: SUMMARY_FILE,
            uri: `${sessionBase(id)}/summary.json`,
            name: `Summary (${id})`,
            mimeType: 'application/json',
          },
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
