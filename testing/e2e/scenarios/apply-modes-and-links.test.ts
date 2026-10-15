import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { sessionDir } from '../../../src/core/paths.js';
import { type WorkflowState, WorkflowStateSchema } from '../../../src/core/schemas/workflow.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cli } from '../helpers/stop-continue-fixture.js';

let tmpDir: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (tmpDir !== undefined) cleanupTempDir(tmpDir);
  tmpDir = undefined;
});

type Target = { projectDir: string; stateHome: string };

function readState(target: Target, sessionId: string): WorkflowState {
  return WorkflowStateSchema.parse(
    JSON.parse(readFileSync(join(sessionDir(target.projectDir, sessionId), 'state.json'), 'utf8')),
  );
}

/**
 * A worktree run on a clean checkout that makes the script executable, adds a
 * link, retargets a committed link and edits a note. The checkout keeps a
 * secret at 0o600, a mode Git does not record. It returns the checkout and the
 * run workspace as they stand when the run is ready.
 */
async function readyRun(name: string): Promise<{
  target: Target;
  sessionId: string;
  before: Record<string, string>;
  result: Record<string, string>;
}> {
  tmpDir = createTempDir(name);
  const projectDir = join(tmpDir, 'project');
  const stateHome = join(tmpDir, 'state');
  const plan = makePlanProposal({
    summary: 'Update the script permissions and project links',
    tasks: [
      makeTaskSpec({
        title: 'Update the script permissions and project links',
        intent:
          'Make the script executable, link the readme from docs, retarget the link and update the note.',
        suggestedFiles: ['script.sh', 'note.txt'],
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
      }),
    ],
  });
  const review = passingVerdict({
    kind: 'final',
    taskIds: plan.tasks.map((task) => task.id),
    criterionIds: plan.criteria.map((criterion) => criterion.id),
  });
  createTestGitRepo(projectDir, {
    'README.md': '# Project\n',
    'script.sh': 'echo hello\n',
    'note.txt': 'before\n',
    'secret.txt': 'token\n',
    link: { symlink: 'note.txt' },
    'tools/planner.mjs': `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
process.stdout.write(JSON.stringify(prompt.includes('# Final Implementation Review')
  ? ${JSON.stringify(review)} : ${JSON.stringify({ result: plan })}));
`,
    'tools/implementer.mjs': `
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
chmodSync('script.sh', 0o755);
mkdirSync('docs');
symlinkSync('../README.md', 'docs/readme.md');
rmSync('link');
symlinkSync('script.sh', 'link');
writeFileSync('note.txt', 'after\\n');
`,
  });
  chmodSync(join(projectDir, 'script.sh'), 0o644);
  chmodSync(join(projectDir, 'secret.txt'), 0o600);
  mkdirSync(join(projectDir, '.splitbrief'));
  mkdirSync(stateHome);
  const config = makeConfig({
    planner: {
      kind: 'shell',
      command: 'node',
      args: ['./tools/planner.mjs'],
      outputFormat: 'text',
    },
    implementer: {
      kind: 'agent',
      command: 'node',
      args: ['./tools/implementer.mjs'],
      outputFormat: 'text',
      model: 'fixture',
      contextLength: 200_000,
    },
    workflow: { approve: 'none', isolation: 'worktree' },
    validation: { endChecks: false },
  });
  writeFileSync(join(projectDir, '.splitbrief', 'config.yaml'), YAML.stringify(config));
  const before = checkoutEntries(projectDir);
  expect(before['secret.txt']).toBe(`384:${Buffer.from('token\n').toString('base64')}`);
  const target = { projectDir, stateHome };

  const run = await cli(target, ['start', 'Update the script permissions and project links'], {
    timeoutMs: 90_000,
  });
  expect(run.exitCode, run.stderr).toBe(0);
  const sessionId = readActive(projectDir);
  if (sessionId === null) throw new Error('the run has no active session');
  const state = readState(target, sessionId);
  expect(deriveRunStatus({ state, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
  expect(state.workspace?.kind).toBe('worktree');
  if (state.workspace === undefined) throw new Error('the run has no workspace');
  const result = checkoutEntries(state.workspace.path);
  expect(result['script.sh']).toBe(`493:${Buffer.from('echo hello\n').toString('base64')}`);
  expect(result['docs/readme.md']).toBe('link:../README.md');
  expect(result.link).toBe('link:script.sh');
  expect(result['note.txt']).toBe(`420:${Buffer.from('after\n').toString('base64')}`);
  expect(checkoutEntries(projectDir)).toEqual(before);
  return { target, sessionId, before, result };
}

describe('e2e: Apply of a mode change and symlinks', () => {
  it('lands a chmod, a new link and a retargeted link on a clean checkout', async () => {
    const { target, sessionId, before, result } = await readyRun('apply-modes-and-links');

    const applied = await cli(target, ['continue', sessionId, '--action', 'apply']);

    expect(applied.exitCode, applied.stderr).toBe(0);
    const entries = checkoutEntries(target.projectDir);
    for (const path of ['script.sh', 'docs/readme.md', 'link', 'note.txt', 'README.md']) {
      expect(entries[path], path).toBe(result[path]);
    }
    expect(entries['secret.txt']).toBe(before['secret.txt']);
    expect(readState(target, sessionId).closed?.as).toBe('applied');
  }, 180_000);

  it('restores the checkout after an Apply that failed once it wrote the links', async () => {
    const { target, sessionId, before } = await readyRun('apply-modes-and-links-restore');
    if (tmpDir === undefined) throw new Error('the run has no temporary directory');
    const preload = join(tmpDir, 'promotion-sync.mjs');
    writeFileSync(
      preload,
      `import fs from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
globalThis.fetch = async () => { throw new Error('Network disabled in Apply E2E'); };
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  const path = String(args[0]);
  if (dirname(path) === ${JSON.stringify(realpathSync(target.projectDir))} &&
      basename(path).startsWith('.note.txt.tmp.')) {
    handle.sync = async () => { throw new Error('simulated promotion fsync failure'); };
  }
  return handle;
};
syncBuiltinESMExports();
`,
    );
    vi.stubEnv(
      'NODE_OPTIONS',
      `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`,
    );

    const failed = await cli(target, ['continue', sessionId, '--action', 'apply']);

    expect(failed.exitCode, failed.stderr).toBe(1);
    const partial = readState(target, sessionId);
    expect(partial.pendingRecovery?.reason).toBe('apply-partial');
    const written = checkoutEntries(target.projectDir);
    expect(written['docs/readme.md']).toBe('link:../README.md');
    expect(written.link).toBe('link:script.sh');
    expect(written['note.txt']).toBe(before['note.txt']);

    vi.unstubAllEnvs();
    rmSync(preload);
    const restored = await cli(target, ['continue', sessionId, '--action', 'restore']);

    expect(restored.exitCode, restored.stderr).toBe(0);
    expect(`${restored.stdout}\n${restored.stderr}`).not.toContain('left as you changed them');
    expect(checkoutEntries(target.projectDir)).toEqual(before);
    const ready = readState(target, sessionId);
    expect(ready.applying).toBeUndefined();
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
  }, 180_000);

  it('reports a link and a mode that both sides changed differently, writing nothing', async () => {
    const { target, sessionId, before } = await readyRun('apply-modes-and-links-conflict');
    rmSync(join(target.projectDir, 'link'));
    symlinkSync('README.md', join(target.projectDir, 'link'));
    chmodSync(join(target.projectDir, 'script.sh'), 0o600);
    const checkout = checkoutEntries(target.projectDir);
    expect(checkout).not.toEqual(before);

    const applied = await cli(target, ['continue', sessionId, '--action', 'apply']);

    expect(applied.exitCode, applied.stderr).toBe(1);
    const recovery = readState(target, sessionId).pendingRecovery;
    expect(recovery?.reason).toBe('apply-conflict');
    expect(recovery?.files).toEqual(['link', 'script.sh']);
    expect(recovery?.details).toContain('link · both sides changed this symlink differently');
    expect(recovery?.details).toContain('script.sh · file mode differs between the sides');
    expect(checkoutEntries(target.projectDir)).toEqual(checkout);
  }, 180_000);
});
