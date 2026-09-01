import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { saveSummary } from '../../core/sessions/io.js';
import { saveState } from '../../core/state/persistence.js';
import { createInitialState, CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { hashTaskBrief } from '../brief-hash.js';
import { createResolver } from './resolver.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR } from '../../core/paths.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const SESSION_STUB = {
  id: '',
  feature: 'test feature',
  startedAt: 1700000000000,
  completedAt: null,
  stateVersion: 1,
  status: 'interrupted' as const,
  summary: null,
};

const taskOne = makeTask({ id: 'T001', title: 'Create something' });
const taskTwo = makeTask({ id: 'T002', title: 'Modify something', dependsOn: ['T001'] });

function makeCompleteSession(id: string) {
  return {
    ...SESSION_STUB,
    id,
    completedAt: 1700000005000,
    status: 'complete' as const,
    summary: {
      feature: 'test feature',
      totalTasks: 2,
      completedByLocal: 2,
      escalatedToPlanner: 0,
      skipped: 0,
      failed: 0,
      totalTime: 5000,
      tokenUsage: makeUsage(),
      estimatedCostSavings: '$0.00',
      escalationRate: 0,
      mode: 'speckit' as const,
    },
  };
}

function writeCanonicalArtifacts(projectDir: string, sessionId: string): void {
  saveSummary({ projectDir: projectDir, sessionId: sessionId }, makeCompleteSession(sessionId));
  saveState(
    { projectDir, sessionId },
    {
      ...createInitialState('test feature'),
      stateVersion: CURRENT_STATE_VERSION,
      tasks: [taskOne, taskTwo],
    },
  );
}

function writeCanonicalArtifactsAtSessionsRoot(sessionsRoot: string, sessionId: string): void {
  const dir = join(sessionsRoot, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    `${JSON.stringify(makeCompleteSession(sessionId), null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'state.json'),
    `${JSON.stringify(
      {
        ...createInitialState('test feature'),
        stateVersion: CURRENT_STATE_VERSION,
        tasks: [taskOne, taskTwo],
      },
      null,
      2,
    )}\n`,
  );
}

const TASKS_MD = `---
id: T001
title: "Create something"
action: create
file: src/foo.ts
depends_on: []
---

### Description
Do the thing.

---
id: T002
title: "Modify something"
action: modify
file: src/bar.ts
depends_on: [T001]
---

### Description
Modify the other thing.
`;

let dirs: string[] = [];
let projectDir: string;
beforeEach(() => {
  projectDir = createTempDir('resolver-test');
  dirs.push(projectDir);
});
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function makeResolver(projectDir: string, sessionId: string, persistTranscript = true) {
  return createResolver({
    projectDir,
    sessionIds: [sessionId],
    splitbriefVersion: '1.2.3',
    persistTranscript,
  });
}

function sessionPath(projectDir: string, sessionId: string): string {
  return join(projectDir, '.splitbrief', 'sessions', sessionId);
}

describe('listResources', () => {
  it('includes /sessions and available /manifest.json URIs', async () => {
    const id = 'sess-1';
    ensureSessionDir(projectDir, id);
    writeCanonicalArtifacts(projectDir, id);

    const resolver = makeResolver(projectDir, id);
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).toContain('mcp://splitbrief/sessions');
    expect(uris).toContain(`mcp://splitbrief/sessions/${id}/manifest.json`);
  });

  it('does not advertise manifest.json when canonical summary/state artifacts are unavailable', async () => {
    const id = 'sess-without-state';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, makeCompleteSession(id));

    const resolver = makeResolver(projectDir, id);
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).toContain('mcp://splitbrief/sessions');
    expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/manifest.json`);
  });

  it('always includes /tasks URI', async () => {
    const id = 'sess-2';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).toContain(`mcp://splitbrief/sessions/${id}/tasks`);
  });

  it('omits plan.md URI when no plan.md exists', async () => {
    const id = 'sess-3';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/plan.md`);
  });

  it('includes spec.md URI when file exists', async () => {
    const id = 'sess-4';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'spec.md'), '# Spec');

    const resolver = makeResolver(projectDir, id);
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).toContain(`mcp://splitbrief/sessions/${id}/spec.md`);
  });

  it('includes task URIs for tasks found in tasks.md', async () => {
    const id = 'sess-5';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).toContain(`mcp://splitbrief/sessions/${id}/tasks/T001`);
    expect(uris).toContain(`mcp://splitbrief/sessions/${id}/tasks/T002`);
  });

  it('excludes sessions not in sessionIds', async () => {
    const id = 'sess-allowed';
    const otherId = 'sess-other';
    ensureSessionDir(projectDir, id);
    ensureSessionDir(projectDir, otherId);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });
    saveSummary({ projectDir: projectDir, sessionId: otherId }, { ...SESSION_STUB, id: otherId });

    const resolver = createResolver({ projectDir, sessionIds: [id], splitbriefVersion: '1.0.0' });
    const uris = (await resolver.listResources()).map((r) => r.uri);

    expect(uris).not.toContain(`mcp://splitbrief/sessions/${otherId}/manifest.json`);
  });

  itUnix(
    'does not advertise concrete session resources when artifacts are only reachable via symlinked sessions root',
    async () => {
      const projectDir = createTempDir('resolver-symlink-sessions');
      dirs.push(projectDir);
      const outside = createTempDir('resolver-symlink-sessions-outside');
      const id = 'sess-symlink';
      try {
        mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
        writeCanonicalArtifactsAtSessionsRoot(outside, id);
        symlinkSync(outside, join(projectDir, SPLITBRIEF_DIR, SESSIONS_DIR), 'dir');

        const resolver = makeResolver(projectDir, id);
        const uris = (await resolver.listResources()).map((r) => r.uri);

        expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/manifest.json`);
        expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/tasks`);
        expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/summary.json`);
        expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/state.json`);
      } finally {
        cleanupTempDir(outside);
      }
    },
  );
});

