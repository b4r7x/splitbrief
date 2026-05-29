import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHookModules, mergeDiscoveredHooks, resolveHooksConfig } from './discover.js';
import { runPreHooks } from './run-pre-hook.js';
import type { EngineEvent } from '../events/types.js';
import { makeCommandHookEntry } from '#testing/helpers/factories/hook-entry.js';

let projectDir: string;

const preTaskEvent: EngineEvent = {
  type: 'task_started',
  ts: 1,
  phase: 'implementing',
  taskId: 'T1' as never,
  title: 'my task',
  index: 0,
  total: 1,
  file: 'src/foo.ts',
  action: 'create',
};

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'diptych-hooks-discovery-'));
  await mkdir(hooksDir(), { recursive: true });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function hooksDir(): string {
  return join(projectDir, '.diptych', 'hooks');
}

async function writeHook(
  fileName: string,
  source = 'export default () => ({ kind: "allow" });',
): Promise<void> {
  await writeFile(join(hooksDir(), fileName), source);
}

describe('discoverHookModules', () => {
  it('discovers pre-task.ts as a pre_task module hook', async () => {
    await writeHook('pre-task.ts');

    const hooks = await discoverHookModules(projectDir);

    expect(hooks).toEqual([{ event: 'pre_task', path: join('.diptych', 'hooks', 'pre-task.ts') }]);
  });

  it('discovers multiple hook files', async () => {
    await writeHook('pre-task.ts');
    await writeHook('post-validation.js');

    const events = (await discoverHookModules(projectDir)).map((hook) => hook.event);

    expect(events).toEqual(['post_validation', 'pre_task']);
  });

  it('ignores non-matching filenames and extensions', async () => {
    await writeHook('readme.md');
    await writeHook('utils.ts');
    await writeHook('pre_task.ts');

    const hooks = await discoverHookModules(projectDir);

    expect(hooks).toEqual([]);
  });

  it('returns empty when hooks directory does not exist', async () => {
    const emptyProject = await mkdtemp(join(tmpdir(), 'diptych-no-hooks-'));
    try {
      await expect(discoverHookModules(emptyProject)).resolves.toEqual([]);
    } finally {
      await rm(emptyProject, { recursive: true, force: true });
    }
  });
});

describe('mergeDiscoveredHooks', () => {
  it('appends discovered hooks after explicit hooks for the same event', () => {
    const explicit = makeCommandHookEntry({ name: 'explicit', command: 'true' });
    const discoveredPath = join('.diptych', 'hooks', 'pre-task.ts');

    const hooks = mergeDiscoveredHooks({ pre_task: [explicit] }, [
      { event: 'pre_task', path: discoveredPath },
    ]);

    expect(hooks?.pre_task).toEqual([
      explicit,
      {
        kind: 'module',
        path: discoveredPath,
        timeout_ms: 30_000,
        on_failure: 'warn',
      },
    ]);
  });
});

describe('resolveHooksConfig', () => {
  it('returns executable config for discovered module hooks', async () => {
    await writeFile(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeHook(
      'pre-task.js',
      'export default () => ({ kind: "deny", message: "auto blocked" });',
    );

    const hooks = await resolveHooksConfig(projectDir, undefined);
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, {
      projectDir,
      sessionId: 's',
    });

    expect(result).toEqual({ allow: false, reason: 'auto blocked' });
  });
});
