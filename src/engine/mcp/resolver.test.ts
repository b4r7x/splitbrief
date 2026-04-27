import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { saveSummary } from '../../core/sessions/io.js';
import { createResolver } from './resolver.js';

const SESSION_STUB = {
  id: '',
  feature: 'test feature',
  startedAt: 1700000000000,
  completedAt: null,
  stateVersion: 1,
  stateFile: null,
  status: 'interrupted' as const,
  summary: null,
};

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
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function makeProject(): string {
  const projectDir = createTempDir('resolver-test');
  dirs.push(projectDir);
  return projectDir;
}

function makeResolver(projectDir: string, sessionId: string) {
  return createResolver({ projectDir, sessionIds: [sessionId], diptychVersion: '1.2.3' });
}

function sessionPath(projectDir: string, sessionId: string): string {
  return join(projectDir, '.diptych', 'sessions', sessionId);
}

describe('listResources', () => {
  it('always includes /sessions and /manifest.json URIs', () => {
    const projectDir = makeProject();
    const id = 'sess-1';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const uris = resolver.listResources().map(r => r.uri);

    expect(uris).toContain('mcp://diptych/sessions');
    expect(uris).toContain(`mcp://diptych/sessions/${id}/manifest.json`);
  });

  it('always includes /tasks URI', () => {
    const projectDir = makeProject();
    const id = 'sess-2';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const uris = resolver.listResources().map(r => r.uri);

    expect(uris).toContain(`mcp://diptych/sessions/${id}/tasks`);
  });

  it('omits plan.md URI when no plan.md exists', () => {
    const projectDir = makeProject();
    const id = 'sess-3';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const uris = resolver.listResources().map(r => r.uri);

    expect(uris).not.toContain(`mcp://diptych/sessions/${id}/plan.md`);
  });

  it('includes spec.md URI when file exists', () => {
    const projectDir = makeProject();
    const id = 'sess-4';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'spec.md'), '# Spec');

    const resolver = makeResolver(projectDir, id);
    const uris = resolver.listResources().map(r => r.uri);

    expect(uris).toContain(`mcp://diptych/sessions/${id}/spec.md`);
  });

  it('includes task URIs for tasks found in tasks.md', () => {
    const projectDir = makeProject();
    const id = 'sess-5';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const uris = resolver.listResources().map(r => r.uri);

    expect(uris).toContain(`mcp://diptych/sessions/${id}/tasks/T001`);
    expect(uris).toContain(`mcp://diptych/sessions/${id}/tasks/T002`);
  });

  it('excludes sessions not in sessionIds', () => {
    const projectDir = makeProject();
    const id = 'sess-allowed';
    const otherId = 'sess-other';
    ensureSessionDir(projectDir, id);
    ensureSessionDir(projectDir, otherId);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    saveSummary(projectDir, otherId, { ...SESSION_STUB, id: otherId });

    const resolver = createResolver({ projectDir, sessionIds: [id], diptychVersion: '1.0.0' });
    const uris = resolver.listResources().map(r => r.uri);

    expect(uris).not.toContain(`mcp://diptych/sessions/${otherId}/manifest.json`);
  });
});

describe('readResource - /sessions', () => {
  it('returns valid JSON array of session descriptors', () => {
    const projectDir = makeProject();
    const id = 'sess-a';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource('mcp://diptych/sessions');

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('application/json');
    const parsed = JSON.parse(result!.text!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ id, status: 'interrupted' });
  });
});

describe('readResource - /manifest.json', () => {
  it('returns synthesized manifest with target=live-mcp', () => {
    const projectDir = makeProject();
    const id = 'sess-b';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/manifest.json`);

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('application/json');
    const manifest = JSON.parse(result!.text!);
    expect(manifest.target).toBe('live-mcp');
    expect(manifest.sessionId).toBe(id);
    expect(manifest.packVersion).toBe('1');
    expect(manifest.diptychVersion).toBe('1.2.3');
    expect(typeof manifest.generatedAt).toBe('string');
    expect(Array.isArray(manifest.taskIds)).toBe(true);
  });

  it('omits briefHash when brief-hash.json is absent', () => {
    const projectDir = makeProject();
    const id = 'sess-c';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/manifest.json`);
    const manifest = JSON.parse(result!.text!);

    expect('briefHash' in manifest).toBe(false);
  });

  it('includes briefHash when brief-hash.json is present', () => {
    const projectDir = makeProject();
    const id = 'sess-d';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    writeFileSync(
      join(sessionPath(projectDir, id), 'brief-hash.json'),
      JSON.stringify({ hash: 'abc123' }),
    );

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/manifest.json`);
    const manifest = JSON.parse(result!.text!);

    expect(manifest.briefHash).toBe('abc123');
  });
});

describe('readResource - file resources', () => {
  it('returns text/markdown and file text for spec.md', () => {
    const projectDir = makeProject();
    const id = 'sess-e';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'spec.md'), '# My Spec\nHello');

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/spec.md`);

    expect(result?.mimeType).toBe('text/markdown');
    expect(result?.text).toBe('# My Spec\nHello');
  });

  it('returns null for evidence.json when file does not exist', () => {
    const projectDir = makeProject();
    const id = 'sess-f';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/evidence.json`);

    expect(result).toBeNull();
  });
});

describe('readResource - tasks', () => {
  it('returns markdown for a known task ID', () => {
    const projectDir = makeProject();
    const id = 'sess-g';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/tasks/T001`);

    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe('text/markdown');
    expect(result?.text).toContain('T001');
  });

  it('returns null for a task ID not found', () => {
    const projectDir = makeProject();
    const id = 'sess-h';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });
    writeFileSync(join(sessionPath(projectDir, id), 'tasks.md'), TASKS_MD);

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/tasks/T999`);

    expect(result).toBeNull();
  });
});

describe('readResource - edge cases', () => {
  it('returns null for an unknown URI', () => {
    const projectDir = makeProject();
    const id = 'sess-i';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource('mcp://diptych/unknown/path');

    expect(result).toBeNull();
  });

  it('does not throw on disk errors — returns null', () => {
    const projectDir = makeProject();
    const id = 'sess-j';

    const resolver = createResolver({ projectDir, sessionIds: [id], diptychVersion: '1.0.0' });

    expect(() => resolver.readResource(`mcp://diptych/sessions/${id}/spec.md`)).not.toThrow();
    expect(resolver.readResource(`mcp://diptych/sessions/${id}/spec.md`)).toBeNull();
  });

  it('returns null for a session not in sessionIds', () => {
    const projectDir = makeProject();
    const id = 'sess-allowed';
    const otherId = 'sess-other';
    ensureSessionDir(projectDir, otherId);

    const resolver = createResolver({ projectDir, sessionIds: [id], diptychVersion: '1.0.0' });
    const result = resolver.readResource(`mcp://diptych/sessions/${otherId}/spec.md`);

    expect(result).toBeNull();
  });

  it('returns empty array for /tasks when tasks.md does not exist', () => {
    const projectDir = makeProject();
    const id = 'sess-k';
    ensureSessionDir(projectDir, id);
    saveSummary(projectDir, id, { ...SESSION_STUB, id });

    const resolver = makeResolver(projectDir, id);
    const result = resolver.readResource(`mcp://diptych/sessions/${id}/tasks`);

    expect(result).not.toBeNull();
    expect(JSON.parse(result!.text!)).toEqual([]);
  });
});