describe('readResource - /sessions', () => {
  it('returns valid JSON array of session descriptors', async () => {
    const id = 'sess-a';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource('mcp://splitbrief/sessions');

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('application/json');
    const parsed = JSON.parse(result!.text!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ id, status: 'interrupted' });
  });

  itUnix('does not read sessions through a symlinked .splitbrief directory', async () => {
    const projectDir = createTempDir('resolver-symlink-splitbrief');
    dirs.push(projectDir);
    const outsideSplitbrief = createTempDir('resolver-symlink-splitbrief-outside');
    const id = 'sess-outside';
    try {
      writeCanonicalArtifactsAtSessionsRoot(join(outsideSplitbrief, SESSIONS_DIR), id);
      symlinkSync(outsideSplitbrief, join(projectDir, SPLITBRIEF_DIR), 'dir');

      const resolver = makeResolver(projectDir, id);
      const resources = await resolver.listResources();
      const uris = resources.map((r) => r.uri);
      const result = await resolver.readResource('mcp://splitbrief/sessions');

      expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/manifest.json`);
      expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/tasks`);
      expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/summary.json`);
      expect(uris).not.toContain(`mcp://splitbrief/sessions/${id}/state.json`);
      expect(JSON.parse(result!.text!)).toEqual([]);
    } finally {
      cleanupTempDir(outsideSplitbrief);
    }
  });
});

