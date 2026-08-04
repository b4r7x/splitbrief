import { describe, expect, it } from 'vitest';
import { matches } from '../../utils/error.js';
import {
  CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE,
  createCustomRunnerRedactor,
  createCustomRunnerStreamingRedactor,
  createCustomRunnerToolInputRedactor,
  customRunnerToolInputStateLimitError,
  redactCustomRunnerParsedLine,
  resolveCustomRunnerEnvironment,
} from './redaction.js';
import type { ParsedLine } from './types.js';

function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to throw');
}

describe('custom runner environment and redaction boundary', () => {
  it('keeps only runtime values and explicitly declared environment references', () => {
    const publicValue = 'custom-public-value-canary-47b8';
    const environment = resolveCustomRunnerEnvironment(
      {
        LANG: 'C.UTF-8',
        CUSTOM_PUBLIC_VALUE: publicValue,
        UNDECLARED_AMBIENT: 'ambient-canary',
        PATH: '/host/bin',
        HOME: '/host/home',
        NODE_OPTIONS: '--require=/host/loader.js',
      },
      ['CUSTOM_PUBLIC_VALUE'],
    );

    expect(environment.env).toEqual({ LANG: 'C.UTF-8', CUSTOM_PUBLIC_VALUE: publicValue });
    expect(environment.redactionValues).toEqual([publicValue]);
  });

  it('fails closed with stable typed errors without exposing declared values', () => {
    const missing = captureThrown(() => resolveCustomRunnerEnvironment({}, ['MISSING_VALUE']));
    expect(matches('custom-runner-environment-missing')(missing)).toBe(true);
    expect(missing).toMatchObject({
      kind: 'custom-runner-environment-missing',
      message: 'Custom runner environment reference is not set: MISSING_VALUE',
      data: { name: 'MISSING_VALUE' },
    });

    const blocked = captureThrown(() =>
      resolveCustomRunnerEnvironment({ PATH: '/host/bin' }, ['PATH']),
    );
    expect(matches('custom-runner-environment-blocked')(blocked)).toBe(true);
    expect(blocked).toMatchObject({
      kind: 'custom-runner-environment-blocked',
      message: 'Custom runner environment reference is blocked: PATH',
      data: { name: 'PATH' },
    });

    const duplicate = captureThrown(() =>
      resolveCustomRunnerEnvironment({ CUSTOM_PUBLIC_VALUE: 'present' }, [
        'CUSTOM_PUBLIC_VALUE',
        'CUSTOM_PUBLIC_VALUE',
      ]),
    );
    expect(matches('custom-runner-environment-duplicate')(duplicate)).toBe(true);
    expect(duplicate).toMatchObject({
      kind: 'custom-runner-environment-duplicate',
      message: 'Custom runner environment reference is duplicated: CUSTOM_PUBLIC_VALUE',
      data: { name: 'CUSTOM_PUBLIC_VALUE' },
    });

    const declaredValue = `oversized-declared-value-canary-${'x'.repeat(256 * 1024)}`;
    const tooLarge = captureThrown(() =>
      resolveCustomRunnerEnvironment({ CUSTOM_PUBLIC_VALUE: declaredValue }, [
        'CUSTOM_PUBLIC_VALUE',
      ]),
    );
    expect(matches('custom-runner-environment-too-large')(tooLarge)).toBe(true);
    expect(tooLarge).toMatchObject({
      kind: 'custom-runner-environment-too-large',
      message: 'Custom runner declared environment exceeds 262144 bytes.',
      data: { maxBytes: 256 * 1024 },
    });
    expect(
      JSON.stringify(
        tooLarge instanceof Error
          ? { message: tooLarge.message, enumerable: Object.fromEntries(Object.entries(tooLarge)) }
          : tooLarge,
      ),
    ).not.toContain(declaredValue);
  });

  it('redacts overlapping declared values and values that collide with a redaction marker', () => {
    const shortValue = 'marker-collision';
    const longValue = 'marker-collision-with-overlap';
    const markerValue = 'REDACTED';
    const fullMarkerValue = '***REDACTED***';
    const redact = createCustomRunnerRedactor([
      shortValue,
      longValue,
      markerValue,
      fullMarkerValue,
    ]);

    const observed = redact(
      `short=${shortValue}; long=${longValue}; marker=${markerValue}; full=${fullMarkerValue}`,
    );

    for (const value of [shortValue, longValue, markerValue, fullMarkerValue]) {
      expect(observed).not.toContain(value);
    }
  });

  it('redacts overlapping and marker-colliding values split across streamed chunks', () => {
    const shortValue = 'edge-overlap';
    const longValue = 'prefix-edge-overlap-suffix';
    const markerValue = 'REDACTED';
    const redact = createCustomRunnerRedactor([shortValue, longValue, markerValue]);
    const stream = createCustomRunnerStreamingRedactor(redact);

    const observed = [
      stream.push('before:prefix-edge'),
      stream.push('-overlap-suffix|between:edge-'),
      stream.push('overlap|marker:RED'),
      stream.push('ACTED:after'),
      stream.flush(),
    ].join('');

    expect(observed).toBe('before:|between:|marker::after');
    for (const value of [shortValue, longValue, markerValue]) {
      expect(observed).not.toContain(value);
    }
  });

  it('redacts every occurrence of non-credential declared values in parsed output', () => {
    const canary = 'custom-public-value-canary-3f1a';
    const markerCollision = 'REDACTED';
    const redact = createCustomRunnerRedactor([canary, markerCollision]);
    const parsed: ParsedLine = {
      text: `result ${canary} ${markerCollision}`,
      sessionId: `session-${canary}`,
      toolUse: [
        {
          id: `tool-${canary}`,
          name: `name-${canary}`,
          input: { [`input-${canary}`]: canary },
          output: { nested: [canary] },
        },
      ],
      warning: [
        {
          code: `warning-${canary}`,
          message: `message ${canary}`,
          source: canary,
          parser: canary,
          upstreamType: canary,
          fingerprint: canary,
          rawRef: canary,
        },
      ],
    };

    const redacted = redactCustomRunnerParsedLine(parsed, redact);

    expect(JSON.stringify(redacted)).not.toContain(canary);
    expect(JSON.stringify(redacted)).not.toContain(markerCollision);
  });

  it('redacts fragmented structured tool input independently per tool and flushes before a result', () => {
    const canary = 'qz-tool-input-fragment-canary-4df2';
    const redact = createCustomRunnerRedactor([canary]);
    const toolInput = createCustomRunnerToolInputRedactor(redact);

    const observed = [
      ...toolInput.apply({
        toolUseDelta: [{ id: 'content-block-0', inputDelta: `{"token":"${canary.slice(0, 12)}` }],
      }),
      ...toolInput.apply({
        toolUseDelta: [{ id: 'content-block-1', inputDelta: '{"path":"src/app.ts"}' }],
      }),
      ...toolInput.apply({
        toolUseDelta: [{ id: 'content-block-0', inputDelta: `${canary.slice(12)}"}` }],
      }),
      ...toolInput.apply({ text: 'done', channel: 'result', isResult: true }),
    ];

    expect(observed.flatMap((line) => line.toolUseDelta ?? []).map((delta) => delta.id)).toEqual([
      'content-block-0',
      'content-block-1',
      'content-block-0',
    ]);
    expect(observed.at(-1)).toEqual({ text: 'done', channel: 'result', isResult: true });
    expect(JSON.stringify(observed)).not.toContain(canary);
    expect(JSON.stringify(observed)).toContain('src/app.ts');
  });

  it('flushes a retained tool fragment before an error without changing the error record', () => {
    const canary = 'tool-input-error-canary-14c8';
    const redact = createCustomRunnerRedactor([canary]);
    const toolInput = createCustomRunnerToolInputRedactor(redact);
    const error: ParsedLine = {
      isError: true,
      warning: [{ code: 'failed', message: 'runner failed' }],
    };

    const observed = [
      ...toolInput.apply({
        toolUseDelta: [{ id: 'content-block-2', inputDelta: canary.slice(0, 10) }],
      }),
      ...toolInput.apply(error),
    ];

    expect(observed.at(-1)).toEqual(error);
    expect(observed[0]?.toolUseDelta?.[0]?.id).toBe('content-block-2');
    expect(JSON.stringify(observed)).not.toContain(canary);
    expect(JSON.stringify(observed)).not.toContain(canary.slice(0, 10));
  });

  it('releases completed IDs for reuse but fails closed instead of evicting active input state', () => {
    const canary = 'tool-input-capacity-canary-18b4';
    const prefix = canary.slice(0, 'tool-input-capacity-'.length);
    const redact = createCustomRunnerRedactor([canary]);
    const toolInput = createCustomRunnerToolInputRedactor(redact);

    for (let index = 0; index < CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE; index += 1) {
      toolInput.apply({
        toolUseDelta: [{ id: `tool-${index}`, inputDelta: `{"value":"${prefix}` }],
      });
    }

    const completed = toolInput.apply({
      toolUseDone: [{ id: 'tool-0', name: 'Write', input: {} }],
    });
    expect(toolInput.hasExceededCapacity()).toBe(false);
    expect(completed).toContainEqual(
      expect.objectContaining({ toolUseDone: [{ id: 'tool-0', name: 'Write', input: {} }] }),
    );

    expect(
      toolInput.apply({
        toolUseDelta: [{ id: 'tool-0', inputDelta: `{"value":"${prefix}` }],
      }),
    ).not.toEqual([]);
    expect(toolInput.hasExceededCapacity()).toBe(false);

    expect(
      toolInput.apply({
        toolUseDelta: [{ id: 'tool-overflow', inputDelta: `{"value":"${prefix}` }],
      }),
    ).toEqual([]);
    expect(toolInput.hasExceededCapacity()).toBe(true);
    expect(
      toolInput.apply({
        toolUseDelta: [{ id: 'tool-0', inputDelta: `${canary.slice(prefix.length)}"}` }],
      }),
    ).toEqual([]);
    expect(toolInput.flush()).toEqual([]);

    const stateLimit = customRunnerToolInputStateLimitError();
    expect(matches('custom-runner-tool-input-state-limit')(stateLimit)).toBe(true);
    expect(stateLimit).toMatchObject({
      kind: 'custom-runner-tool-input-state-limit',
      message:
        'Custom runner exceeded 128 concurrent tool-input streams; collection stopped to protect redacted output.',
      data: { maxActive: CUSTOM_RUNNER_TOOL_INPUT_MAX_ACTIVE },
    });
  });
});
