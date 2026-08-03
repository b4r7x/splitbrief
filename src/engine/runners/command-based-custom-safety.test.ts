import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import { runnerCallEventToSessionLogEntry } from '../calls/session-log.js';
import { protectEngineEventForConsumer } from '../events/protection/protect.js';
import { invokeCustomCommandBasedRunner } from './command-based.js';
import {
  admittedCustomRunner,
  customRunner,
  observableFailure,
  observeCustomInvocation,
  type CustomInvocationObservation,
} from '#testing/helpers/custom-command-based.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';

function expectNoDeclaredValues(
  observation: CustomInvocationObservation,
  declaredValues: readonly string[],
): void {
  const joinedCallbacks = [
    observation.callbacks.output.join(''),
    observation.callbacks.stderr.join(''),
    observation.callbacks.session.join(''),
  ].join('');
  const observed = JSON.stringify({
    callbacks: observation.callbacks,
    result: observation.result,
    events: observation.events,
    failure: observableFailure(observation.failure),
  });

  for (const value of declaredValues) {
    expect(joinedCallbacks).not.toContain(value);
    expect(observed).not.toContain(value);
  }
}

describe('invokeCustomCommandBasedRunner safety', () => {
  it('redacts split overlapping and marker-colliding declared values before success callbacks, results, and events', async () => {
    const shortValue = 'edge-overlap';
    const longValue = 'prefix-edge-overlap-suffix';
    const markerValue = 'REDACTED';
    const script = [
      'const shortValue = process.env.CUSTOM_SHORT_VALUE;',
      'const longValue = process.env.CUSTOM_LONG_VALUE;',
      'const markerValue = process.env.CUSTOM_MARKER_VALUE;',
      'process.stdout.write(JSON.stringify({',
      '  type: "assistant",',
      '  session_id: "session-" + longValue,',
      '  message: { content: [',
      '    { type: "text", text: "assistant-" + shortValue + "-" + longValue + "-" + markerValue },',
      '    { type: "tool_use", id: "tool-" + longValue, name: "name-" + markerValue, input: { value: shortValue } },',
      '  ] },',
      '}) + "\\n");',
      'process.stdout.write(JSON.stringify({ type: "result", result: "result-" + markerValue, session_id: "session-" + longValue }) + "\\n");',
      'process.stderr.write("stderr-" + longValue.slice(0, 10));',
      'setTimeout(() => process.stderr.write(longValue.slice(10) + "|" + shortValue + "|" + markerValue + "\\n"), 25);',
    ].join('\n');

    const observation = await observeCustomInvocation({
      admission: await admittedCustomRunner(
        process.cwd(),
        customRunner({
          argv: ['-e', script],
          env: ['CUSTOM_LONG_VALUE', 'CUSTOM_MARKER_VALUE', 'CUSTOM_SHORT_VALUE'],
          outputFormat: 'stream-json',
        }),
      ),
      prompt: '',
      authorizationProjectDir: process.cwd(),
      cwd: process.cwd(),
      sourceEnv: {
        CUSTOM_SHORT_VALUE: shortValue,
        CUSTOM_LONG_VALUE: longValue,
        CUSTOM_MARKER_VALUE: markerValue,
      },
    });

    expect(observation.result).toMatchObject({ status: 'completed' });
    expect(observation.failure).toBeUndefined();
    expect(observation.callbacks.stderr).toHaveLength(2);
    expectNoDeclaredValues(observation, [shortValue, longValue, markerValue]);
  });

  it('redacts a declared value split across structured stdout messages before every controlled projection', async () => {
    const canary = 'split-stdout-canary-9274';
    const script = [
      'const value = process.env.CUSTOM_PUBLIC_VALUE;',
      'for (const text of [value.slice(0, 10), value.slice(10)]) {',
      '  process.stdout.write(JSON.stringify({',
      '    type: "assistant",',
      '    message: { content: [{ type: "text", text }] },',
      '  }) + "\\n");',
      '}',
    ].join('\n');
    const observation = await observeCustomInvocation({
      admission: await admittedCustomRunner(
        process.cwd(),
        customRunner({
          argv: ['-e', script],
          env: ['CUSTOM_PUBLIC_VALUE'],
          outputFormat: 'stream-json',
        }),
      ),
      prompt: '',
      authorizationProjectDir: process.cwd(),
      cwd: process.cwd(),
      sourceEnv: { CUSTOM_PUBLIC_VALUE: canary },
    });
    const protectedProjection = observation.events
      .flatMap((event, index) =>
        projectRunnerCallEvents(event, { phase: 'planning', sequence: index + 1 }),
      )
      .map((event) =>
        protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: true }),
      );
    const sessionLogProjection = observation.events.map((event, index) =>
      runnerCallEventToSessionLogEntry(event, { phase: 'planning', sequence: index + 1 }),
    );

    expect(observation.failure).toBeUndefined();
    expect(observation.callbacks.output.join('')).not.toContain(canary);
    expect(observation.result).toMatchObject({
      status: 'completed',
      text: expect.not.stringContaining(canary),
    });
    expect(JSON.stringify(observation.events)).not.toContain(canary);
    expect(JSON.stringify(protectedProjection)).not.toContain(canary);
    expect(JSON.stringify(sessionLogProjection)).not.toContain(canary);
  });

  it('redacts declared values from nonzero exits, including enumerable error data', async () => {
    const canary = 'nonzero-custom-value-canary-6d82';
    const script = [
      'const canary = process.env.CUSTOM_PUBLIC_VALUE;',
      'process.stdout.write(JSON.stringify({ type: "assistant", session_id: "session-" + canary, message: { content: [{ type: "text", text: "output-" + canary }] } }) + "\\n");',
      'process.stderr.write("stderr-" + canary + "\\n");',
      'process.exit(2);',
    ].join('\n');

    const observation = await observeCustomInvocation({
      admission: await admittedCustomRunner(
        process.cwd(),
        customRunner({
          argv: ['-e', script],
          env: ['CUSTOM_PUBLIC_VALUE'],
          outputFormat: 'stream-json',
        }),
      ),
      prompt: '',
      authorizationProjectDir: process.cwd(),
      cwd: process.cwd(),
      sourceEnv: { CUSTOM_PUBLIC_VALUE: canary },
    });

    expect(observation.result).toBeUndefined();
    expect(observation.failure).toMatchObject({ kind: 'process-output' });
    expect(observation.events).toContainEqual(
      expect.objectContaining({ type: 'call_error', status: 'failed' }),
    );
    expectNoDeclaredValues(observation, [canary]);
  });

  it('redacts declared values before reporting an idle-killed custom process', async () => {
    const canary = 'idle-custom-value-canary-1ba4';
    const observation = await observeCustomInvocation({
      admission: await admittedCustomRunner(
        process.cwd(),
        customRunner({
          argv: [
            '-e',
            'process.stderr.write("idle-" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");setInterval(() => {}, 60_000);',
          ],
          env: ['CUSTOM_PUBLIC_VALUE'],
          idleWarnMs: 100,
          idleKillMs: 250,
        }),
      ),
      prompt: '',
      authorizationProjectDir: process.cwd(),
      cwd: process.cwd(),
      sourceEnv: { CUSTOM_PUBLIC_VALUE: canary },
    });

    expect(observation.result).toBeUndefined();
    expect(observation.failure).toMatchObject({ kind: 'command-idle-timeout' });
    expect(observation.events).toContainEqual(
      expect.objectContaining({
        type: 'call_error',
        status: 'failed',
        error: expect.objectContaining({ code: 'runner_idle_timeout' }),
      }),
    );
    expectNoDeclaredValues(observation, [canary]);
  });

  it('keeps an external TimeoutError abort classified as aborted and redacted', async () => {
    const canary = 'external-custom-value-canary-2f7c';
    const controller = new AbortController();
    let aborted = false;
    const observation = await observeCustomInvocation(
      {
        admission: await admittedCustomRunner(
          process.cwd(),
          customRunner({
            argv: [
              '-e',
              'process.stdout.write("external-" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");setInterval(() => {}, 60_000);',
            ],
            env: ['CUSTOM_PUBLIC_VALUE'],
          }),
        ),
        prompt: '',
        authorizationProjectDir: process.cwd(),
        cwd: process.cwd(),
        sourceEnv: { CUSTOM_PUBLIC_VALUE: canary },
        signal: controller.signal,
      },
      (kind) => {
        if (kind !== 'output' || aborted) return;
        aborted = true;
        controller.abort(new DOMException(`external-${canary}`, 'TimeoutError'));
      },
    );

    expect(aborted).toBe(true);
    expect(observation.result).toBeUndefined();
    expect(observation.events).toContainEqual(
      expect.objectContaining({ type: 'call_error', status: 'aborted' }),
    );
    expectNoDeclaredValues(observation, [canary]);
  });

  it('treats default stdout, stderr, line, and combined output limits as fatal', async () => {
    const canary = 'output-budget-value-canary-3ef9';
    const scenarios = [
      {
        name: 'stdout',
        script:
          'process.stdout.write("secret-" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");process.stdout.write("\\n".repeat(1024 * 1024 + 1));',
        code: /^runner_process_output_limit$/,
      },
      {
        name: 'stderr',
        script:
          'process.stderr.write("secret-" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");process.stderr.write("\\n".repeat(256 * 1024 + 1));',
        code: /^runner_process_output_limit$/,
      },
      {
        name: 'line',
        script:
          'process.stdout.write("secret-" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");process.stdout.write("x".repeat(1024 * 1024 + 1));',
        code: /^(?:stdout_line_overflow|runner_process_output_limit)$/,
      },
      {
        name: 'combined',
        script:
          'process.stdout.write("\\n".repeat(1024 * 1024));process.stderr.write("\\n".repeat(256 * 1024));',
        code: /^runner_process_output_limit$/,
      },
    ] as const;

    for (const scenario of scenarios) {
      const observation = await observeCustomInvocation({
        admission: await admittedCustomRunner(
          process.cwd(),
          customRunner({ argv: ['-e', scenario.script], env: ['CUSTOM_PUBLIC_VALUE'] }),
        ),
        prompt: '',
        authorizationProjectDir: process.cwd(),
        cwd: process.cwd(),
        sourceEnv: { CUSTOM_PUBLIC_VALUE: canary },
      });

      expect(observation.failure, scenario.name).toBeUndefined();
      expect(observation.result, scenario.name).toMatchObject({
        status: 'truncated',
        error: { code: expect.stringMatching(scenario.code) },
      });
      expectNoDeclaredValues(observation, [canary]);
    }
  });

  it('reaps an output-limited custom child before its delayed side effect can run', {
    timeout: 30_000,
  }, async () => {
    await withTempDir('custom runner output limit cleanup', async (projectDir) => {
      const delayedEffect = join(projectDir, 'late-child-effect');
      const observation = await observeCustomInvocation({
        admission: await admittedCustomRunner(
          projectDir,
          customRunner({
            argv: [
              '-e',
              [
                'const fs = require("node:fs");',
                "process.stdout.write('x'.repeat(1_400_000));",
                `setTimeout(() => fs.writeFileSync(${JSON.stringify(delayedEffect)}, "late"), 1_000);`,
                'setInterval(() => undefined, 1_000);',
              ].join(''),
            ],
          }),
        ),
        prompt: '',
        authorizationProjectDir: projectDir,
        cwd: projectDir,
        sourceEnv: {},
      });

      expect(observation.failure).toBeUndefined();
      expect(observation.result).toMatchObject({
        status: 'truncated',
        error: {
          code: expect.stringMatching(/^(?:stdout_line_overflow|runner_process_output_limit)$/),
        },
      });
      expect(existsSync(delayedEffect)).toBe(false);
    });
  });

  it('fails missing, blocked, oversized environment and oversized prompt preflight before spawn', async () => {
    await withTempDir('splitbrief custom preflight', async (projectDir) => {
      const sentinel = join(projectDir, 'should-not-exist');
      const argv = [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'spawned')`,
      ];
      const options = {
        authorizationProjectDir: projectDir,
        cwd: projectDir,
      };

      await expect(
        invokeCustomCommandBasedRunner({
          ...options,
          admission: await admittedCustomRunner(
            projectDir,
            customRunner({ argv, env: ['CUSTOM_MISSING_VALUE'] }),
          ),
          sourceEnv: {},
          prompt: 'normal prompt',
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-environment-missing' });
      await expect(
        invokeCustomCommandBasedRunner({
          ...options,
          admission: await admittedCustomRunner(projectDir, customRunner({ argv, env: ['PATH'] })),
          sourceEnv: { PATH: '/host/bin' },
          prompt: 'normal prompt',
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-environment-blocked' });
      await expect(
        invokeCustomCommandBasedRunner({
          ...options,
          admission: await admittedCustomRunner(
            projectDir,
            customRunner({ argv, env: ['CUSTOM_LARGE_VALUE'] }),
          ),
          sourceEnv: { CUSTOM_LARGE_VALUE: 'x'.repeat(256 * 1024 + 1) },
          prompt: 'normal prompt',
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-environment-too-large' });
      await expect(
        invokeCustomCommandBasedRunner({
          ...options,
          admission: await admittedCustomRunner(projectDir, customRunner({ argv })),
          sourceEnv: {},
          prompt: 'x'.repeat(1024 * 1024 + 1),
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-prompt-too-large' });
      expect(existsSync(sentinel)).toBe(false);
    });
  });
});
