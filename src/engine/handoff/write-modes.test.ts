import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeHandoffWriterSessionState } from '#testing/helpers/handoff-writer-fixture.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { writeHandoffPack } from './write.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('write-handoff-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('writeHandoffPack — basic output', () => {
  it('creates tasks/T001.md and README.md in the output directory', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    const result = await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    expect(existsSync(join(outDir, 'tasks', 'T001.md'))).toBe(true);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    expect(result.outputDir).toBe(outDir);
    expect(result.files).toContain('tasks/T001.md');
    expect(result.files).toContain('README.md');
  });

  it('returned files list matches only written paths', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    const result = await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    expect(result.files.length).toBeGreaterThan(0);
    for (const relPath of result.files) {
      expect(existsSync(join(outDir, relPath))).toBe(true);
    }
  });
});

describe('writeHandoffPack — mode: default', () => {
  it('throws when output directory already exists', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    mkdirSync(outDir, { recursive: true });

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'default',
      }),
    ).rejects.toThrow(/output directory already exists/);
  });
});

describe('writeHandoffPack — mode: append', () => {
  it('skips existing files and writes missing ones', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    mkdirSync(join(outDir, 'tasks'), { recursive: true });
    const existingContent = 'existing content';
    writeFileSync(join(outDir, 'tasks', 'T001.md'), existingContent);

    const result = await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'append',
    });

    expect(readFileSync(join(outDir, 'tasks', 'T001.md'), 'utf-8')).toBe(existingContent);
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    expect(result.files).not.toContain('tasks/T001.md');
    expect(result.files).toContain('README.md');
  });

  it('writes a manifest that includes skipped pre-existing task artifacts', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    mkdirSync(join(outDir, 'tasks'), { recursive: true });
    writeFileSync(join(outDir, 'tasks', 'T001.md'), 'existing content');

    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'append',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));

    expect(manifest.artifacts.tasks).toEqual(['tasks/T001.md', 'tasks/T002.md', 'tasks/T003.md']);
  });

  it('refuses to append when the existing manifest describes a different Task Brief', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    mkdirSync(join(outDir, 'tasks'), { recursive: true });
    const staleTask = 'preserved task file from a previous, unrelated export';
    writeFileSync(join(outDir, 'tasks', 'T001.md'), staleTask);
    const staleManifest = {
      packVersion: '1',
      splitbriefVersion: '0.0.0',
      generatedAt: new Date().toISOString(),
      sessionId,
      briefHash: 'a'.repeat(64),
      target: 'spec-kit',
      mode: 'standard',
      taskIds: ['T001'],
      artifacts: { tasks: ['tasks/T001.md'] },
      validation: {},
    };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(staleManifest));

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'append',
      }),
    ).rejects.toThrow(/different Task Brief/);

    // The pack is left untouched — neither the stale manifest nor the kept task file changed.
    expect(readFileSync(join(outDir, 'tasks', 'T001.md'), 'utf-8')).toBe(staleTask);
    const manifestAfter = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifestAfter.briefHash).toBe('a'.repeat(64));
  });

  it('appends when the existing manifest describes the same Task Brief', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');

    // First export establishes a manifest with the current session's briefHash.
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const firstManifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));

    // A second append over the same brief is accepted and the manifest stays coherent.
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'append',
    });

    const secondManifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(secondManifest.briefHash).toBe(firstManifest.briefHash);
    expect(secondManifest.taskIds).toEqual(firstManifest.taskIds);
  });
});

describe('writeHandoffPack — mode: overwrite', () => {
  it('replaces existing files', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, SPLITBRIEF_DIR, 'handoffs', 'spec-kit');
    mkdirSync(join(outDir, 'tasks'), { recursive: true });
    const oldContent = 'old content that should be replaced';
    writeFileSync(join(outDir, 'tasks', 'T001.md'), oldContent);

    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'overwrite',
    });

    const newContent = readFileSync(join(outDir, 'tasks', 'T001.md'), 'utf-8');
    expect(newContent).not.toBe(oldContent);
    expect(newContent).toContain('T001');
  });

  it('removes stale task files when overwriting with a narrower selection', async () => {
    const sessionId = 'stale-test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, SPLITBRIEF_DIR, 'handoffs', 'stale-overwrite');

    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    expect(existsSync(join(outDir, 'tasks', 'T001.md'))).toBe(true);
    expect(existsSync(join(outDir, 'tasks', 'T002.md'))).toBe(true);
    expect(existsSync(join(outDir, 'tasks', 'T003.md'))).toBe(true);

    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'overwrite',
      selectedTaskIds: ['T001'],
    });

    expect(existsSync(join(outDir, 'tasks', 'T001.md'))).toBe(true);
    expect(existsSync(join(outDir, 'tasks', 'T002.md'))).toBe(false);
    expect(existsSync(join(outDir, 'tasks', 'T003.md'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.artifacts.tasks).toEqual(['tasks/T001.md']);
  });
});

describe('writeHandoffPack — selectedTaskIds', () => {
  it('propagates error from renderHandoff for unknown task ids', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'default',
        selectedTaskIds: ['T999'],
      }),
    ).rejects.toThrow('unknown task id: T999');
  });
});

describe('writeHandoffPack — mode resolution', () => {
  it('uses mode from summary.json when present', async () => {
    const sessionId = 'mode-test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const sDir = join(tmp, SPLITBRIEF_DIR, 'sessions', sessionId);
    const session = {
      id: sessionId,
      feature: 'Authentication System',
      startedAt: Date.now(),
      completedAt: Date.now(),
      stateVersion: CURRENT_STATE_VERSION,
      status: 'complete',
      summary: {
        feature: 'Authentication System',
        totalTasks: 3,
        completedByLocal: 3,
        escalatedToPlanner: 0,
        skipped: 0,
        failed: 0,
        totalTime: 1000,
        tokenUsage: makeUsage(),
        estimatedCostSavings: '$0.00',
        escalationRate: 0,
        mode: 'speckit',
      },
    };
    writeFileSync(join(sDir, 'summary.json'), JSON.stringify(session));

    const outDir = join(tmp, 'handoff', 'mode-test');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.mode).toBe('speckit');
  });

  it('falls back to standard when no summary.json and no config', async () => {
    const sessionId = 'mode-fallback-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'mode-fallback');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    expect(manifest.mode).toBe('standard');
  });
});
