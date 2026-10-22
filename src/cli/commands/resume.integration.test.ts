import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { writeActive } from '../../core/sessions/active-pointer.js';
import { checkSessionLiveness } from '../../core/sessions/lockfile.js';
import { saveState } from '../../core/state/persistence.js';
import { installDiagnosticSink } from '../../lib/warn.js';
import { registerResumeCommand } from './resume.js';

let tmp = '';

// A resume without --json or --plain mounts the TUI, which needs a terminal.
beforeEach(() => {
  process.stdin.isTTY = true;
});

afterEach(() => {
  delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.restoreAllMocks();
  if (tmp) cleanupTempDir(tmp);
  tmp = '';
});

describe('splitbrief resume', () => {
  it('shows a --project warning for a folder inside the repository once, on the screen', async () => {
    tmp = realpathSync(createTempDir('resume-project-subdir'));
    createTestGitRepo(tmp);
    const subdir = join(tmp, 'pkg');
    mkdirSync(subdir);
    const ref = { projectDir: tmp, sessionId: '2026-04-18-project-subdir' };
    saveState(
      ref,
      makeWorkflowState({ ...RUN_CREW, phase: 'implementing', tasks: [makeTask({ id: 'T001' })] }),
    );
    writeActive(ref);
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const shown: string[] = [];
    const warning = `Warning: --project ${subdir} is inside git repository ${tmp}; using repository root.`;

    const program = new Command();
    program.exitOverride();
    registerResumeCommand(program, {
      checkSessionLiveness,
      resumeSavedSession: async () => {
        const release = installDiagnosticSink((message) => shown.push(message));
        try {
          expect(writes).toEqual([]);
        } finally {
          release();
        }
      },
    });
    await program.parseAsync(['resume', '--project', subdir], { from: 'user' });

    expect(shown).toEqual([warning]);
    expect(writes).toEqual([`${warning}\n`]);
  });
});
