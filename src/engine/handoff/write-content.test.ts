import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import {
  handoffWriterTasks,
  writeHandoffWriterSessionState,
} from '#testing/helpers/handoff-writer-fixture.js';
import { writeHandoffPack } from './write.js';
import { hashTaskBrief } from '../brief-hash.js';

let tmp: string;
const itUnix = process.platform === 'win32' ? it.skip : it;

beforeEach(() => {
  tmp = createTempDir('write-handoff-test');
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('writeHandoffPack — validation metadata', () => {
  function writeValidationConfig(): void {
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
  }

  it('omits npm typecheck/lint commands for a non-TS project, keeping the configured test command', async () => {
    const sessionId = 'validation-session';
    writeHandoffWriterSessionState(tmp, sessionId);
    writeValidationConfig();

    const outDir = join(tmp, 'handoff', 'validation');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));

    expect(manifest.validation).toEqual({ test: 'npm run test:unit' });
  });

  it('emits npx tsc --noEmit for a TypeScript project', async () => {
    const sessionId = 'validation-ts-session';
    writeHandoffWriterSessionState(tmp, sessionId);
    writeValidationConfig();
    writeFileSync(join(tmp, 'tsconfig.json'), '{}');

    const outDir = join(tmp, 'handoff', 'validation-ts');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));

    expect(manifest.validation.typecheck).toBe('npx tsc --noEmit');
    expect(manifest.validation.test).toBe('npm run test:unit');
  });
});

describe('writeHandoffPack — readback correctness', () => {
  it('produces task files with real briefHash matching manifest, correct taskId, and non-empty sections', async () => {
    const sessionId = 'readback-session';
    writeHandoffWriterSessionState(tmp, sessionId);

    const outDir = join(tmp, 'handoff', 'readback');
    await writeHandoffPack({
      projectDir: tmp,
      sessionId,
      target: 'spec-kit',
      outDir,
      mode: 'default',
    });

    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
    const expectedHash = hashTaskBrief(handoffWriterTasks);

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

describe('writeHandoffPack — confined constitution reads', () => {
  itUnix('does not include constitution content from symlink escapes', async () => {
    const outside = createTempDir('handoff-constitution-outside');
    try {
      const sessionId = 'constitution-session';
      writeHandoffWriterSessionState(tmp, sessionId);
      writeFileSync(join(outside, 'constitution.md'), '# Outside constitution\n\nsecret rules');
      symlinkSync(join(outside, 'constitution.md'), join(tmp, 'constitution.md'));

      const outDir = join(tmp, 'handoff', 'constitution');
      const result = await writeHandoffPack({
        projectDir: tmp,
        sessionId,
        target: 'spec-kit',
        outDir,
        mode: 'default',
      });

      expect(result.files).not.toContain('constitution.md');
      const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8'));
      expect(manifest.constitution ?? null).toBeNull();
    } finally {
      cleanupTempDir(outside);
    }
  });
});
