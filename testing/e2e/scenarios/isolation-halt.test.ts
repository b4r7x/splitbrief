import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATE_FILE, sessionDir } from '../../../src/core/paths.js';
import { WorkflowStateSchema } from '../../../src/core/schemas/workflow.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import {
  createStopContinueFixture,
  ESCAPED_BRANCH,
  escapingImplementerScript,
  GREET_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const RUN_TIMEOUT_MS = 60_000;

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

function cli(target: StopContinueFixture, args: readonly string[]) {
  return spawnCli({
    args: [
      '--import',
      'tsx',
      'src/cli.ts',
      ...args,
      '--plain',
      '--allow-repo-runners',
      '--project',
      target.projectDir,
    ],
    stateHome: target.stateHome,
    timeoutMs: RUN_TIMEOUT_MS,
  });
}

describe('e2e: a checkout whose git state changes during an implementer call', () => {
  it('halts the headless run with the evidence, and continue --action retry finishes it', async () => {
    fixture = createStopContinueFixture(escapingImplementerScript);

    const halted = await cli(fixture, ['start', 'smoke']);

    expect(halted.exitCode).toBe(1);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(`the halted run left no session: ${halted.stderr}`);
    expect(halted.stderr).toContain(
      `Recovery required (checkout-changed): Your checkout changed under T001 — branch ${ESCAPED_BRANCH}`,
    );
    expect(halted.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId} --action retry`,
    );
    expect(halted.stdout).not.toContain('task T001: done');
    expect(
      execFileSync('git', ['branch', '--list', ESCAPED_BRANCH], {
        cwd: fixture.projectDir,
        encoding: 'utf8',
      }).trim(),
    ).toBe(ESCAPED_BRANCH);
    expect(existsSync(fixture.greetPath)).toBe(false);
    const state = WorkflowStateSchema.parse(
      JSON.parse(
        readFileSync(join(sessionDir(fixture.projectDir, sessionId), STATE_FILE), 'utf-8'),
      ),
    );
    expect(state.pendingRecovery?.reason).toBe('checkout-changed');

    const continued = await cli(fixture, ['continue', sessionId, '--action', 'retry']);

    expect(continued.exitCode, continued.stderr).toBe(0);
    expect(continued.stdout).toContain('task T001: done');
    expect(readFileSync(fixture.greetPath, 'utf-8')).toBe(GREET_SOURCE);
  }, 150_000);
});
