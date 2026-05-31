import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { writeHandoffPack } from './write.js';
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
    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, name: 'My Extension' }),
    );

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

  it('rejects custom renderer output paths whose parent resolves through a symlink outside outDir', async () => {
    const sessionId = 'symlink-parent-renderer-session';
    writeSessionState(tmp, sessionId);
    // The renderer emits evil/escape.md. We pre-seed outDir with evil -> outside,
    // so writing the (lexically confined) path would escape via the symlink.
    writeCustomRenderer(tmp, 'evil/escape.md');

    const outDir = join(tmp, DIPTYCH_DIR, 'handoffs', 'symlink-parent');
    mkdirSync(outDir, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'diptych-handoff-outside-'));
    try {
      symlinkSync(outside, join(outDir, 'evil'));

      await expect(
        writeHandoffPack({
          projectDir: tmp,
          sessionId,
          target: 'malicious',
          outDir,
          mode: 'append',
          allowCustomRenderer: true,
        }),
      ).rejects.toThrow(/unsafe path/);
      expect(existsSync(join(outside, 'escape.md'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
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
