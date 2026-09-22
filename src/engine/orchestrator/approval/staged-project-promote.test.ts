import { describe, it, expect, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SPLITBRIEF_DIR, TREES_DIR } from '../../../core/paths.js';
import { captureAcquisitionBaseline } from './file-snapshots/entry.js';
import { createStagedProject, promoteStagedChanges } from './staged-project.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

// The empty-project regression exercises staging without creating a Git
// fixture. Snapshot acquisition is a separate boundary and is held at an
// empty result so the test reaches copyProjectFiles' no-entry path.
vi.mock('./file-snapshots/capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-snapshots/capture.js')>();
  return {
    ...actual,
    getChangedFilesSnapshot: vi.fn(async () => ({
      head: 'empty-project',
      files: [],
      dirtyFileContents: {},
    })),
  };
});

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('promoteStagedChanges', () => {
  it('creates an empty staged root for a project without Git entries', async () => {
    const projectDir = createTempDir('staged-empty-no-git');
    try {
      const staged = await createStagedProject(projectDir);
      try {
        expect(existsSync(staged.projectDir)).toBe(true);
        expect(staged.snapshot.baselineFileHashes).toEqual({});
      } finally {
        staged.cleanup();
      }
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('copies staged content only when the original file still matches the expected snapshot', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['src/app.ts'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['src/app.ts'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('staged\n');
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('promotes a task edit to .gitignore without the isolation bookkeeping lines', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const original = 'node_modules/\ndist/\n';
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(
        join(stagedDir, '.gitignore'),
        `${original}${SPLITBRIEF_DIR}/\n${TREES_DIR}/\ncoverage/\n`,
      );

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['.gitignore'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(`${original}coverage/\n`);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('keeps a bookkeeping entry the project .gitignore already carried', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const original = `node_modules/\n${SPLITBRIEF_DIR}/\n`;
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(join(stagedDir, '.gitignore'), `${original}${TREES_DIR}/\ncoverage/\n`);

      await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(`${original}coverage/\n`);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('drops a task-authored bookkeeping entry the project .gitignore did not already carry', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      // The strip cannot tell this line from the one isolation appended, so the
      // task's own addition is dropped rather than risk writing SPLITBRIEF's
      // bookkeeping into a tracked file. Adding it stays a manual step.
      const original = 'node_modules/\n';
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(join(stagedDir, '.gitignore'), `${original}${TREES_DIR}/\n`);

      await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(original);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('promotes a file other than .gitignore verbatim when it lists the same entries', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const body = `ignored:\n${SPLITBRIEF_DIR}/\n${TREES_DIR}/\n`;
      writeFileSync(join(stagedDir, 'notes.md'), body);

      await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['notes.md'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(readFileSync(join(projectDir, 'notes.md'), 'utf-8')).toBe(body);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('promotes a new binary file byte for byte', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const payload = Buffer.from([0x89, 0xff, 0xfe, 0x80, 0x00, 0x0a]);
      writeFileSync(join(stagedDir, 'logo.bin'), payload);

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['logo.bin'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['logo.bin'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, 'logo.bin'))).toEqual(payload);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('promotes an approved binary modification byte for byte', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      writeFileSync(join(projectDir, 'logo.bin'), 'text original\n');
      const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff]);
      writeFileSync(join(stagedDir, 'logo.bin'), payload);

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['logo.bin'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['logo.bin'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, 'logo.bin'))).toEqual(payload);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  itUnix('keeps execute bits on a new executable script', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      writeFileSync(join(stagedDir, 'run.sh'), '#!/bin/sh\n');
      chmodSync(join(stagedDir, 'run.sh'), 0o755);

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['run.sh'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['run.sh'], conflictedFiles: [] });
      expect(statSync(join(projectDir, 'run.sh')).mode & 0o777).toBe(0o755);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  itUnix('strips privileged mode bits from a new executable script', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      writeFileSync(join(stagedDir, 'install.sh'), '#!/bin/sh\n');
      chmodSync(join(stagedDir, 'install.sh'), 0o4755);

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['install.sh'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['install.sh'], conflictedFiles: [] });
      expect(statSync(join(projectDir, 'install.sh')).mode & 0o7777).toBe(0o755);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  itUnix('keeps .gitignore permission bits across the bookkeeping strip', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      const original = 'node_modules/\n';
      writeFileSync(join(projectDir, '.gitignore'), original);
      writeFileSync(join(stagedDir, '.gitignore'), `${original}${SPLITBRIEF_DIR}/\n`);
      chmodSync(join(stagedDir, '.gitignore'), 0o664);

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['.gitignore'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['.gitignore'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe(original);
      expect(statSync(join(projectDir, '.gitignore')).mode & 0o777).toBe(0o664);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('removes the target file when the staged copy was deleted', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'scratch.ts'), 'scratch\n');

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['src/scratch.ts'],
        targetBaseline: await captureAcquisitionBaseline(projectDir),
      });

      expect(promoted).toEqual({ promotedFiles: ['src/scratch.ts'], conflictedFiles: [] });
      expect(existsSync(join(projectDir, 'src', 'scratch.ts'))).toBe(false);
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('keeps local edits when promotion detects a conflict', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');
      const targetBaseline = await captureAcquisitionBaseline(projectDir);
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'user edit\n');

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['src/app.ts'],
        targetBaseline,
      });

      expect(promoted).toEqual({ promotedFiles: [], conflictedFiles: ['src/app.ts'] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('user edit\n');
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('treats a target already holding the staged bytes as promoted, not as a conflict', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    try {
      mkdirSync(join(projectDir, 'src'), { recursive: true });
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'original\n');
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');
      const targetBaseline = await captureAcquisitionBaseline(projectDir);
      writeFileSync(join(projectDir, 'src', 'app.ts'), 'staged\n');

      const promoted = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: stagedDir,
        files: ['src/app.ts'],
        targetBaseline,
      });

      expect(promoted).toEqual({ promotedFiles: ['src/app.ts'], conflictedFiles: [] });
      expect(readFileSync(join(projectDir, 'src', 'app.ts'), 'utf-8')).toBe('staged\n');
    } finally {
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });

  it('rejects changed file paths that escape the target project', async () => {
    const targetRoot = createTempDir('promote-target-root');
    const stagedRoot = createTempDir('promote-staged-root');
    const projectDir = join(targetRoot, 'project');
    const stagedDir = join(stagedRoot, 'staged');
    try {
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(stagedDir, { recursive: true });
      writeFileSync(join(stagedRoot, 'escape.ts'), 'staged escape\n');

      await expect(
        promoteStagedChanges({
          targetProjectDir: projectDir,
          stagedProjectDir: stagedDir,
          files: ['../escape.ts'],
          targetBaseline: await captureAcquisitionBaseline(projectDir),
        }),
      ).rejects.toThrow(/unsafe path/);

      expect(existsSync(join(targetRoot, 'escape.ts'))).toBe(false);
    } finally {
      cleanupTempDir(stagedRoot);
      cleanupTempDir(targetRoot);
    }
  });

  itUnix('does not promote through a symlinked target parent outside the project', async () => {
    const projectDir = createTempDir('promote-project');
    const stagedDir = createTempDir('promote-staged');
    const outsideDir = createTempDir('promote-outside');
    try {
      mkdirSync(join(stagedDir, 'src'), { recursive: true });
      writeFileSync(join(stagedDir, 'src', 'app.ts'), 'staged\n');
      symlinkSync(outsideDir, join(projectDir, 'src'));

      await expect(
        promoteStagedChanges({
          targetProjectDir: projectDir,
          stagedProjectDir: stagedDir,
          files: ['src/app.ts'],
          targetBaseline: await captureAcquisitionBaseline(projectDir),
        }),
      ).rejects.toThrow(/unsafe path/);

      expect(existsSync(join(outsideDir, 'app.ts'))).toBe(false);
    } finally {
      cleanupTempDir(outsideDir);
      cleanupTempDir(stagedDir);
      cleanupTempDir(projectDir);
    }
  });
});
