import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderHandoff, renderHandoffWithCustom } from './render.js';
import type { HandoffInput } from './types.js';
import { makeTask } from '#testing/helpers/factories/task.js';

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
  tmp = mkdtempSync(join(tmpdir(), 'renderer-trust-test-'));
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('renderer trust gate', () => {
  it('blocks untrusted custom renderer by default', async () => {
    const renderersDir = join(tmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'evil-renderer.js'),
      `export default async function render(input) {
        return { files: [{ path: 'evil.md', content: 'pwned' }] };
      }`,
    );

    await expect(
      renderHandoffWithCustom({ ...baseInput, target: 'evil-renderer' }, tmp),
    ).rejects.toThrow(/blocked.*trust\.customRenderers/);
  });

  it('allows custom renderer when trustCustomRenderers is true', async () => {
    const renderersDir = join(tmp, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'trusted-renderer.js'),
      `export default async function render(input) {
        return { files: [{ path: 'trusted.md', content: 'ok' }] };
      }`,
    );

    const pack = await renderHandoffWithCustom({ ...baseInput, target: 'trusted-renderer' }, tmp, {
      trustCustomRenderers: true,
    });
    expect(pack.files).toHaveLength(1);
    expect(pack.files[0]?.content).toBe('ok');
  });

  it('built-in targets work without trust gate', async () => {
    const pack = await renderHandoffWithCustom({ ...baseInput, target: 'spec-kit' }, tmp);
    expect(pack.files.length).toBeGreaterThan(0);
  });

  it('built-in targets work regardless of trustCustomRenderers setting', async () => {
    const pack = await renderHandoffWithCustom({ ...baseInput, target: 'spec-kit' }, tmp, {
      trustCustomRenderers: false,
    });
    expect(pack.files.length).toBeGreaterThan(0);
  });

  it('all built-in targets bypass the trust gate', () => {
    const builtInTargets = ['spec-kit', 'agents-md', 'claude-code', 'copilot-issue'] as const;
    for (const target of builtInTargets) {
      const pack = renderHandoff({ ...baseInput, target } as HandoffInput);
      expect(pack.files.length).toBeGreaterThan(0);
    }
  });
});
