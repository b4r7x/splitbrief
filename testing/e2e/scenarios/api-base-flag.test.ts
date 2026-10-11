import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: API base flags on non-API seats', () => {
  it('warns for each flag and completes with the configured local runners', async () => {
    fixture = createStopContinueFixture(
      () => `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`,
      { isolation: 'none' },
    );

    const result = await cli(fixture, [
      'start',
      'smoke',
      '--planner-api-base',
      'http://127.0.0.1:1/v1',
      '--implementer-api-base',
      'http://127.0.0.1:1/v1',
      '--reviewer-api-base',
      'http://127.0.0.1:1/v1',
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      "--planner-api-base is ignored: the planner 'shell' runner does not use it.",
    );
    expect(result.stderr).toContain(
      "--implementer-api-base is ignored: the implementer 'agent' runner does not use it.",
    );
    expect(result.stderr).toContain(
      "--reviewer-api-base is ignored: the reviewer 'shell' runner does not use it.",
    );
    expect(result.stdout).toContain('task T001: done');
    expect(readFileSync(fixture.greetPath, 'utf8')).toBe(GREET_SOURCE);
    const sessions = readdirSync(sessionsRoot(fixture.projectDir));
    expect(sessions).toHaveLength(1);
    const [sessionId] = sessions;
    if (sessionId === undefined) throw new Error(`the run left no session: ${result.stderr}`);
    expect(
      deriveRunStatus({ state: readState(fixture, sessionId), liveness: 'not-alive' }),
    ).toEqual({
      kind: 'closed',
      as: 'complete',
    });
  });
});
