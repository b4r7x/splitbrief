import { afterEach, expect, it } from 'vitest';
import { entryStoreDir } from '../../../src/engine/orchestrator/isolation/entry-snapshot.js';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { sessionDir } from '../../../src/core/paths.js';
import { createRunIsolation } from '../../../src/engine/orchestrator/isolation/create.js';
import { promoteStagedChanges } from '../../../src/engine/orchestrator/approval/staged-project.js';
import { getChangedFilesSinceSnapshot } from '../../../src/engine/orchestrator/approval/file-snapshots/capture.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'retained-identity-'));
  roots.push(projectDir);
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  const sessionId = 'retained';
  ensureSessionDir(projectDir, sessionId);
  const config = makeNoValidationConfig();
  return {
    projectDir,
    sessionId,
    config,
  };
}
function isolation(ref: { projectDir: string; sessionId: string }) {
  return createRunIsolation({
    ...ref,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
  });
}
async function parked() {
  const f = fixture();
  writeFileSync(join(f.projectDir, 'partial.ts'), 'input');
  const first = isolation(f);
  const workspace = await first.acquire({
    role: 'implementer',
    config: f.config,
  });
  writeFileSync(join(workspace.projectDir, 'partial.ts'), 'silent partial');
  await workspace.retain?.();
  workspace.cleanup();
  await first.dispose();
  return { ...f, workspace };
}

it('reacquires actual bytes and the original approval baseline without overwriting operator edits', async () => {
  const f = await parked();
  writeFileSync(join(f.projectDir, 'partial.ts'), 'operator edit');
  const next = isolation(f);
  const workspace = await next.acquire({
    role: 'implementer',
    config: f.config,
    resume: true,
  });
  expect(workspace.projectDir).toBe(f.workspace.projectDir);
  expect(readFileSync(join(workspace.projectDir, 'partial.ts'), 'utf8')).toBe('silent partial');
  expect(await getChangedFilesSinceSnapshot(workspace.projectDir, workspace.snapshot)).toEqual([
    'partial.ts',
  ]);
  const promotion = await promoteStagedChanges({
    targetProjectDir: f.projectDir,
    stagedProjectDir: workspace.projectDir,
    files: ['partial.ts'],
    targetBaseline: workspace.targetBaseline,
  });
  expect(promotion.conflictedFiles).toEqual(['partial.ts']);
  expect(readFileSync(join(f.projectDir, 'partial.ts'), 'utf8')).toBe('operator edit');
  workspace.cleanup();
  await next.dispose();
  expect(existsSync(join(f.projectDir, '.git/index'))).toBe(false);
});

it.each(['missing', 'recreated', 'root-recreated'] as const)(
  'refuses unavailable workspace after %s changes',
  async (change) => {
    const f = await parked();
    if (change === 'missing') rmSync(f.workspace.projectDir, { recursive: true, force: true });
    if (change === 'recreated') {
      renameSync(f.workspace.projectDir, `${f.workspace.projectDir}-old`);
      mkdirSync(f.workspace.projectDir);
      writeFileSync(join(f.workspace.projectDir, 'partial.ts'), 'replacement directory');
    }
    if (change === 'root-recreated') {
      const root = dirname(f.workspace.projectDir);
      renameSync(root, `${root}-old`);
      mkdirSync(root);
      renameSync(join(`${root}-old`, 'workspace'), f.workspace.projectDir);
    }
    const next = isolation(f);
    await expect(
      next.acquire({ role: 'implementer', config: f.config, resume: true }),
    ).rejects.toThrow('automatic continuation is blocked');
    await next.dispose();
  },
);