describe('readResource - /manifest.json', () => {
  it('returns synthesized manifest from canonical summary.json and state.json', async () => {
    const id = 'sess-b';
    ensureSessionDir(projectDir, id);
    writeCanonicalArtifacts(projectDir, id);
    writeFileSync(
      join(sessionPath(projectDir, id), 'tasks.md'),
      TASKS_MD.replaceAll('T002', 'T999'),
    );

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/manifest.json`);

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('application/json');
    const manifest = JSON.parse(result!.text!);
    expect(manifest.target).toBe('live-mcp');
    expect(manifest.sessionId).toBe(id);
    expect(manifest.packVersion).toBe('1');
    expect(manifest.splitbriefVersion).toBe('1.2.3');
    expect(manifest.generatedAt).toBe(new Date(1700000005000).toISOString());
    expect(manifest.mode).toBe('speckit');
    expect(manifest.taskIds).toEqual(['T001', 'T002']);
    expect(manifest.artifacts.tasks).toEqual(['tasks/T001', 'tasks/T002']);
  });

  it('reads every manifest task artifact URI through resources/read', async () => {
    const id = 'sess-manifest-parity';
    ensureSessionDir(projectDir, id);
    writeCanonicalArtifacts(projectDir, id);
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const manifestResult = await resolver.readResource(
      `mcp://splitbrief/sessions/${id}/manifest.json`,
    );
    const manifest = JSON.parse(manifestResult!.text!);
    for (const artifact of manifest.artifacts.tasks as string[]) {
      const read = await resolver.readResource(`mcp://splitbrief/sessions/${id}/${artifact}`);
      expect(read).not.toBeNull();
      expect(read?.mimeType).toBe('text/markdown');
      expect(read?.text?.length).toBeGreaterThan(0);
    }
  });

  it('reads legacy tasks/<id>.md manifest artifact aliases', async () => {
    const id = 'sess-manifest-alias';
    ensureSessionDir(projectDir, id);
    writeCanonicalArtifacts(projectDir, id);
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const read = await resolver.readResource(`mcp://splitbrief/sessions/${id}/tasks/T001.md`);
    expect(read).not.toBeNull();
    expect(read?.text).toContain('id: T001');
  });

  it('returns null when summary.json is missing', async () => {
    const id = 'sess-missing-summary';
    ensureSessionDir(projectDir, id);
    saveState(
      { projectDir, sessionId: id },
      {
        ...createInitialState('test feature'),
        stateVersion: CURRENT_STATE_VERSION,
        tasks: [taskOne],
      },
    );

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/manifest.json`);

    expect(result).toBeNull();
  });

  it('returns null when state.json is missing', async () => {
    const id = 'sess-missing-state';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, makeCompleteSession(id));

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/manifest.json`);

    expect(result).toBeNull();
  });

  it('computes briefHash from live state tasks', async () => {
    const id = 'sess-c';
    ensureSessionDir(projectDir, id);
    writeCanonicalArtifacts(projectDir, id);

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/manifest.json`);
    const manifest = JSON.parse(result!.text!);

    expect(manifest.briefHash).toBe(hashTaskBrief([taskOne, taskTwo]));
  });
});

describe('readResource - file resources', () => {
  it('returns text/markdown and file text for spec.md', async () => {
    const id = 'sess-e';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'spec.md'), '# My Spec\nHello');

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/spec.md`);

    expect(result?.mimeType).toBe('text/markdown');
    expect(result?.text).toBe('# My Spec\nHello');
  });

  it('returns concrete summary.json and state.json when present', async () => {
    const id = 'sess-concrete';
    ensureSessionDir(projectDir, id);
    writeCanonicalArtifacts(projectDir, id);

    const resolver = makeResolver(projectDir, id);
    const summary = await resolver.readResource(`mcp://splitbrief/sessions/${id}/summary.json`);
    const state = await resolver.readResource(`mcp://splitbrief/sessions/${id}/state.json`);

    expect(summary?.mimeType).toBe('application/json');
    expect(JSON.parse(summary!.text!).id).toBe(id);
    expect(state?.mimeType).toBe('application/json');
    expect(JSON.parse(state!.text!).tasks.map((task: { id: string }) => task.id)).toEqual([
      'T001',
      'T002',
    ]);
  });

  it('serves transcript-protected state.json when transcript persistence is disabled', async () => {
    const id = 'sess-protected-state';
    ensureSessionDir(projectDir, id);
    saveState(
      { projectDir, sessionId: id },
      {
        ...createInitialState('secret feature text'),
        stateVersion: CURRENT_STATE_VERSION,
        tasks: [
          makeTask({
            id: 'T001',
            title: 'secret task title',
            file: 'src/secret.ts',
            description: 'secret task prose',
            tests: ['secret acceptance'],
            constraints: ['secret constraint'],
            typeDefs: 'type Secret = string',
            implementationSteps: ['use the secret'],
          }),
        ],
        messageQueue: [
          {
            id: 'm1',
            text: 'queued secret text',
            queuedAt: '2026-06-30T00:00:00.000Z',
            phase: 'planning',
            deliveredViaNative: false,
            nativeDeliveryState: 'pending',
            question: 'secret clarification question',
          },
        ],
      },
    );

    const resolver = makeResolver(projectDir, id, false);
    const sessions = await resolver.readResource('mcp://splitbrief/sessions');
    const state = await resolver.readResource(`mcp://splitbrief/sessions/${id}/state.json`);

    expect(sessions).not.toBeNull();
    expect(JSON.parse(sessions!.text!)[0].title).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(state).not.toBeNull();
    expect(state!.text).not.toContain('queued secret text');
    expect(state!.text).not.toContain('secret clarification question');
    expect(state!.text).not.toContain('secret feature text');
    expect(state!.text).not.toContain('secret task prose');
    const parsed = JSON.parse(state!.text!);
    expect(parsed.feature).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(parsed.messageQueue[0]).toMatchObject({
      text: TRANSCRIPT_OMITTED_MESSAGE,
      question: TRANSCRIPT_OMITTED_MESSAGE,
    });
    expect(parsed.tasks[0]).toMatchObject({
      id: 'T001',
      title: TRANSCRIPT_OMITTED_MESSAGE,
      file: TRANSCRIPT_OMITTED_MESSAGE,
      status: 'pending',
    });
  });

  it('keeps opaque sessions transcript-protected when current config allows transcripts', async () => {
    const id = '2026-04-18-session-abcdef123456';
    ensureSessionDir(projectDir, id);
    saveState(
      { projectDir, sessionId: id },
      {
        ...createInitialState('secret oauth login'),
        stateVersion: CURRENT_STATE_VERSION,
        tasks: [
          makeTask({
            id: 'T001',
            title: 'secret task title',
            description: 'secret task prose',
          }),
        ],
      },
    );

    const resolver = makeResolver(projectDir, id, true);
    const sessions = await resolver.readResource('mcp://splitbrief/sessions');
    const state = await resolver.readResource(`mcp://splitbrief/sessions/${id}/state.json`);

    expect(sessions).not.toBeNull();
    expect(JSON.parse(sessions!.text!)[0].title).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(state).not.toBeNull();
    expect(state!.text).toContain(TRANSCRIPT_OMITTED_MESSAGE);
    expect(state!.text).not.toContain('secret oauth login');
    expect(state!.text).not.toContain('secret task title');
    expect(state!.text).not.toContain('secret task prose');
  });

  it('returns null for file resources with no backing file', async () => {
    const id = 'sess-missing-concrete';
    ensureSessionDir(projectDir, id);

    const resolver = makeResolver(projectDir, id);

    expect(await resolver.readResource(`mcp://splitbrief/sessions/${id}/evidence.json`)).toBeNull();
    expect(await resolver.readResource(`mcp://splitbrief/sessions/${id}/summary.json`)).toBeNull();
    expect(await resolver.readResource(`mcp://splitbrief/sessions/${id}/state.json`)).toBeNull();
  });
});

