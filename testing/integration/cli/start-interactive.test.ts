import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getStartCommandTmp,
  renderCalls,
  runStart,
  setupStartCommandIntegration,
  writeConfigMarker,
} from '#testing/helpers/start-command.js';
import { DIPTYCH_DIR } from '../../../src/core/paths.js';
import { isCliError } from '../../../src/cli/errors.js';
import { routerStore } from '../../../src/stores/navigation/router.js';

setupStartCommandIntegration();

describe('start command — non-TTY preflight', () => {
  it('fails fast without creating a session when stdin is not a TTY', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'implement X']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('interactive mode needs a TTY');
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'active'))).toBe(false);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(false);
    expect(renderCalls).toEqual([]);
  });
});

describe('start command — session lifecycle during setup', () => {
  it('does not create a session when setup is needed, preventing orphaned sessions', async () => {
    const tmp = getStartCommandTmp();
    await runStart(['--project', tmp, 'implement X']);

    expect(routerStore.get()).toMatchObject({ screen: 'setup', feature: 'implement X' });
    const activePath = join(tmp, DIPTYCH_DIR, 'active');
    expect(existsSync(activePath)).toBe(false);
    const sessionsDir = join(tmp, DIPTYCH_DIR, 'sessions');
    expect(existsSync(sessionsDir)).toBe(false);
  });

  it('creates a session when setup is not needed and feature is given', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    await runStart(['--project', tmp, 'implement X']);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', feature: 'implement X' });
    const activePath = join(tmp, DIPTYCH_DIR, 'active');
    expect(existsSync(activePath)).toBe(true);
  });
});
