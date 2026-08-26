import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fakeDeps,
  getStartCommandTmp,
  renderCalls,
  runStart,
  setupStartCommandIntegration,
  writeConfigMarker,
  writeLiveSession,
  writeSessionLockfile,
} from '#testing/helpers/start-command.js';
import { registerStartCommand } from '../../../src/cli/commands/start/register.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { isCliError } from '../../../src/cli/errors.js';
import { routerStore } from '../../../src/stores/navigation/router.js';

setupStartCommandIntegration();

describe('start command — concurrency guard', () => {
  it('refuses to start when a live session already exists and preserves the active marker', async () => {
    const tmp = getStartCommandTmp();
    writeLiveSession(tmp, '2026-04-18-live');
    writeSessionLockfile(tmp, '2026-04-18-live');

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'another feature']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('2026-04-18-live');
    const activePath = join(tmp, SPLITBRIEF_DIR, 'active');
    expect(existsSync(activePath)).toBe(true);
    expect(readFileSync(activePath, 'utf-8').trim()).toBe('2026-04-18-live');
  });

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
    await program.parseAsync([
      'node',
      'splitbrief',
      '--mode',
      'quick',
      'build feature X',
      '--project',
      tmp,
    ]);

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

  it('warns on stderr for missing @file without aborting', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync([
      'node',
      'splitbrief',
      'start',
      'build it',
      '@ghost.md',
      '--project',
      tmp,
    ]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('@ghost.md'));
    expect(routerStore.get().screen).toBe('workflow');
  });

  it('strips terminal control bytes from the @file warning path before printing', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync([
      'node',
      'splitbrief',
      'start',
      'build it',
      '@\u001b]0;pwned\u0007ghost.md',
      '--project',
      tmp,
    ]);

    const warning = stderrSpy.mock.calls
      .map((call) => call.join(' '))
      .find((line) => line.includes('ghost.md'));
    expect(warning).toBeDefined();
    expect(warning).not.toContain('\u001b');
    expect(warning).not.toContain('pwned');
  });
});
