import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, exec, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { writeHandoffPack } from './write.js';
import { DIPTYCH_DIR, STATE_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
}));

let tmp: string;

const t1 = makeTask({
  id: 'T001',
  title: 'Add auth middleware',
  action: 'create',
  file: 'src/middleware/auth.ts',
  dependsOn: [],
  description: 'Create an authentication middleware that validates JWT tokens.',
  tests: ['returns 401 for missing token', 'returns 403 for expired token'],
  constraints: ['must not introduce new dependencies'],
  implementationSteps: ['Parse Authorization header', 'Validate JWT'],
  typeDefs: 'function authMiddleware(req: Request, res: Response): void',
  status: 'pending',
});

const t2 = makeTask({
  id: 'T002',
  title: 'Add user model',
  action: 'modify',
  file: 'src/models/user.ts',
  dependsOn: ['T001'],
  description: 'Extend the user model with role field.',
  tests: ['role field defaults to user'],
  constraints: ['must not break existing schema'],
  implementationSteps: ['Add role field to schema'],
  typeDefs: "type UserRole = 'user' | 'admin'",
  status: 'pending',
});

const t3 = makeTask({
  id: 'T003',
  title: 'Write integration tests',
  action: 'create',
  file: 'src/middleware/auth.test.ts',
  dependsOn: ['T001', 'T002'],
  description: 'Write integration tests for the auth middleware.',
  tests: ['all three test cases pass'],
  constraints: ['use vitest'],
  implementationSteps: ['Import authMiddleware', 'Mock JWT'],
  typeDefs: '',
  status: 'pending',
});

function writeSessionState(projectDir: string, sessionId: string): void {
  const sessionDir = join(projectDir, DIPTYCH_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const state = {
    ...createInitialState('Authentication System'),
    stateVersion: CURRENT_STATE_VERSION,
    tasks: [t1, t2, t3],
    phase: 'implementing' as const,
  };
  writeFileSync(join(sessionDir, STATE_FILE), JSON.stringify(state));
}

beforeEach(() => {
  tmp = createTempDir('write-handoff-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('writeHandoffPack — basic output', () => {
  it('creates tasks/T001.md and README.md in the output directory', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

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
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
    const result = await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    for (const relPath of result.files) {
      expect(existsSync(join(outDir, relPath))).toBe(true);
    }
  });
});

describe('writeHandoffPack — mode: default', () => {
  it('throws when output directory already exists', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

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
    writeSessionState(tmp, sessionId);

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

    // Existing file must NOT be overwritten
    expect(readFileSync(join(outDir, 'tasks', 'T001.md'), 'utf-8')).toBe(existingContent);
    // Missing files should have been written
    expect(existsSync(join(outDir, 'README.md'))).toBe(true);
    // Returned files list should only include files that were actually written
    expect(result.files).not.toContain('tasks/T001.md');
    expect(result.files).toContain('README.md');
  });

  it('writes a manifest that includes skipped pre-existing task artifacts', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

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

    expect(manifest.artifacts.tasks).toEqual([
      'tasks/T001.md',
      'tasks/T002.md',
      'tasks/T003.md',
    ]);
  });
});

describe('writeHandoffPack — mode: overwrite', () => {
  it('replaces existing files', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'spec-kit');
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
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'stale-overwrite');

    // First pass: write all three tasks
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

    // Second pass: overwrite with only T001
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
    writeSessionState(tmp, sessionId);

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
    writeSessionState(tmp, sessionId);

    const sDir = join(tmp, DIPTYCH_DIR, 'sessions', sessionId);
    const session = {
      id: sessionId,
      feature: 'Authentication System',
      startedAt: Date.now(),
      completedAt: Date.now(),
      stateVersion: CURRENT_STATE_VERSION,
      stateFile: null,
      status: 'complete',
      summary: {
        feature: 'Authentication System',
        totalTasks: 3,
        completedByLocal: 3,
        escalatedToPlanner: 0,
        skipped: 0,
        failed: 0,
        totalTime: 1000,
        tokenUsage: {
          plannerInput: 0,
          plannerOutput: 0,
          implementerInput: 0,
          implementerOutput: 0,
          escalationInput: 0,
          escalationOutput: 0,
        },
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
    writeSessionState(tmp, sessionId);

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

describe('writeHandoffPack — validation metadata', () => {
  it('includes enabled typecheck, lint, and test commands in manifest.json', async () => {
    const sessionId = 'validation-session';
    writeSessionState(tmp, sessionId);
    mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
    writeFileSync(
      join(tmp, DIPTYCH_DIR, 'config.yaml'),
      [
        'version: 3',
        'validation:',
        '  typecheck: true',
        '  lint: true',
        '  test: true',
        '  test_command: npm run test:unit',
      ].join('\n'),
    );

    const outDir = join(tmp, 'handoff', 'validation');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));

    expect(manifest.validation).toEqual({
      typecheck: 'npm run typecheck',
      lint: 'npm run lint',
      test: 'npm run test:unit',
    });
  });
});

describe('writeHandoffPack — inert writer', () => {
  it('does not spawn external commands while rendering artifacts', async () => {
    const sessionId = 'inert-session';
    writeSessionState(tmp, sessionId);

    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir: join(tmp, 'handoff', 'inert'),
      mode: 'default',
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('writeHandoffPack — renderer path confinement', () => {
  function writeCustomRenderer(projectDir: string, maliciousPath: string): void {
    const renderersDir = join(projectDir, '.diptych', 'handoff-renderers');
    mkdirSync(renderersDir, { recursive: true });
    writeFileSync(
      join(renderersDir, 'malicious.js'),
      `export default function render() { return { files: [{ path: ${JSON.stringify(maliciousPath)}, content: 'unsafe' }] }; }`,
    );
  }

  it('rejects custom renderer output paths that escape the output directory', async () => {
    const sessionId = 'unsafe-renderer-session';
    writeSessionState(tmp, sessionId);
    writeCustomRenderer(tmp, '../escape.md');

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'malicious',
        outDir: join(tmp, 'handoff', 'unsafe-renderer'),
        mode: 'default',
      }),
    ).rejects.toThrow(/unsafe path/);
  });

  it('rejects custom renderer Windows absolute output paths on POSIX', async () => {
    const sessionId = 'unsafe-windows-renderer-session';
    writeSessionState(tmp, sessionId);
    writeCustomRenderer(tmp, 'C:\\temp\\escape.md');

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'malicious',
        outDir: join(tmp, 'handoff', 'unsafe-windows-renderer'),
        mode: 'default',
      }),
    ).rejects.toThrow(/unsafe path/);
  });
});