describe('readResource - tasks', () => {
  it('returns markdown for a known task ID', async () => {
    const id = 'sess-g';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/tasks/T001`);

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('text/markdown');
    expect(result?.text).toContain('T001');
  });

  it('returns null for a task ID not found', async () => {
    const id = 'sess-h';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/tasks/T999`);

    expect(result).toBeNull();
  });
});

describe('readResource - edge cases', () => {
  it('returns null for an unknown URI', async () => {
    const id = 'sess-i';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource('mcp://splitbrief/unknown/path');

    expect(result).toBeNull();
  });

  it('returns null when the session directory does not exist', async () => {
    const id = 'sess-j';

    const resolver = createResolver({ projectDir, sessionIds: [id], splitbriefVersion: '1.0.0' });
    const uri = `mcp://splitbrief/sessions/${id}/spec.md`;

    await expect(resolver.readResource(uri)).resolves.toBeNull();
  });

  it('returns null for a session not in sessionIds', async () => {
    const id = 'sess-allowed';
    const otherId = 'sess-other';
    ensureSessionDir(projectDir, otherId);

    const resolver = createResolver({ projectDir, sessionIds: [id], splitbriefVersion: '1.0.0' });
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${otherId}/spec.md`);

    expect(result).toBeNull();
  });

  it('returns empty array for /tasks when tasks.md does not exist', async () => {
    const id = 'sess-k';
    ensureSessionDir(projectDir, id);
    saveSummary({ projectDir: projectDir, sessionId: id }, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = await resolver.readResource(`mcp://splitbrief/sessions/${id}/tasks`);

    expect(result).not.toBeNull();
    expect(JSON.parse(result!.text!)).toEqual([]);
  });
});
