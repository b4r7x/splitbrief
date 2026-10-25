import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { consultCallAnswering, guidanceConsult } from '#testing/helpers/typed-planner.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { CliImplementerConfig } from '../../../core/schemas/implementer-config.js';
import { CLI_IMPLEMENTER_ADAPTERS } from '../../runners/cli-tools/registry.js';
import { createCliImplementer } from '../../implementers/cli.js';
import { runnerCallOutcome } from '../../implementers/pipeline/call-result.js';
import { formatRecoveryPrompt } from '../../../features/workflow/recovery-prompt.js';
import { runTaskLoop } from './loop.js';

afterEach(cleanupTaskProjects);

/** Every BUILD tool SPLITBRIEF hands the prompt on its command line. */
const ARGV_TOOLS = Object.entries(CLI_IMPLEMENTER_ADAPTERS)
  .filter(([, adapter]) => adapter.promptTransport.kind === 'argv')
  .map(([tool]) => tool as CliToolId);

const LARGE_BRIEF = 'Make it so. '.repeat(16_000);

function expectSplitbriefWords(text: string): void {
  expect(text).not.toMatch(/argv/i);
  expect(text).not.toMatch(/\d{4,}/);
  expect(text).not.toContain('reported:');
}

describe('a BUILD prompt larger than the tool takes on its command line', {
  timeout: 90_000,
}, () => {
  const shimDirs: string[] = [];
  let restorePath: (() => void) | undefined;
  afterEach(() => {
    restorePath?.();
    restorePath = undefined;
    while (shimDirs.length > 0) cleanupTempDir(shimDirs.pop() as string);
  });

  it('covers every argv BUILD tool', () => {
    expect(ARGV_TOOLS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(ARGV_TOOLS)('%s halts at once and recommends a tool change', async (tool) => {
    const shimDir = createTempDir('argv-shim');
    shimDirs.push(shimDir);
    const counter = join(shimDir, 'spawned');
    writeFileSync(
      join(shimDir, CLI_TOOL_CATALOG[tool].command),
      `#!/bin/bash\necho x >> ${counter}\nexit 1\n`,
      { mode: 0o755 },
    );
    restorePath = prependPath(shimDir);
    const seat = {
      kind: 'cli',
      tool,
      ...(CLI_TOOL_CATALOG[tool].auth.kind === 'provider-dependent' && {
        authChannel: 'provider-dependent',
      }),
      contextLength: 2_000_000,
      timeout: 300,
    } as CliImplementerConfig;
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', [tool, 'claude-code']));
    const { bus, events } = makeBusRecorder();
    const consult = vi.fn(consultCallAnswering(() => guidanceConsult()));
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: createCliImplementer(seat, {
        trustedCli: trustedShimGate({ dir: shimDir, tool }),
      }),
      planner: makePlanner({ typedCall: consult }),
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

    const name = CLI_TOOL_CATALOG[tool].displayName;
    const issue = state.pendingRecovery;
    expect({
      spawned: existsSync(counter) ? readFileSync(counter, 'utf8') : '',
      retries: events.filter((event) => event.type === 'task_retry').length,
      consults: consult.mock.calls.length,
      reason: issue?.reason,
      recommended: issue?.recommendedAction,
    }).toEqual({
      spawned: '',
      retries: 0,
      consults: 0,
      reason: 'context-overflow',
      recommended: 'switch-seat',
    });
    expect(issue?.message).toBe(`Prompt too large for ${name} on T001`);
    expect(issue?.details[0]).toMatch(
      new RegExp(
        `^The prompt is \\d{3},\\d{3} bytes; ${name} takes at most 120,000 on its command line\\.$`,
      ),
    );
    expect(issue?.switchSeat?.candidates).toEqual([{ tool: 'claude-code' }]);
    if (issue === undefined) return;
    for (const line of issue.details.slice(1)) expectSplitbriefWords(line);
    expect(issue.details[0]).not.toMatch(/argv|reported:/);
    for (const event of events) {
      if ('message' in event && typeof event.message === 'string') {
        expect(event.message).not.toMatch(/argv/i);
      }
    }
    expect(formatRecoveryPrompt(issue)).not.toMatch(/argv/i);
    expect(events.find((event) => event.type === 'recovery_prompted')).toMatchObject({
      headline: `Prompt too large for ${name} on T001`,
    });
  });

  it('halts on a ladder rung whose prompt grew past the limit, without a consult', async () => {
    const { projectDir, sessionId } = setupProject();
    await rememberDetectedTools(projectDir, cliDetectionsFor('ready', ['opencode', 'claude-code']));
    const message = 'CLI prompt is 120450 bytes and exceeds the 120000-byte argv limit';
    const outcome = runnerCallOutcome(
      makeRunnerCallResult({
        status: 'failed',
        text: '',
        error: { code: 'argv-prompt-too-large', message },
        backendKind: 'cli',
      }),
    );
    const implement = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'Implementer call failed',
      outcome: 'protocol-failure',
    });
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: message,
      ...(outcome.state !== 'success' && { outcome: outcome.state }),
    });
    const consult = vi.fn(consultCallAnswering(() => guidanceConsult()));
    const { bus } = makeBusRecorder();
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      implementer: makeImplementer({ implement, retry }),
      planner: makePlanner({ typedCall: consult }),
      bus,
      config: makeConfig({
        implementer: { kind: 'cli', tool: 'opencode', authChannel: 'provider-dependent' },
        validation: { endChecks: false, testCommand: 'noop' },
      } as Parameters<typeof makeConfig>[0]),
    });

    const { state } = await runTaskLoop({
      wctx,
      initialState: implementingState([makeTask({ id: 'T001' })]),
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(consult).not.toHaveBeenCalled();
    expect(state.pendingRecovery).toMatchObject({
      reason: 'context-overflow',
      recommendedAction: 'switch-seat',
      message: 'Prompt too large for OpenCode CLI on T001',
    });
    expect(state.pendingRecovery?.details[0]).toBe(
      'The prompt is 120,450 bytes; OpenCode CLI takes at most 120,000 on its command line.',
    );
  });
});
