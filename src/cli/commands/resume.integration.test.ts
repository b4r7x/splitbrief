import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { writeConfig } from '../../core/config/load/io.js';
import { writeActive } from '../../core/sessions/active-pointer.js';
import { checkSessionLiveness } from '../../core/sessions/lock/file.js';
import { saveState } from '../../core/state/persistence.js';
import { resumeSavedSession } from './continue/resume.js';
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
  it('writes a --project warning for a folder inside the repository to stderr once', async () => {
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
    const warning = `--project ${subdir} is inside git repository ${tmp}; using repository root.`;

    const program = new Command();
    program.exitOverride();
    registerResumeCommand(program, {
      checkSessionLiveness,
      resumeSavedSession: async () => {},
    });
    await program.parseAsync(['resume', '--project', subdir], { from: 'user' });

    expect(writes).toEqual([`${warning}\n`]);
  });

  it('hands the ignored-flag notice once to the preparation of a headless resume whose config holds a CLI implementer', async () => {
    tmp = realpathSync(createTempDir('resume-ignored-flag'));
    createTestGitRepo(tmp);
    const ref = { projectDir: tmp, sessionId: '2026-04-18-ignored-flag' };
    saveState(
      ref,
      makeWorkflowState({ ...RUN_CREW, phase: 'implementing', tasks: [makeTask({ id: 'T001' })] }),
    );
    writeActive(ref);
    writeConfig(
      tmp,
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
      }),
    );
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const ignored =
      "--implementer-api-base is ignored: the implementer 'cli' runner does not use it.";

    const configWarnings: unknown[] = [];
    const program = new Command();
    program.exitOverride();
    registerResumeCommand(program, {
      checkSessionLiveness,
      resumeSavedSession: (args) =>
        resumeSavedSession({
          ...args,
          deps: {
            initStores: async () => {},
            renderApp: async () => {},
            runHeadless: async () => {},
            setupWorkflow: async () => ({
              projectDir: tmp,
              useFullscreen: false,
              useMouse: false,
              useHover: false,
            }),
            prepareExecution: async (input) => {
              if (!('existingSession' in input)) throw new Error('expected resume preparation');
              configWarnings.push(input.configWarnings);
              return {
                kind: 'prepared',
                execution: makePreparedExecution({
                  projectDir: tmp,
                  sessionId: ref.sessionId,
                  feature: input.feature,
                  config: input.effectiveConfig,
                  resumeState: input.resumeState,
                }),
              };
            },
          },
        }),
    });
    await program.parseAsync(
      [
        'resume',
        '--project',
        tmp,
        '--plain',
        '--implementer-api-base',
        'http://127.0.0.1:9/v1',
        '--implementer-model',
        'm',
      ],
      { from: 'user' },
    );

    const ignoredLines = writes
      .join('')
      .split('\n')
      .filter((line) => line.includes('is ignored'));
    expect(ignoredLines).toEqual([]);
    expect(configWarnings).toEqual([
      [{ kind: 'ignored-flag', notice: ignored, fix: 'Remove the flag from the command.' }],
    ]);
  });
});
