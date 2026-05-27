import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { writeHandoffPack } from './write.js';
import { hashTaskBrief } from '../brief-hash.js';
import { DIPTYCH_DIR, STATE_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';

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

    const outDir = join(tmp, DIPTYCH_DIR, 'handoffs', 'spec-kit');
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

    const outDir = join(tmp, DIPTYCH_DIR, 'handoffs', 'stale-overwrite');

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

describe('writeHandoffPack — overwrite confinement', () => {
  it('rejects overwrite of src directory', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'src');
    mkdirSync(outDir, { recursive: true });

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'overwrite',
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('rejects overwrite of .git directory', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, '.git');
    mkdirSync(outDir, { recursive: true });

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'overwrite',
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('rejects overwrite of parent directory via ..', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, '..');
    mkdirSync(outDir, { recursive: true });

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'overwrite',
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('allows overwrite inside .diptych/', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, DIPTYCH_DIR, 'handoffs', 'test-target');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'old-file.md'), 'stale');

    const result = await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'overwrite',
    });

    expect(existsSync(join(outDir, 'old-file.md'))).toBe(false);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('rejects overwrite when manifest.json is not from diptych (e.g. Chrome extension)', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'chrome-ext');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'My Extension' }));

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'overwrite',
      }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it('allows overwrite when directory contains manifest.json from previous handoff', async () => {
    const sessionId = 'test-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'custom-handoff-dir');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ diptychVersion: '0.1.0' }));

    const result = await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'overwrite',
    });

    expect(result.files.length).toBeGreaterThan(0);
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
        allowCustomRenderer: true,
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
        allowCustomRenderer: true,
      }),
    ).rejects.toThrow(/unsafe path/);
  });

  it('rejects path-like custom renderer targets before loading a renderer', async () => {
    const sessionId = 'unsafe-target-session';
    writeSessionState(tmp, sessionId);

    await expect(
      writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: '../malicious',
        outDir: join(tmp, 'handoff', 'unsafe-target'),
        mode: 'default',
      }),
    ).rejects.toThrow(/invalid handoff target/);
  });
});

describe('writeHandoffPack — readback correctness', () => {
  it('produces task files with real briefHash matching manifest, correct taskId, and non-empty sections', async () => {
    const sessionId = 'readback-session';
    writeSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'readback');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    const expectedHash = hashTaskBrief([t1, t2, t3]);

    // Manifest briefHash is a 64-char hex string matching the expected hash
    expect(manifest.briefHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.briefHash).toBe(expectedHash);

    // Read back each task file and verify content
    for (const tid of ['T001', 'T002', 'T003']) {
      const content = readFileSync(join(outDir, 'tasks', `${tid}.md`), 'utf-8');

      // No <placeholder> anywhere in the file
      expect(content).not.toContain('<placeholder>');

      // Frontmatter briefHash matches manifest
      const hashMatch = content.match(/^briefHash:\s*(.+)$/m);
      expect(hashMatch).not.toBeNull();
      expect(hashMatch![1]!.trim()).toBe(manifest.briefHash);

      // Frontmatter taskId matches expected
      const taskIdMatch = content.match(/^taskId:\s*(.+)$/m);
      expect(taskIdMatch).not.toBeNull();
      expect(taskIdMatch![1]!.trim()).toBe(tid);
      expect(manifest.taskIds).toContain(tid);

      // Structural markers exist
      expect(content).toContain(`# ${tid} —`);
      expect(content).toContain('## Intent');
      expect(content).toContain('## Implementation Steps');

      // Intent section has actual content
      const intentMatch = content.match(/## Intent\n+(.+)/);
      expect(intentMatch).not.toBeNull();
      expect(intentMatch![1]!.trim().length).toBeGreaterThan(0);

      // Implementation Steps section has actual content
      const stepsMatch = content.match(/## Implementation Steps\n+(.+)/);
      expect(stepsMatch).not.toBeNull();
      expect(stepsMatch![1]!.trim().length).toBeGreaterThan(0);
    }
  });
});
