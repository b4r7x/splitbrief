import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../core/schemas/config.js';
import { resolveImplementerProfiles } from '../../core/config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../../core/config/accessors/reviewer-runner.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { createConfiguredCustomPlanner } from '../planners/command-invoke.js';
import { createImplementer, createPlanner, createReviewer } from './factory.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import type { RunnerFactoryAuthority } from './factory-gates.js';
import type { RunnerSlot } from './prepared-execution.js';
import { prepareCustomRunnerAdmission } from './custom-admission.js';
import { customRunnerSecurityPosture } from './custom-trust.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  configuredPlanner,
  createCommandInvokeTestFixtures,
  runtimeFor,
} from '#testing/helpers/planner-command-invoke.js';
import {
  configuredRunner,
  createConfiguredCustomImplementer,
  createConfiguredImplementerFixtures,
} from '#testing/helpers/configured-custom-implementer.js';

// Past 1 MiB in bytes, multibyte, with a tail that shows the prompt arrived whole.
const PROMPT_TAIL = 'END-OF-PROMPT';
const LARGE_PROMPT = `${'漢'.repeat(400_000)}${PROMPT_TAIL}`;

// The child records what it received: its argv after `-e <script>`, its cwd, HOME and stdin.
function recordScript(recordPath: string): string {
  return [
    "const fs = require('node:fs');",
    "const stdin = fs.readFileSync(0, 'utf8');",
    `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({`,
    '  argv: process.argv.slice(1), cwd: process.cwd(), home: process.env.HOME ?? null, stdin,',
    '}));',
    "process.stdout.write('recorded');",
  ].join('');
}

type Seat = 'planner' | 'reviewer' | 'implementer';
type CommandKind = 'shell' | 'agent';

type Received = Readonly<{ argv: string[]; cwd: string; home: string | null; stdin: string }>;

const CONFIG_SEATS: ReadonlyArray<readonly [Seat, CommandKind]> = [
  ['planner', 'shell'],
  ['planner', 'agent'],
  ['reviewer', 'shell'],
  ['reviewer', 'agent'],
  ['implementer', 'shell'],
  ['implementer', 'agent'],
];

// Implementer call events go to the run publisher, not to a callback, so only these seats report here.
const REVIEW_SEATS = CONFIG_SEATS.filter(([seat]) => seat !== 'implementer');

/**
 * The seat's config is spread over a parsed config on purpose: config load refuses `{prompt}` in
 * `args`, and this pins that the runner itself never reads `{prompt}` as a placeholder.
 */
function configFor(seat: Seat, runner: Record<string, unknown>): Config {
  const base = makeConfig();
  if (seat === 'implementer') {
    return { ...base, implementer: { ...runner, model: 'test' } as Config['implementer'] };
  }
  if (seat === 'reviewer') {
    return { ...base, reviewer: runner as NonNullable<Config['reviewer']> };
  }
  return { ...base, planner: runner as Config['planner'] };
}

function authorityFor<S extends RunnerSlot>(
  config: Config,
  slot: S,
  runner: RunnerConfig,
): RunnerFactoryAuthority & { slot: S } {
  const preparationId = `prompt-stdin-${slot.role}`;
  return {
    preparedConfig: config,
    preparationId,
    slot,
    gates: [makeRunnerGate(runner, slot, preparationId)],
  };
}

async function callSeat(
  seat: Seat,
  config: Config,
  projectDir: string,
  prompt: string,
  onCallEvent?: (event: RunnerCallEvent) => void,
): Promise<unknown> {
  const callbacks = { onOutput: () => {}, ...(onCallEvent && { onCallEvent }) };
  if (seat === 'planner') {
    const planner = await createPlanner(
      config,
      authorityFor(config, { role: 'planner' }, config.planner),
    );
    return planner.review(prompt, projectDir, callbacks);
  }
  if (seat === 'reviewer') {
    const reviewer = await createReviewer(
      config,
      authorityFor(config, { role: 'reviewer' }, resolveReviewerRunner(config).runner),
    );
    return reviewer.review(prompt, projectDir, callbacks);
  }
  const profile = resolveImplementerProfiles(config).defaultProfile.name;
  const implementer = await createImplementer(
    config,
    authorityFor(config, { role: 'implementer', profile }, config.implementer),
  );
  return implementer.implement({
    task: makeTask({ description: prompt }),
    projectDir,
    config,
    context: { ...defaultContext, dir: projectDir },
    onOutput: () => {},
    ...(onCallEvent && { onCallEvent }),
  });
}

