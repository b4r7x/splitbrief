import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { runPreHooks } from './run-pre.js';
import type { HookCommandEntry, HookModuleEntry, HooksConfig } from '../../core/schemas/hooks.js';
import type { EngineEvent } from '../events/types.js';
import { taskId } from '../../core/schemas/task.js';
import { markHooksConfigTrusted } from '../../core/hooks/trust.js';
import { makeCommandHookEntry, makeAllowHook } from '#testing/helpers/factories/hook-entry.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';

let projectDir: string;
let trustHome: ReturnType<typeof useTrustHome>;

beforeEach(() => {
  trustHome = useTrustHome('splitbrief-run-pre-hooks-home');
  projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-run-pre-hooks-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  trustHome.restore();
});

function ctx() {
  return { projectDir, sessionId: 'sess-1' };
}

function trust(hooks: HooksConfig): HooksConfig {
  markHooksConfigTrusted(projectDir, hooks);
  return hooks;
}

function writeModuleHook(source: string, overrides?: Partial<HookModuleEntry>): HookModuleEntry {
  mkdirSync(join(projectDir, 'hooks'), { recursive: true });
  const path = `hooks/${overrides?.name ?? 'hook'}.mjs`;
  writeFileSync(join(projectDir, path), source);
  return {
    kind: 'module',
    path,
    timeout_ms: 5000,
    on_failure: 'warn',
    ...overrides,
  };
}

function sampleModuleHook(): HookModuleEntry {
  return writeModuleHook(`
export default async function hook(event) {
  if (event.type === 'task_started' && event.title?.includes('forbidden')) {
    return { kind: 'deny', message: 'forbidden by sample-module' };
  }
  return { kind: 'allow' };
}
`);
}

function throwingModuleHook(overrides?: Partial<HookModuleEntry>): HookModuleEntry {
  return writeModuleHook(
    "export default async function hook() { throw new Error('segfault'); }\n",
    overrides,
  );
}

const preTaskEvent: EngineEvent = {
  type: 'task_started',
  ts: 1,
  phase: 'implementing',
  taskId: taskId('T001'),
  title: 'my task',
  index: 0,
  total: 1,
  file: 'src/foo.ts',
  action: 'create',
};

function denyViaStdout(message?: string): HookCommandEntry {
  const payload = message === undefined ? { decision: 'deny' } : { decision: 'deny', message };
  return makeCommandHookEntry({
    command: 'node',
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))})`],
    on_failure: 'block',
  });
}

function appendMarkerHook(marker: string, letter: string, deny = false): HookCommandEntry {
  const stdout = deny
    ? 'process.stdout.write(JSON.stringify({decision:"deny",message:"blocked after marker"}));'
    : 'process.stdout.write(JSON.stringify({decision:"allow"}));';
  return makeCommandHookEntry({
    command: 'node',
    args: [
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(letter)}); ${stdout}`,
    ],
    on_failure: 'block',
  });
}

describe('runPreHooks', () => {
  it('returns allow when hooks config is undefined', async () => {
    const result = await runPreHooks(undefined, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(true);
  });

  it('returns allow when no entries for the event', async () => {
    const hooks: HooksConfig = {};
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(true);
  });

  it('returns allow when a single allow hook passes', async () => {
    const hooks = trust({ pre_task: [makeAllowHook()] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(true);
  });

  it('returns not-allow with reason when deny+block', async () => {
    const hooks = trust({ pre_task: [denyViaStdout('access denied')] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('access denied');
  });

  it('returns not-allow when a module pre-hook returns deny', async () => {
    const hooks = trust({ pre_task: [sampleModuleHook()] });
    const result = await runPreHooks(
      hooks,
      'pre_task',
      { ...preTaskEvent, title: 'forbidden task' },
      ctx(),
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('forbidden by sample-module');
  });

  it('uses default reason message when deny has no message', async () => {
    const hooks = trust({ pre_task: [denyViaStdout()] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('pre_task hook denied');
  });

  it('honors deny outcome regardless of on_failure=warn', async () => {
    const entry = denyViaStdout('just a warn');
    entry.on_failure = 'warn';
    const hooks = trust({ pre_task: [entry] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('just a warn');
  });

  it('honors deny outcome regardless of on_failure=ignore', async () => {
    const entry = denyViaStdout('ignored');
    entry.on_failure = 'ignore';
    const hooks = trust({ pre_task: [entry] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('ignored');
  });

  it('returns not-allow when crash+block', async () => {
    const hooks = trust({ pre_task: [throwingModuleHook({ on_failure: 'block' })] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('segfault');
  });

  it('returns allow when crash+warn (not block)', async () => {
    const hooks = trust({ pre_task: [throwingModuleHook({ on_failure: 'warn' })] });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(true);
  });

  it('short-circuits after first deny+block — skips remaining hooks', async () => {
    const marker = join(projectDir, 'hook-seq.txt');
    const hooks = trust({
      pre_task: [appendMarkerHook(marker, 'A', true), appendMarkerHook(marker, 'B')],
    });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('A');
  });

  it('runs multiple hooks sequentially and allows if all pass', async () => {
    const marker = join(projectDir, 'hook-seq.txt');
    const hooks = trust({
      pre_task: [appendMarkerHook(marker, 'A'), appendMarkerHook(marker, 'B')],
    });
    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());
    expect(result.allow).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('AB');
  });

  it('refuses a trusted command hook script after its bytes change', async () => {
    mkdirSync(join(projectDir, 'hooks'), { recursive: true });
    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'process.stdout.write(JSON.stringify({ decision: "allow" }));\n',
    );
    const hooks = trust({
      pre_task: [makeCommandHookEntry({ command: 'node', args: ['hooks/check.mjs'] })],
    });
    writeFileSync(
      join(projectDir, 'hooks', 'check.mjs'),
      'process.stdout.write(JSON.stringify({ decision: "deny", message: "changed" }));\n',
    );

    const result = await runPreHooks(hooks, 'pre_task', preTaskEvent, ctx());

    expect(result.allow).toBe(false);
    expect(result.reason).toContain('changed after trust');
  });

  it('surfaces a builtin warn message as a warning instead of failing open', async () => {
    const hooks = trust({ builtin: { 'block-secrets': true } });
    const commitEvent: EngineEvent = {
      type: 'git_commit',
      ts: 1,
      phase: 'implementing',
      taskId: taskId('T001'),
      message: 'feat: x',
      file: 'does-not-exist-anywhere.ts',
    };
    const result = await runPreHooks(hooks, 'pre_commit', commitEvent, ctx());
    expect(result.allow).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings?.some((w) => w.includes('could not scan'))).toBe(true);
  });

  it('does not run user hooks after builtin block-secrets denies a commit', async () => {
    const marker = join(projectDir, 'user-hook-ran');
    const secretFile = join(projectDir, 'leak.ts');
    writeFileSync(secretFile, 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    const hooks = trust({
      builtin: { 'block-secrets': true },
      pre_commit: [
        makeCommandHookEntry({
          command: 'node',
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        }),
      ],
    });
    const commitEvent: EngineEvent = {
      type: 'git_commit',
      ts: 1,
      phase: 'implementing',
      taskId: taskId('T001'),
      message: 'feat: add infra',
      file: 'leak.ts',
    };

    const result = await runPreHooks(hooks, 'pre_commit', commitEvent, ctx());

    expect(result.allow).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
