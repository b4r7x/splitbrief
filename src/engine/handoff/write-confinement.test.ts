import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { writeHandoffWriterSessionState } from '#testing/helpers/handoff-writer-fixture.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { writeHandoffPack } from './write.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('write-handoff-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('writeHandoffPack — overwrite confinement', () => {
  it('rejects overwrite of src directory', async () => {
    const sessionId = 'test-session';
    writeHandoffWriterSessionState(tmp, sessionId);

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
    writeHandoffWriterSessionState(tmp, sessionId);

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
    writeHandoffWriterSessionState(tmp, sessionId);

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
    writeHandoffWriterSessionState(tmp, sessionId);

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
    writeHandoffWriterSessionState(tmp, sessionId);

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
    writeHandoffWriterSessionState(tmp, sessionId);

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
    writeHandoffWriterSessionState(tmp, sessionId);
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
    writeHandoffWriterSessionState(tmp, sessionId);
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
    writeHandoffWriterSessionState(tmp, sessionId);
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
    writeHandoffWriterSessionState(tmp, sessionId);

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
