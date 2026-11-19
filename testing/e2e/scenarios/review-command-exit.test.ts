import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { writeFakeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import {
  REVIEWER_EXIT_CAUSE,
  REVIEWER_EXIT_TRACE,
  REVIEWER_NODE_EMOJI_EXIT_TRACE,
  REVIEWER_NODE_EXIT_TRACE,
} from '#testing/helpers/reviewer-exit-trace.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { openHaltedRun, settleOpenedRuns } from '../helpers/halted-run-screen.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
} from '../helpers/stop-continue-fixture.js';

const EXIT_23_HEADING =
  'Needs you · Final review failed (reviewer: Claude Code CLI): CLI exited with code 23';

it.each([
  {
    label: 'option refusal',
    exit: 2,
    code: 'implementer-recipe-invalid',
    words: 'unknown option --output-format',
    details: ['Claude Code CLI reported: unknown option --output-format'],
    heading: 'Seat down · Final review failed',
  },
  {
    label: 'short stderr',
    exit: 23,
    code: 'non-zero-exit',
    words: 'workspace index is corrupt',
    details: ['Claude Code CLI reported: workspace index is corrupt'],
    heading: EXIT_23_HEADING,
  },
  {
    label: 'long stderr',
    exit: 23,
    code: 'non-zero-exit',
    words: REVIEWER_EXIT_TRACE,
    details: [
      'Claude Code CLI reported: Failed to open workspace index.',
      'Caused by:',
      REVIEWER_EXIT_CAUSE,
    ],
    heading: EXIT_23_HEADING,
  },
  {
    label: 'Node stderr with a version footer',
    exit: 1,
    code: 'non-zero-exit',
    words: REVIEWER_NODE_EXIT_TRACE,
    details: [
      'Claude Code CLI reported: node:fs:560',
      'ENOENT',
      'workspace-index.json',
      'Node.js v22.22.2',
    ],
    heading: 'Needs you · Final review failed (reviewer: Claude Code CLI): CLI exited with code 1',
  },
  {
    label: 'Node stderr with 📚-workspace-index.json at the cut',
    exit: 1,
    code: 'non-zero-exit',
    words: REVIEWER_NODE_EMOJI_EXIT_TRACE,
    details: ['exports/ [… output omitted …]'],
    heading: 'Needs you · Final review failed (reviewer: Claude Code CLI): CLI exited with code 1',
  },
])('reopens the final REVIEW halt after a plain start ($label)', async (row) => {
  const fixture = createStopContinueFixture(
    () => `
      import { mkdirSync, writeFileSync } from 'node:fs';
      for await (const chunk of process.stdin) void chunk;
      mkdirSync('src', { recursive: true });
      writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
      writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
    `,
    { isolation: 'none' },
  );
  onTestFinished(() => cleanupTempDir(fixture.tmpDir));
  const home = useTrustHome('review-command-exit-home');
  onTestFinished(home.restore);
  mkdirSync(join(home.home, '.claude'), { recursive: true });
  writeFileSync(join(home.home, '.claude', '.credentials.json'), '{"fixture":true}\n');
  const bin = join(fixture.tmpDir, 'bin');
  mkdirSync(bin);
  const version = CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion;
  writeFakeCli(
    bin,
    'claude',
    [
      `if [ "$1" = '--version' ]; then printf '%s\\n' 'claude ${version}'; exit 0; fi`,
      `if [ "$1" = 'auth' ]; then printf '%s\\n' '{"loggedIn":true}'; exit 0; fi`,
      'cat >/dev/null',
      `printf '%s' "${row.words}" >&2`,
      `exit ${row.exit}`,
    ].join('\n'),
  );
  onTestFinished(activateSafeCliShimPath(bin));
  const config = {
    ...loadConfig(fixture.projectDir).config,
    reviewer: { kind: 'cli', tool: 'claude-code' } as const,
  };
  writeConfig(fixture.projectDir, config);
  await trustDeclaredRunners({
    projectDir: fixture.projectDir,
    config,
    pathEnv: process.env.PATH ?? '',
  });

  const result = await cli(fixture, ['start', 'Add a greeting helper']);
  expect(result.exitCode, result.stderr).toBe(1);
  if (row.label === 'short stderr') {
    expect(result.stderr).toContain(
      [
        'Needs you (review-failed): Final review failed (reviewer: Claude Code CLI): CLI exited with code 23',
        `Claude Code CLI reported: ${row.words}`,
        'Recommended: retry-same-worker',
      ].join('\n'),
    );
    expect(result.stderr.split(row.words)).toHaveLength(2);
  }
  const { screen, ref } = await openHaltedRun(fixture, { heading: 'Recovery', cliOutput: result });
  try {
    const { events } = await readRunEvents(ref);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'runner_call_error',
        error: expect.objectContaining({ code: row.code }),
      }),
    );
    const panel = stripAnsiStyles(screen.lastFrame())
      .split('\n')
      .find((line) => /(?:Needs you|Seat down) · Final review failed/.test(line));
    expect(panel).toContain(row.heading);
    const recovery = stripAnsiStyles(screen.lastFrame()).split('Recovery  ').at(-1);
    for (const detail of row.details) expect.soft(recovery).toContain(detail);
    expect.soft(recovery).not.toContain('\uFFFD');
  } finally {
    screen.unmount();
    await settleOpenedRuns();
  }
});
