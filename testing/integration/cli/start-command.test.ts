import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  fakeDeps,
  getStartCommandTmp,
  prepareExecutionMock,
  renderCalls,
  runHeadlessMock,
  runStart,
  setupStartCommandIntegration,
  writeConfigMarker,
  writeLiveSession,
  writeSessionLockfile,
} from '#testing/helpers/start-command.js';
import { registerStartCommand } from '../../../src/cli/commands/start/register.js';
import { isCliError, type CliError } from '../../../src/cli/errors.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { attachmentsStore } from '../../../src/stores/workflow/attachments.js';

setupStartCommandIntegration();

describe('start command — concurrency guard', () => {
  it('starts interactive setup past an exited session and preserves its active marker', async () => {
    const tmp = getStartCommandTmp();
    const sessionId = '2026-04-18-exited';
    writeLiveSession(tmp, sessionId);
    writeSessionLockfile(tmp, sessionId, { exitedAt: Date.now(), exitCode: 0 });

    await runStart(['--project', tmp, 'another feature']);

    expect(routerStore.get()).toMatchObject({ screen: 'setup', feature: 'another feature' });
    const activePath = join(tmp, SPLITBRIEF_DIR, 'active');
    expect(existsSync(activePath)).toBe(true);
    expect(readFileSync(activePath, 'utf-8').trim()).toBe(sessionId);
  });
});

describe('start command — shorthand invocation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes bare positional feature to start action via default command', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync(['node', 'splitbrief', 'implement auth flow', '--project', tmp]);

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'local',
        prepared: { runtime: { feature: 'implement auth flow' } },
      },
    });
  });

  it('does not hijack explicit subcommands registered on the same program', async () => {
    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);

    let specCalled = false;
    program.command('spec').action(() => {
      specCalled = true;
    });
    await program.parseAsync(['node', 'splitbrief', 'spec']);

    expect(specCalled).toBe(true);
    expect(renderCalls).toEqual([]);
  });

  it('passes workflow options through shorthand invocation', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync(['node', 'splitbrief', 'build feature X', '--project', tmp]);

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'local',
        prepared: { runtime: { feature: 'build feature X' } },
      },
    });
  });
});

