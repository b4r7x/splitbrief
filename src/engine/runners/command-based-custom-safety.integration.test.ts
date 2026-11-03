import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectRunnerCallEvents } from '../calls/event-projection.js';
import { runnerCallLogEntry } from '#testing/helpers/runner-call-events.js';
import { boundEngineEventForConsumer } from '../events/bound.js';
import {
  admittedCustomRunner,
  customRunner,
  invokeCustomRunner,
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

describe('custom command runner safety', () => {
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
        projectRunnerCallEvents(event, {
          rootDir: process.cwd(),
          phase: 'planning',
          sequence: index + 1,
        }),
      )
      .map((event) => boundEngineEventForConsumer(event, 'tui'));
    const sessionLogProjection = observation.events.map((event, index) =>
      runnerCallLogEntry(event, {
        rootDir: process.cwd(),
        phase: 'planning',
        sequence: index + 1,
      }),
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
        error: expect.objectContaining({ code: 'no-progress-cut' }),
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

  it('keeps a stdout line above 1 MiB whole and redacts the line before it', async () => {
    const canary = 'output-budget-value-canary-3ef9';
    const observation = await observeCustomInvocation({
      admission: await admittedCustomRunner(
        process.cwd(),
        customRunner({
          argv: [
            '-e',
            `process.stdout.write("secret-" + process.env.CUSTOM_PUBLIC_VALUE + "\\n");process.stdout.write("x".repeat(${1024 * 1024} + 1) + "\\n");`,
          ],
          env: ['CUSTOM_PUBLIC_VALUE'],
        }),
      ),
      prompt: '',
      authorizationProjectDir: process.cwd(),
      cwd: process.cwd(),
      sourceEnv: { CUSTOM_PUBLIC_VALUE: canary },
    });

    expect(observation.failure).toBeUndefined();
    expect(observation.result).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(observation.result).includes(`${'x'.repeat(1024 * 1024 + 1)}\\n`)).toBe(
      true,
    );
    expect(
      observation.events.filter(
        (event) => event.type === 'call_warning' && event.warning.surface !== 'debug',
      ),
    ).toEqual([]);
    expectNoDeclaredValues(observation, [canary]);
  });

  it('fails missing, blocked and oversized environment preflight before spawn', async () => {
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
        invokeCustomRunner({
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
        invokeCustomRunner({
          ...options,
          admission: await admittedCustomRunner(projectDir, customRunner({ argv, env: ['PATH'] })),
          sourceEnv: { PATH: '/host/bin' },
          prompt: 'normal prompt',
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-environment-blocked' });
      await expect(
        invokeCustomRunner({
          ...options,
          admission: await admittedCustomRunner(
            projectDir,
            customRunner({ argv, env: ['CUSTOM_LARGE_VALUE'] }),
          ),
          sourceEnv: { CUSTOM_LARGE_VALUE: 'x'.repeat(256 * 1024 + 1) },
          prompt: 'normal prompt',
        }),
      ).rejects.toMatchObject({ kind: 'custom-runner-environment-too-large' });
      expect(existsSync(sentinel)).toBe(false);
    });
  });
});
