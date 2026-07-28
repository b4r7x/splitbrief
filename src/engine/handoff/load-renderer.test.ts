import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRenderer, listCustomRenderers } from './load-renderer.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'load-renderer-test-'));
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
      expect(result.reason.toLowerCase()).toMatch(
        /not found|enoent|cannot find module|no such file/i,
      );
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
    const renderersDir = join(tmp, '.splitbrief', 'handoff-renderers');
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