it.each(['session', 'project', 'escape'] as const)(
  'rejects a %s ownership record without touching the referenced bytes',
  async (change) => {
    const f = await parked();
    const file = join(sessionDir(f.projectDir, f.sessionId), 'retained-workspace.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (change === 'session') record.sessionId = 'another-session';
    if (change === 'project') record.projectDir = dirname(f.projectDir);
    if (change === 'escape') record.location.leaf = '../../../elsewhere';
    writeFileSync(file, JSON.stringify(record));
    await expect(
      isolation(f).acquire({
        role: 'implementer',
        config: f.config,
        resume: true,
      }),
    ).rejects.toThrow();
    expect(readFileSync(join(f.workspace.projectDir, 'partial.ts'), 'utf8')).toBe('silent partial');
  },
);

it('keeps bytes when persistence fails and reuses the existing run record', async () => {
  const f = fixture();
  const run = isolation(f);
  const workspace = await run.acquire({
    role: 'implementer',
    config: f.config,
  });
  writeFileSync(join(workspace.projectDir, 'partial.ts'), 'valuable unsaved partial');
  const file = join(sessionDir(f.projectDir, f.sessionId), 'retained-workspace.json');
  const activeRecord = readFileSync(file, 'utf8');
  rmSync(file);
  mkdirSync(file);
  await expect(workspace.retain?.()).rejects.toThrow('continuation record could not be saved');
  workspace.cleanup();
  await run.dispose();
  expect(readFileSync(join(workspace.projectDir, 'partial.ts'), 'utf8')).toBe(
    'valuable unsaved partial',
  );
  rmSync(file, { recursive: true });
  writeFileSync(file, activeRecord);
  const next = isolation(f);
  const reused = await next.acquire({ role: 'implementer', config: f.config, resume: true });
  expect(reused.projectDir).toBe(workspace.projectDir);
  await next.dispose();
});

it('recognizes an alias of the owning project without accepting another project', async () => {
  const f = await parked();
  const parent = mkdtempSync(join(tmpdir(), 'retained-alias-'));
  roots.push(parent);
  const alias = join(parent, 'alias');
  symlinkSync(f.projectDir, alias, 'dir');
  const next = isolation({ ...f, projectDir: alias });
  const workspace = await next.acquire({
    role: 'implementer',
    config: f.config,
    resume: true,
  });
  expect(readFileSync(join(workspace.projectDir, 'partial.ts'), 'utf8')).toBe('silent partial');
  await workspace.retain?.();
  await next.dispose();
});

it('keeps staged rollback bytes outside the continuation record', async () => {
  const f = fixture();
  writeFileSync(join(f.projectDir, 'partial.ts'), 'x'.repeat(7 * 1024 * 1024));
  const run = isolation(f);
  const workspace = await run.acquire({
    role: 'implementer',
    config: f.config,
  });
  writeFileSync(
    join(workspace.projectDir, 'partial.ts'),
    'large original replaced by small partial',
  );
  await workspace.retain?.();
  workspace.cleanup();
  await run.dispose();
  expect(readFileSync(join(workspace.projectDir, 'partial.ts'), 'utf8')).toBe(
    'large original replaced by small partial',
  );
  expect(
    readFileSync(join(sessionDir(f.projectDir, f.sessionId), 'retained-workspace.json')).length,
  ).toBeLessThan(16 * 1024);
  const store = entryStoreDir({ projectDir: f.projectDir, sessionId: f.sessionId });
  expect(readdirSync(store).map((blob) => statSync(join(store, blob)).size)).toContain(
    7 * 1024 * 1024,
  );
});

it('rejects oversized metadata without changing the retained bytes', async () => {
  const f = await parked();
  const file = join(sessionDir(f.projectDir, f.sessionId), 'retained-workspace.json');
  writeFileSync(file, readFileSync(file, 'utf8') + ' '.repeat(8 * 1024 * 1024));
  await expect(
    isolation(f).acquire({
      role: 'implementer',
      config: f.config,
      resume: true,
    }),
  ).rejects.toThrow('automatic continuation is blocked');
  expect(readFileSync(join(f.workspace.projectDir, 'partial.ts'), 'utf8')).toBe('silent partial');
});

it('preserves bytes and reports unavailable continuation when metadata exceeds the write bound', async () => {
  const f = fixture();
  const warnings: string[] = [];
  const run = createRunIsolation({
    ...f,
    strategy: 'staged-copy',
    onFallback: () => {},
    onRetained: () => {},
    warningPublisher: (message) => warnings.push(message),
  });
  const workspace = await run.acquire({
    role: 'implementer',
    config: f.config,
  });
  const file = join(sessionDir(f.projectDir, f.sessionId), 'retained-workspace.json');
  const activeRecord = readFileSync(file, 'utf8');
  writeFileSync(
    join(workspace.projectDir, 'partial.ts'),
    'oversized metadata must not delete this',
  );
  const hashes = workspace.snapshot.baselineFileHashes;
  if (hashes === undefined) throw new Error('Staged acquisition must capture baseline hashes');
  // Expand metadata only: the real acquisition, persistence, cleanup and bytes remain unmocked.
  for (let index = 0; index < 110_000; index++) hashes[`file-${index}.ts`] = 'a'.repeat(64);
  await expect(workspace.retain?.()).rejects.toThrow('continuation record could not be saved');
  expect(warnings).toEqual([expect.stringContaining(workspace.projectDir)]);
  expect(readFileSync(file, 'utf8')).toBe(activeRecord);
  workspace.cleanup();
  await run.dispose();
  expect(readFileSync(join(workspace.projectDir, 'partial.ts'), 'utf8')).toBe(
    'oversized metadata must not delete this',
  );
  const next = isolation(f);
  const reused = await next.acquire({ role: 'implementer', config: f.config, resume: true });
  expect(reused.projectDir).toBe(workspace.projectDir);
  await next.dispose();
  expect(readFileSync(join(workspace.projectDir, 'partial.ts'), 'utf8')).toBe(
    'oversized metadata must not delete this',
  );
});

it('keeps run ownership after promotion and cleanup', async () => {
  const f = fixture();
  const run = isolation(f);
  const workspace = await run.acquire({
    role: 'implementer',
    config: f.config,
  });
  writeFileSync(join(workspace.projectDir, 'partial.ts'), 'approved output');
  const applied = await promoteStagedChanges({
    targetProjectDir: f.projectDir,
    stagedProjectDir: workspace.projectDir,
    files: ['partial.ts'],
    targetBaseline: workspace.targetBaseline,
  });
  expect(applied.promotedFiles).toEqual(['partial.ts']);
  await run.dispose();
  const next = isolation(f);
  const resumed = await next.acquire({
    role: 'implementer',
    config: f.config,
    resume: true,
  });
  expect(resumed.projectDir).toBe(workspace.projectDir);
  expect(readFileSync(join(resumed.projectDir, 'partial.ts'), 'utf8')).toBe('approved output');
  resumed.cleanup();
  await next.dispose();
});

it('preserves a retained staged attempt when its rollback bytes are unavailable', async () => {
  const f = await parked();
  rmSync(entryStoreDir({ projectDir: f.projectDir, sessionId: f.sessionId }), {
    recursive: true,
    force: true,
  });
  const next = isolation(f);
  await expect(next.acquire({ role: 'implementer', config: f.config })).rejects.toThrow(
    'automatic continuation is blocked',
  );
  expect(readFileSync(join(f.workspace.projectDir, 'partial.ts'), 'utf8')).toBe('silent partial');
  await next.dispose();
});
