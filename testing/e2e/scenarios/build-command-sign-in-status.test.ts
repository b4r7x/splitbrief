import { expect, it, onTestFinished } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { cannotConsult } from '#testing/helpers/typed-planner.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import { cli, createStopContinueFixture } from '../helpers/stop-continue-fixture.js';

it.each([
  {
    name: 'a sign-in refusal',
    output: 'Error: not logged in\n',
    code: 1,
    consulted: false,
    diagnostic: 'Error: not logged in',
  },
  {
    name: 'a successful sign-in status followed by an ordinary error',
    output: 'Sign in was successful.\nError: workspace index is corrupt.\n',
    code: 23,
    consulted: true,
    diagnostic: 'Error: workspace index is corrupt.',
  },
])('shows the outcome of $name', async (row) => {
  const fixture = createStopContinueFixture(
    () => `
      for await (const chunk of process.stdin) void chunk;
      process.stderr.write(${JSON.stringify(row.output)});
      process.exitCode = ${row.code};
    `,
    {
      isolation: 'none',
      consult: () => `(prompt) => {
        if (!/^# Consult on a failing task$/m.test(prompt)) return undefined;
        return ${JSON.stringify(JSON.stringify(cannotConsult('The workspace needs attention.')))};
      }`,
    },
  );
  onTestFinished(() => cleanupTempDir(fixture.tmpDir));

  const result = await cli(fixture, ['start', 'Add a greeting helper']);
  expect(result.exitCode, result.stderr).toBe(1);
  const sessionId = readActive(fixture.projectDir);
  if (sessionId === null) throw new Error(result.stderr);
  const { events } = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
  const errors = events.flatMap((event) =>
    event.type === 'implementer_generate_failed' ? [event.error] : [],
  );
  expect(events.filter((event) => event.type === 'consult_answered')).toHaveLength(
    row.consulted ? 1 : 0,
  );
  expect(result.stderr.includes('Seat down (runner-unauthenticated)')).toBe(!row.consulted);
  expect(errors).toEqual([expect.stringContaining(row.diagnostic)]);
  expect(errors[0]).toContain(`exited with code ${row.code}`);
  if (!row.consulted) {
    const { screen } = await openHaltedRun(fixture, { heading: 'Signed out', cliOutput: result });
    try {
      expect(stripAnsiStyles(screen.lastFrame())).toContain('Error: not logged in');
    } finally {
      screen.unmount();
      await settleOpenedRuns();
    }
  }
});
