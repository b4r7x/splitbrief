import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import YAML from 'yaml';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { cannotConsult } from '#testing/helpers/typed-planner.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  GREET_SOURCE,
  MARKER_SOURCE,
  PLAN_ANSWER,
  readState,
} from '../helpers/stop-continue-fixture.js';

const MIN_PROMPT_BYTES = 4 * 1024 * 1024;
const CONTEXT_LINE = 'Context for the brief.\n';
const CONTEXT_LINES = 200_000;

it('halts BUILD once when the configured command exits before reading the brief', async () => {
  const consultMarker = (tmpDir: string) => join(tmpDir, 'consulted');
  const implementer = () => `
    import { writeSync } from 'node:fs';
    writeSync(2, '\\u001b8');
    process.exit(0);
  `;
  const fixture = createStopContinueFixture(implementer, {
    isolation: 'none',
    consult: (tmpDir) => `(prompt) => {
      if (/^# Consult on a failing task$/m.test(prompt)) {
        process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(consultMarker(tmpDir))}, '');
        return ${JSON.stringify(JSON.stringify(cannotConsult('The command does not read stdin.')))};
      }
      const plan = ${JSON.stringify(PLAN_ANSWER)};
      plan.result.tasks[0].intent += '\\n' + ${JSON.stringify(CONTEXT_LINE)}.repeat(${CONTEXT_LINES});
      return JSON.stringify(plan);
    }`,
  });
  onTestFinished(() => cleanupTempDir(fixture.tmpDir));

  const result = await cli(fixture, [
    'start',
    'Add a greeting helper',
    '--implementer-context-length',
    '2000000',
  ]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
  const sessionId = readActive(fixture.projectDir);
  if (sessionId === null) throw new Error(result.stderr);
  const state = readState(fixture, sessionId);
  expect(
    Buffer.byteLength(state.tasks[0]?.description ?? ''),
    'recorded BUILD description bytes',
  ).toBeGreaterThanOrEqual(MIN_PROMPT_BYTES);
  const { events } = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
  const output = `${result.stdout}\n${result.stderr}`;
  expect({
    halt: result.stderr.match(/Seat down \(implementer-recipe-invalid\)/g) ?? [],
    reasonShown: output.includes('prompt could not be fully delivered through stdin'),
    failedBuilds: events.filter((event) => event.type === 'implementer_generate_failed').length,
    consults: events.filter((event) => event.type === 'consult_answered').length,
    consulted: existsSync(consultMarker(fixture.tmpDir)),
  }).toEqual({
    halt: ['Seat down (implementer-recipe-invalid)'],
    reasonShown: true,
    failedBuilds: 1,
    consults: 0,
    consulted: false,
  });
  const { screen } = await openHaltedRun(fixture, { heading: 'Recovery', cliOutput: result });
  try {
    const lines = stripAnsiStyles(screen.lastFrame()).split('\n');
    const buildRow = lines.find((line) => line.includes('BUILD failed'));
    const panel = lines.filter((line) => line.trimStart().startsWith('|')).join('\n');
    expect(buildRow).toContain('prompt could not be fully delivered through stdin');
    expect(panel).toContain('Seat down · SPLITBRIEF could not deliver the prompt');
    expect(panel).toContain('prompt could not be fully delivered through stdin');
    expect(panel).not.toContain('reported:');
  } finally {
    screen.unmount();
    await settleOpenedRuns();
  }
});

const retryableWords = 'Invalid configuration: connection reset timeout must be a positive integer';

it.each(['plan', 'review'] as const)(
  'records one %s invocation and displays stderr after an incomplete prompt',
  async (seat) => {
    const fixture = createStopContinueFixture(
      () => `
        import { mkdirSync, writeFileSync } from 'node:fs';
        for await (const chunk of process.stdin) void chunk;
        mkdirSync('src', { recursive: true });
        writeFileSync('src/greet.ts', ${JSON.stringify(GREET_SOURCE)});
        writeFileSync('src/marker.ts', ${JSON.stringify(MARKER_SOURCE)});
      `,
      { isolation: 'none' },
    );
    onTestFinished(() => cleanupTempDir(fixture.tmpDir));
    const calls = join(fixture.tmpDir, 'calls');
    const path = join(fixture.projectDir, SPLITBRIEF_DIR, 'config.yaml');
    const config = YAML.parse(readFileSync(path, 'utf8'));
    config[seat === 'plan' ? 'planner' : 'reviewer'] = {
      kind: 'shell',
      command: 'node',
      args: [
        '-e',
        `const fs = require('node:fs');
         const retried = fs.existsSync(${JSON.stringify(calls)});
         fs.appendFileSync(${JSON.stringify(calls)}, 'x');
         fs.writeSync(2, retried ? 'Workspace index unreadable' : ${JSON.stringify(retryableWords)});
         process.exit(0);`,
      ],
      contextLength: 1_000_000,
    };
    writeFileSync(path, YAML.stringify(config));

    const contextPath = join(fixture.tmpDir, 'context.txt');
    writeFileSync(contextPath, CONTEXT_LINE.repeat(CONTEXT_LINES));
    const result = await cli(fixture, ['start', 'Add a greeting helper', `@${contextPath}`]);
    expect(result.exitCode, result.stderr).toBe(1);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(result.stderr);
    const state = readState(fixture, sessionId);
    expect(
      Buffer.byteLength(state.plannerContext ?? ''),
      `recorded ${seat} context bytes`,
    ).toBeGreaterThanOrEqual(MIN_PROMPT_BYTES);
    const { events } = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
    expect({
      invocations: readFileSync(calls, 'utf8').length,
      retries: events.filter((event) => event.type === 'seat_retry').length,
      diagnostics: events.flatMap((event) =>
        event.type === 'runner_call_error' && event.error.code === 'prompt-transport-error'
          ? [event.error.message]
          : [],
      ),
    }).toEqual({
      invocations: 1,
      retries: 0,
      diagnostics: [expect.stringContaining(retryableWords)],
    });
    const haltLabel = seat === 'plan' ? 'Seat down' : 'Needs you';
    const { screen } = await openHaltedRun(fixture, {
      heading: `${haltLabel} · SPLITBRIEF could not deliver the prompt`,
      cliOutput: result,
    });
    try {
      const panel = stripAnsiStyles(screen.lastFrame())
        .split('\n')
        .filter((line) => line.trimStart().startsWith('|'))
        .join('\n');
      expect(panel).toContain('SPLITBRIEF could not deliver the prompt');
      expect(panel).toContain('Custom Shell reported: Invalid configuration');
    } finally {
      screen.unmount();
      await settleOpenedRuns();
    }
  },
);
