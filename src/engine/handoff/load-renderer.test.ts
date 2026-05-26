import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRenderer, listCustomRenderers } from './load-renderer.js';
import { renderHandoffWithCustom } from './render.js';
import type { HandoffInput } from './types.js';
import { makeTask } from '../../../testing/helpers/factories/task.js';

let tmp: string;

const baseInput: Omit<HandoffInput, 'target'> & { target: string } = {
  target: 'spec-kit',
  sessionId: 'sess-test',
  feature: 'Test Feature',
  mode: 'standard',
  tasks: [
    makeTask({
      id: 'T001',
      title: 'Test task',
      action: 'create',
      file: 'src/test.ts',
      dependsOn: [],
      description: 'A test task',
      tests: [],
      constraints: [],
      implementationSteps: [],
      typeDefs: '',
      status: 'pending',
    }),
  ],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'load-renderer-test-'));
  // Make the temp dir an ESM package so .js fixtures are treated as ESM modules
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadRenderer', () => {
  it('returns ok:true and a function for a valid renderer file', async () => {
    const rendererPath = join(tmp, 'my-renderer.js');
    writeFileSync(
      rendererPath,
      `export default async function render(input) {
        return { files: [{ path: 'out.md', content: 'hello' }] };
      }`,
    );

    const result = await loadRenderer(rendererPath, tmp);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.fn).toBe('function');
    }
  });

  it('returns ok:false with ENOENT-like reason for non-existent path', async () => {
    const result = await loadRenderer(join(tmp, 'does-not-exist.js'), tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toMatch(/not found|enoent|cannot find module|no such file/i);
    }
  });

  it('returns ok:false when default export is not a function', async () => {
    const rendererPath = join(tmp, 'bad-export.js');
    writeFileSync(rendererPath, `export default 42;`);

    const result = await loadRenderer(rendererPath, tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not a function');
    }
  });

  it('resolves relative paths against projectDir', async () => {
    const rendererPath = join(tmp, 'relative-renderer.js');
    writeFileSync(
      rendererPath,
      `export default async function render(input) {
        return { files: [] };
      }`,
    );

    const result = await loadRenderer('relative-renderer.js', tmp);
    expect(result.ok).toBe(true);
  });
});

describe('listCustomRenderers', () => {
  it('returns basenames for .ts and .js files in renderers folder', () => {
    const renderersDir = join(tmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(join(renderersDir, 'linear-ticket.ts'), '');
    writeFileSync(join(renderersDir, 'jira-task.js'), '');
    writeFileSync(join(renderersDir, 'README.md'), '');

    const names = listCustomRenderers(tmp);
    expect(names).toContain('linear-ticket');
    expect(names).toContain('jira-task');
    expect(names).not.toContain('README');
  });

  it('returns [] when renderers folder does not exist', () => {
    const names = listCustomRenderers(tmp);
    expect(names).toEqual([]);
  });
});

describe('renderHandoffWithCustom', () => {
  it('delegates to sync renderHandoff for built-in targets without loading a file', async () => {
    const pack = await renderHandoffWithCustom({ ...baseInput, target: 'spec-kit' }, tmp);
    expect(pack.files.length).toBeGreaterThan(0);
    expect(pack.files.some(f => f.path.startsWith('tasks/'))).toBe(true);
  });

  it('loads and calls a custom renderer for an unknown target when trusted', async () => {
    const renderersDir = join(tmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'my-custom.js'),
      `export default async function render(input) {
        return { files: [{ path: 'custom.md', content: 'from custom renderer' }] };
      }`,
    );

    const pack = await renderHandoffWithCustom({ ...baseInput, target: 'my-custom' }, tmp, { trustCustomRenderers: true });
    expect(pack.files).toHaveLength(1);
    expect(pack.files[0]?.path).toBe('custom.md');
    expect(pack.files[0]?.content).toBe('from custom renderer');
  });

  it('blocks custom renderer when not trusted', async () => {
    const renderersDir = join(tmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'my-custom.js'),
      `export default async function render(input) {
        return { files: [{ path: 'custom.md', content: 'from custom renderer' }] };
      }`,
    );

    await expect(
      renderHandoffWithCustom({ ...baseInput, target: 'my-custom' }, tmp),
    ).rejects.toThrow(/blocked.*trust\.customRenderers/);
  });

  it('throws with "unknown target" message when no built-in or custom renderer found', async () => {
    await expect(
      renderHandoffWithCustom({ ...baseInput, target: 'no-such-renderer' }, tmp, { trustCustomRenderers: true }),
    ).rejects.toThrow('unknown target: no-such-renderer. No built-in or custom renderer found.');
  });
});
