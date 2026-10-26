import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { CliImplementerConfig } from '../../../core/schemas/implementer-config.js';
import { createCliImplementer } from '../../implementers/cli.js';
import { formatRecoveryPrompt } from '../../../features/workflow/recovery-prompt.js';
import { runTaskLoop } from './loop.js';

afterEach(cleanupTaskProjects);

/** The BUILD tools that took the prompt on their command line before it moved to stdin. */
const STDIN_TOOLS: readonly CliToolId[] = [
  'antigravity',
  'cursor',
  'opencode',
  'kilo-code',
  'copilot',
  'command-code',
];

const FIXTURES = join(import.meta.dirname, '../../../../testing/fixtures');

const LARGE_BRIEF = 'Make it so. '.repeat(16_000);

function cliSeat(
  tool: CliToolId,
  fallback?: CliImplementerConfig['fallback'],
): CliImplementerConfig {
  return {
    kind: 'cli',
    tool,
    ...(CLI_TOOL_CATALOG[tool].auth.kind === 'provider-dependent' && {
      authChannel: 'provider-dependent',
    }),
    contextLength: 2_000_000,
    ...(fallback !== undefined && { fallback }),
  } as CliImplementerConfig;
}

describe('a BUILD tool that takes the prompt on stdin', { timeout: 90_000 }, () => {
  const shimDirs: string[] = [];
  let restorePath: (() => void) | undefined;
  afterEach(() => {
    restorePath?.();
    restorePath = undefined;
    while (shimDirs.length > 0) cleanupTempDir(shimDirs.pop() as string);
  });

  it.each(STDIN_TOOLS)('%s starts with a prompt larger than a command line takes', async (tool) => {
    const shimDir = createTempDir('stdin-shim-dir');
    shimDirs.push(shimDir);
    const received = join(shimDir, 'received-bytes');
    const args = join(shimDir, 'received-args');
    writeFileSync(
      join(shimDir, CLI_TOOL_CATALOG[tool].command),
      `#!/bin/bash\nprintf '%s\\n' "$@" >> ${args}\nwc -c >> ${received}\nexit 1\n`,
      { mode: 0o755 },
    );
    restorePath = prependPath(shimDir);
    const seat = cliSeat(tool);
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', [tool, 'claude-code']));
    const { bus } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: createCliImplementer(seat, {
        trustedCli: trustedShimGate({ dir: shimDir, tool }),
      }),
      planner: makePlanner({ typedCall: consultCallAnswering(() => guidanceConsult()) }),
      bus,
      config: makeConfig({
        implementer: seat,
        validation: { endChecks: false, testCommand: 'noop' },
      }),
    });

    const { state } = await runTaskLoop({
      wctx,
      initialState: implementingState([makeTask({ id: 'T001', description: LARGE_BRIEF })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const firstCallBytes = existsSync(received)
      ? Number(readFileSync(received, 'utf8').trim().split('\n')[0])
      : 0;
    expect(firstCallBytes).toBeGreaterThan(Buffer.byteLength(LARGE_BRIEF));
    expect(existsSync(args) ? readFileSync(args, 'utf8') : '').not.toContain('Make it so.');
    expect(state.pendingRecovery?.reason).not.toBe('context-overflow');
    for (const line of state.pendingRecovery?.details ?? []) {
      expect(line).not.toMatch(/command line|too large/i);
    }
  });

  it('halts Copilot on its policy denial at once and takes the declared fallback', async () => {
    const shimDir = createTempDir('copilot-policy-shim');
    shimDirs.push(shimDir);
    const counter = join(shimDir, 'spawned');
    writeFileSync(
      join(shimDir, CLI_TOOL_CATALOG.copilot.command),
      [
        '#!/bin/bash',
        'cat >/dev/null',
        `echo x >> ${counter}`,
        `cat ${JSON.stringify(join(FIXTURES, 'copilot/access-denied-policy.stdout.ndjson'))}`,
        `cat ${JSON.stringify(join(FIXTURES, 'copilot/access-denied-policy.stderr.txt'))} >&2`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    restorePath = prependPath(shimDir);
    const seat = cliSeat('copilot', { tool: 'claude-code' });
    const config = makeConfig({
      implementer: seat,
      validation: { endChecks: false, testCommand: 'noop' },
    });
    const { projectDir, sessionId } = setupProject();
    writeConfig(projectDir, config);
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['copilot', 'claude-code']));
    const { bus, events } = makeBusRecorder();
    const consult = vi.fn(() => guidanceConsult());
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: createCliImplementer(seat, {
        trustedCli: trustedShimGate({ dir: shimDir, tool: 'copilot' }),
      }),
      planner: makePlanner({ typedCall: consultCallAnswering(consult) }),
      bus,
      config,
    });

    const { state } = await runTaskLoop({
      wctx,
      initialState: implementingState([makeTask({ id: 'T001' })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const issue = state.pendingRecovery;
    expect({
      spawned: existsSync(counter) ? readFileSync(counter, 'utf8') : '',
      retries: events.filter((event) => event.type === 'task_retry').length,
      consults: consult.mock.calls.length,
      reason: issue?.reason,
      cause: issue?.facts?.cause,
      auto: issue?.switchSeat?.auto?.candidate,
    }).toEqual({
      spawned: 'x\n',
      retries: 0,
      consults: 0,
      reason: 'runner-usage-limit',
      cause: 'access',
      auto: { tool: 'claude-code' },
    });
    if (issue === undefined) return;
    expect(formatRecoveryPrompt(issue).split('\n')[0]).toBe(
      'Seat down · Access refused by GitHub Copilot CLI',
    );
    expect(issue.details.join('\n')).toContain('Access denied by policy settings');
  });
});