function settle(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    (value) => value,
    (cause: unknown) => cause,
  );
}

function describeOutcome(outcome: unknown): string {
  if (outcome instanceof Error) return `the call failed before the child ran: ${outcome.message}`;
  return `the child left no record; the call returned ${JSON.stringify(outcome)?.slice(0, 400)}`;
}

function readReceived(recordPath: string, outcome: unknown): Received {
  expect(existsSync(recordPath), describeOutcome(outcome)).toBe(true);
  return JSON.parse(readFileSync(recordPath, 'utf8')) as Received;
}

function expectWholePrompt(received: Received, prompt: string): void {
  expect(received.stdin.includes(prompt), 'the child stdin holds the whole prompt').toBe(true);
  expect(Buffer.byteLength(received.stdin, 'utf8')).toBeGreaterThanOrEqual(
    Buffer.byteLength(prompt, 'utf8'),
  );
}

describe('a shell or agent seat built from config', () => {
  it.each(CONFIG_SEATS)(
    'gives the %s %s command the whole prompt on stdin and its configured args unchanged',
    async (seat, kind) => {
      const projectDir = createTempDir(`prompt-stdin-${seat}-${kind}`);
      const recordDir = createTempDir(`prompt-stdin-${seat}-${kind}-record`);
      try {
        const recordPath = join(recordDir, 'received.json');
        const config = configFor(seat, {
          kind,
          command: process.execPath,
          args: ['-e', recordScript(recordPath), '{prompt}'],
          outputFormat: 'text',
        });

        const outcome = await settle(callSeat(seat, config, projectDir, LARGE_PROMPT));
        const received = readReceived(recordPath, outcome);

        expect(received.argv).toEqual(['{prompt}']);
        expectWholePrompt(received, LARGE_PROMPT);
      } finally {
        cleanupTempDir(projectDir);
        cleanupTempDir(recordDir);
      }
    },
    60_000,
  );

  it.each(CONFIG_SEATS)(
    'runs the %s %s command in the project directory with a private HOME',
    async (seat, kind) => {
      const projectDir = createTempDir(`prompt-cwd-${seat}-${kind}`);
      const recordDir = createTempDir(`prompt-cwd-${seat}-${kind}-record`);
      try {
        const recordPath = join(recordDir, 'received.json');
        const config = configFor(seat, {
          kind,
          command: process.execPath,
          args: ['-e', recordScript(recordPath)],
          outputFormat: 'text',
        });

        const outcome = await settle(callSeat(seat, config, projectDir, 'small prompt'));
        const received = readReceived(recordPath, outcome);

        expect(received.cwd).toBe(realpathSync(projectDir));
        expect(received.home).not.toBeNull();
        expect(received.home).not.toBe(process.env.HOME);
      } finally {
        cleanupTempDir(projectDir);
        cleanupTempDir(recordDir);
      }
    },
  );

  it.each(REVIEW_SEATS)(
    'labels the %s %s call with its backend kind and command',
    async (seat, kind) => {
      const projectDir = createTempDir(`prompt-label-${seat}-${kind}`);
      const recordDir = createTempDir(`prompt-label-${seat}-${kind}-record`);
      try {
        const recordPath = join(recordDir, 'received.json');
        const config = configFor(seat, {
          kind,
          command: process.execPath,
          args: ['-e', recordScript(recordPath)],
          outputFormat: 'text',
        });
        const events: RunnerCallEvent[] = [];

        await settle(callSeat(seat, config, projectDir, 'small prompt', (e) => events.push(e)));

        expect(events.find((event) => event.type === 'call_started')).toMatchObject({
          backendKind: kind,
          runnerName: process.execPath,
        });
      } finally {
        cleanupTempDir(projectDir);
        cleanupTempDir(recordDir);
      }
    },
  );

  it.each([
    ['planner', 'shell', 'Shell planner command not found: splitbrief-c2-missing-command'],
    ['planner', 'agent', 'Agent planner command not found: splitbrief-c2-missing-command'],
    ['reviewer', 'shell', 'Shell planner command not found: splitbrief-c2-missing-command'],
    ['reviewer', 'agent', 'Agent planner command not found: splitbrief-c2-missing-command'],
    ['implementer', 'shell', 'Shell implementer command not found: splitbrief-c2-missing-command'],
    ['implementer', 'agent', 'Agent implementer command not found: splitbrief-c2-missing-command'],
  ] as const)('names the missing %s %s command', async (seat, kind, message) => {
    const projectDir = createTempDir(`prompt-missing-${seat}-${kind}`);
    try {
      const config = configFor(seat, {
        kind,
        command: 'splitbrief-c2-missing-command',
        outputFormat: 'text',
      });

      const outcome = await settle(callSeat(seat, config, projectDir, 'small prompt'));

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(message);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('an admitted custom command', () => {
  const plannerFixtures = createCommandInvokeTestFixtures();
  const implementerFixtures = createConfiguredImplementerFixtures();

  it('gives a planner command the whole prompt on stdin past 1 MiB', async () => {
    const { projectDir, stateDir } = plannerFixtures.testProject('admitted-planner-stdin');
    const recordDir = createTempDir('admitted-planner-stdin-record');
    plannerFixtures.trackDirectories(recordDir);
    const recordPath = join(recordDir, 'received.json');
    const custom = configuredPlanner({ contract: 'output', script: recordScript(recordPath) });
    const runtime = runtimeFor({ projectDir, stateDir });
    const admission = await prepareCustomRunnerAdmission({
      ...runtime.admission,
      projectDir: runtime.authorizationProjectDir,
      runner: custom,
      posture: customRunnerSecurityPosture('planner', custom.command.contract),
      phase: 'planning',
      authorizationPathEnv: runtime.authorizationPathEnv ?? '',
      authorizationPathExt: runtime.authorizationPathExt ?? '',
    });
    if (admission.kind !== 'admitted') throw new Error('the planner command was not admitted');
    const planner = createConfiguredCustomPlanner(custom, runtime, admission.invocation);

    const outcome = await settle(planner.review(LARGE_PROMPT, projectDir, { onOutput: () => {} }));
    const received = readReceived(recordPath, outcome);

    expect(received.argv).toEqual([]);
    expectWholePrompt(received, LARGE_PROMPT);
  }, 60_000);

  it('gives an implementer command the whole prompt on stdin past 1 MiB', async () => {
    const projectDir = implementerFixtures.projectDirectory('admitted-implementer-stdin');
    const recordDir = implementerFixtures.temporaryDirectory('admitted-implementer-stdin-record');
    const recordPath = join(recordDir, 'received.json');
    const harness = implementerFixtures.runtimeHarness(projectDir, { sourceEnv: {} });
    const implementer = await createConfiguredCustomImplementer({
      runner: configuredRunner({ argv: ['-e', recordScript(recordPath)] }),
      runtime: harness.runtime,
    });

    const outcome = await settle(
      implementer.implement({
        task: makeTask({ description: LARGE_PROMPT, suggestedFiles: ['src/a.ts'] }),
        projectDir,
        config: makeConfig(),
        context: { ...defaultContext, dir: projectDir },
        onOutput: () => {},
      }),
    );
    const received = readReceived(recordPath, outcome);

    expect(received.argv).toEqual([]);
    expectWholePrompt(received, LARGE_PROMPT);
  }, 60_000);
});