describe('start command — @file syntax', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('separates @file content into plannerContext, not feature', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    writeFileSync(join(tmp, 'brief.md'), 'Context about the feature.');

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync([
      'node',
      'splitbrief',
      'start',
      'build it',
      '@brief.md',
      '--project',
      tmp,
    ]);

    const route = routerStore.get();
    expect(route).toMatchObject({ screen: 'workflow', execution: { kind: 'local' } });
    if (route.screen !== 'workflow' || route.execution.kind !== 'local') {
      throw new Error('Expected a prepared local workflow route');
    }
    expect(route.execution.prepared.runtime.feature).toContain('build it');
    expect(route.execution.prepared.runtime.feature).not.toContain('Context about the feature.');
    expect(route.execution.prepared.runtime.plannerContext).toContain('Context about the feature.');
  });

  it('reads a text file outside the project that the user named, and records its resolved path', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    const outside = realpathSync(createTempDir('start-command-outside'));
    try {
      const brief = join(outside, 'medium-feature.md');
      writeFileSync(brief, 'The real brief.');

      await runStart(['build it', `@${brief}`, '--project', tmp]);

      const route = routerStore.get();
      if (route.screen !== 'workflow' || route.execution.kind !== 'local') {
        throw new Error('Expected a prepared local workflow route');
      }
      expect(route.execution.prepared.runtime.plannerContext).toContain('The real brief.');
      expect(route.execution.prepared.runtime.attachedInputs).toEqual([
        { path: brief, kind: 'text' },
      ]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('hands the resolved attached inputs to a headless run', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    const outside = realpathSync(createTempDir('start-command-outside'));
    try {
      const brief = join(outside, 'medium-feature.md');
      writeFileSync(brief, 'The real brief.');
      writeFileSync(join(tmp, 'mock.png'), Buffer.alloc(100));

      await runStart(['build it', `@${brief}`, '@mock.png', '--json', '--project', tmp]);

      const prepared = runHeadlessMock.mock.calls[0]?.[0].prepared;
      expect(prepared?.runtime.plannerContext).toContain('The real brief.');
      expect(prepared?.runtime.attachedInputs).toEqual([
        { path: brief, kind: 'text' },
        { path: join(tmp, 'mock.png'), kind: 'image' },
      ]);
    } finally {
      cleanupTempDir(outside);
    }
  });

  it('refuses a missing @file instead of starting without it', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    const err = await startRefusal(['build it', '@ghost.md', '--project', tmp]);

    expect(err.exitCode).toBe(2);
    expect(err.message).toContain('  @ghost.md: file not found. Check the path and try again.');
    expectNothingStarted(tmp);
  });

  it('lists every refused input in argument order and attaches none of the valid ones', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    writeFileSync(join(tmp, 'shot.png'), Buffer.alloc(100));
    writeFileSync(join(tmp, 'notes.md'), 'Valid notes.');
    mkdirSync(join(tmp, 'docs'));

    const err = await startRefusal([
      'build it',
      '@shot.png',
      '@ghost.md',
      '@notes.md',
      '@docs',
      '@../escape.md',
      '--project',
      tmp,
    ]);

    expect(err.exitCode).toBe(2);
    expect(err.message).toBe(
      [
        'Cannot start: SPLITBRIEF refused these @file inputs.',
        '  @ghost.md: file not found. Check the path and try again.',
        '  @docs: not a regular file. Name a file, not a directory.',
        '  @../escape.md: file not found. Check the path and try again.',
      ].join('\n'),
    );
    expect(attachmentsStore.peek()).toEqual([]);
    expectNothingStarted(tmp);
  });

  it('refuses through the default-command shorthand', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    const err = await program
      .parseAsync(['node', 'splitbrief', 'build it', '@ghost.md', '--project', tmp])
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(isCliError(err) && err.exitCode).toBe(2);
    expectNothingStarted(tmp);
  });

  it.each([['--json'], ['--plain']])(
    'refuses in headless %s mode before the headless run',
    async (flag) => {
      const tmp = getStartCommandTmp();
      writeConfigMarker(tmp);

      const err = await startRefusal(['build it', '@ghost.md', flag, '--project', tmp]);

      expect(err.exitCode).toBe(2);
      expect(runHeadlessMock).not.toHaveBeenCalled();
      expectNothingStarted(tmp);
    },
  );

  it('refuses a file reference in the feature position', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    writeFileSync(join(tmp, 'brief.md'), 'The real brief.');

    const err = await startRefusal(['@brief.md', '--project', tmp]);

    expect(err.exitCode).toBe(2);
    expect(err.message).toBe(
      'Cannot start: @brief.md is a file reference, not a feature description. Put the feature description first: splitbrief start "<feature>" @<file>',
    );
    expectNothingStarted(tmp);
  });

  it('reserves a leading @ in the feature description', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    const err = await startRefusal(['@mentions in comments', '--project', tmp]);

    expect(err.exitCode).toBe(2);
    expect(err.message).toBe(
      'Cannot start: @mentions in comments is a file reference, not a feature description. Put the feature description first: splitbrief start "<feature>" @<file>',
    );
    expectNothingStarted(tmp);
  });

  it.each([[[]], [['--plain']], [['--json']]])(
    'refuses @file inputs after an empty feature description (%j)',
    async (modeFlags) => {
      const tmp = getStartCommandTmp();
      writeConfigMarker(tmp);
      writeFileSync(join(tmp, 'brief.md'), 'The real brief.');

      const err = await startRefusal(['', '@brief.md', ...modeFlags, '--project', tmp]);

      expect(err.exitCode).toBe(2);
      expect(err.message).toBe(
        'Cannot start: the feature description is empty. Put the feature description first: splitbrief start "<feature>" @<file>',
      );
      expect(runHeadlessMock).not.toHaveBeenCalled();
      expectNothingStarted(tmp);
    },
  );

  it.each([[[]], [['--plain']], [['--json']]])(
    'refuses in a project with no SPLITBRIEF folder and creates none (%j)',
    async (modeFlags) => {
      const tmp = getStartCommandTmp();

      const err = await startRefusal(['build it', '@ghost.md', ...modeFlags, '--project', tmp]);

      expect(err.exitCode).toBe(2);
      expect(runHeadlessMock).not.toHaveBeenCalled();
      expectNothingStarted(tmp);
      expect(existsSync(join(tmp, SPLITBRIEF_DIR))).toBe(false);
    },
  );

  it('strips terminal control bytes from refused paths', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    const err = await startRefusal(['build it', '@\u001b]0;pwned\u0007ghost.md', '--project', tmp]);

    expect(err.message).toContain('ghost.md: file not found.');
    expect(err.message).not.toContain('\u001b');
    expect(err.message).not.toContain('pwned');
  });
});

async function startRefusal(args: string[]): Promise<CliError> {
  const err = await runStart(args).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!isCliError(err)) throw new Error(`expected a CliError, got ${String(err)}`);
  return err;
}

function expectNothingStarted(projectDir: string): void {
  expect(renderCalls).toEqual([]);
  expect(prepareExecutionMock).not.toHaveBeenCalled();
  expect(routerStore.get().screen).toBe('home');
  expect(attachmentsStore.peek()).toEqual([]);
  expect(existsSync(join(projectDir, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
}
