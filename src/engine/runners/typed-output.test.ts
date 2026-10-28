import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TypedOutputCapability } from '../../core/runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../../core/runners/seat-roles.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { RunnerCallResult } from '../calls/types.js';
import {
  extractLastJsonObject,
  fallbackInstruction,
  requestTyped,
  type RequestTypedOptions,
  type RequestTypedResult,
  type SeatProtocolError,
  type TypedSeatCall,
  seatProtocolHeadline,
  typedOutputError,
} from './typed-output.js';

const probeSchema = z.object({ answer: z.string(), count: z.number() });
type Probe = z.infer<typeof probeSchema>;

const jsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' }, count: { type: 'number' } },
  required: ['answer', 'count'],
  additionalProperties: false,
};

type InvokeInput = Parameters<TypedSeatCall['invoke']>[0];

function makeSeatCall(input: {
  seat?: ActiveRunnerRole;
  typedOutput: TypedOutputCapability;
  canResume?: boolean;
  results: readonly RunnerCallResult[];
}): { call: TypedSeatCall; invokes: InvokeInput[] } {
  const invokes: InvokeInput[] = [];
  const call: TypedSeatCall = {
    seat: input.seat ?? 'planner',
    typedOutput: input.typedOutput,
    canResume: input.canResume ?? false,
    invoke: (invokeInput) => {
      invokes.push(invokeInput);
      const result = input.results[invokes.length - 1];
      if (result === undefined) throw new Error('The call stub ran out of results.');
      return Promise.resolve(result);
    },
  };
  return { call, invokes };
}

function options(overrides: { call: TypedSeatCall; prompt?: string }): RequestTypedOptions<Probe> {
  return {
    prompt: overrides.prompt ?? 'Answer the question',
    schema: probeSchema,
    jsonSchema,
    schemaName: 'probe',
    call: overrides.call,
  };
}

function completed(text: string, usage: RunnerCallResult['usage'] = null): RunnerCallResult {
  return makeRunnerCallResult({ status: 'completed', text, usage });
}

function expectValue(
  result: RequestTypedResult<Probe>,
): Extract<RequestTypedResult<Probe>, { value: Probe }> {
  if ('error' in result) throw new Error(`Expected a value, got ${result.error.message}`);
  return result;
}

function expectError(result: RequestTypedResult<Probe>): SeatProtocolError {
  if (!('error' in result)) throw new Error('Expected a seat protocol error');
  return result.error;
}

describe('seatProtocolHeadline', () => {
  it.each([
    [1, 'The implementer seat answer did not match its contract after 1 attempt.'],
    [2, 'The implementer seat answer did not match its contract after 2 attempts.'],
  ] as const)('counts %i attempt in words', (attempts, headline) => {
    expect(seatProtocolHeadline({ seat: 'implementer', attempts })).toBe(headline);
  });
});

describe('typedOutputError.seatProtocol', () => {
  it.each([
    [
      1,
      ['answer: Required'],
      'The implementer seat answer did not match its contract after 1 attempt. answer: Required.',
    ],
    [
      2,
      ['answer: Required', 'count: Expected number, received string'],
      'The implementer seat answer did not match its contract after 2 attempts. answer: Required. count: Expected number, received string.',
    ],
  ] as const)('counts %i attempt in words', (attempts, errors, message) => {
    const err = typedOutputError.seatProtocol({
      seat: 'implementer',
      attempts,
      transport: 'native',
      errors,
      answerPreview: '',
    });
    expect(err.message).toBe(message);
    expect(err.data.errors).toEqual(errors);
  });
});

describe('extractLastJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractLastJsonObject('{"a":1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reads a fenced block', () => {
    expect(extractLastJsonObject('Here:\n```json\n{"a":1}\n```')).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
  });

  it('reads an object that ends prose', () => {
    expect(extractLastJsonObject('Here it is: {"a":1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('takes the last of several fenced blocks', () => {
    expect(extractLastJsonObject('```json\n{"a":1}\n```\n```json\n{"a":2}\n```')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('reads a bare object that follows a fence holding no object', () => {
    expect(extractLastJsonObject('Run this:\n```\nnpm test\n```\n{"a":1}')).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
  });

  it('takes a bare object that ends after a fenced example', () => {
    expect(extractLastJsonObject('```json\n{"a":1}\n```\nFinal: {"a":2}')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('takes a fenced object that ends after a bare one', () => {
    expect(extractLastJsonObject('Example {"a":1}, answer:\n```json\n{"a":2}\n```')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('ignores braces inside a code fence', () => {
    expect(
      extractLastJsonObject('{"a":1}\n```ts\nconst f = () => { return 1; };\n```\nDone.'),
    ).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reports a last object that opens like JSON and does not parse as invalid', () => {
    expect(extractLastJsonObject('{"a":1} then {"a":2,}')).toEqual({ kind: 'invalid' });
  });

  it('reads the answer after a stray brace in prose', () => {
    expect(
      extractLastJsonObject(
        'The guard opens with `if (x) {` in foo.ts.\n\n{"answer":"ok","count":3}',
      ),
    ).toEqual({ kind: 'ok', value: { answer: 'ok', count: 3 } });
  });

  it('reads a fenced answer that prose with braces follows', () => {
    expect(
      extractLastJsonObject('```json\n{"a":1}\n```\nThe object {above} is the answer.'),
    ).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('reports an object that does not parse as invalid', () => {
    expect(extractLastJsonObject('Here: {"a":2,}')).toEqual({ kind: 'invalid' });
  });

  it('rejects two adjacent objects', () => {
    expect(extractLastJsonObject('{"a":1}\n{"a":2}')).toEqual({ kind: 'ambiguous' });
  });

  it('takes the last object when prose separates them', () => {
    expect(extractLastJsonObject('{"a":1} and then {"a":2}')).toEqual({
      kind: 'ok',
      value: { a: 2 },
    });
  });

  it('finds no object in plain prose', () => {
    expect(extractLastJsonObject('no json here')).toEqual({ kind: 'none' });
  });

  it('reports a truncated object as truncated', () => {
    expect(extractLastJsonObject('{"a":')).toEqual({ kind: 'truncated' });
  });

  it('reports an answer cut inside a literal or a number as truncated', () => {
    for (const input of ['{"a":tr', '{"a":nul', '{"a":1.', '{"a":-', '{"a":1.5e+']) {
      expect(extractLastJsonObject(input)).toEqual({ kind: 'truncated' });
    }
  });

  it('finds no object in an answer cut before its first key ends', () => {
    expect(extractLastJsonObject('{"pla')).toEqual({ kind: 'none' });
  });

  it('never reads an inner object out of a truncated answer', () => {
    expect(extractLastJsonObject('{"plan":{"summary":"x"},"tasks":[{"id":"T001"}')).toEqual({
      kind: 'truncated',
    });
  });

  it('reports an answer truncated after a complete example as truncated', () => {
    expect(extractLastJsonObject('Example {"a":1}. Answer: {"a":2,"b":{"c":3}')).toEqual({
      kind: 'truncated',
    });
  });

  it('keeps the answer when prose mentions an unclosed key', () => {
    for (const input of [
      '{"a":1}\n\nNote: I dropped the key {"b" from the old shape.',
      'The old shape started with {"plan" and changed.\n\n{"a":1}',
      '```json\n{"a":1}\n```\nIt replaces {"old',
      '{"a":1}\n\nI dropped {"b": entirely',
      '{"a":1}\n\nIt replaces {"old": shape.',
      '{"a":1}\n\nThe old key was {"b": removed',
    ]) {
      expect(extractLastJsonObject(input)).toEqual({ kind: 'ok', value: { a: 1 } });
    }
  });

  it('skips an unclosed brace in prose', () => {
    expect(extractLastJsonObject('The block { never closes. {"a":1}')).toEqual({
      kind: 'ok',
      value: { a: 1 },
    });
    expect(extractLastJsonObject('Note: `if (x) {` opens a block.')).toEqual({ kind: 'none' });
  });

  it('keeps braces that sit inside a string', () => {
    expect(extractLastJsonObject('{"s":"}{"}')).toEqual({ kind: 'ok', value: { s: '}{' } });
  });

  it('ignores quotes in prose', () => {
    expect(extractLastJsonObject('say "hi" then {"a":1}')).toEqual({ kind: 'ok', value: { a: 1 } });
  });

  it('rejects a top-level array', () => {
    expect(extractLastJsonObject('[1,2]')).toEqual({ kind: 'none' });
  });

  it('never reports an empty object for a failing input', () => {
    for (const input of ['{"a":1}\n{"a":2}', 'no json here', '{"a":', '[1,2]']) {
      expect(extractLastJsonObject(input)).not.toEqual({ kind: 'ok', value: {} });
    }
  });
});

describe('requestTyped', () => {
  it.each(['native', 'fallback'] satisfies TypedOutputCapability[])(
    'prepares each %s invocation and stops after one invalid repair',
    async (typedOutput) => {
      const { call, invokes } = makeSeatCall({
        seat: 'reviewer',
        typedOutput,
        results: [completed('invalid first answer'), completed('invalid repair answer')],
      });
      let preparations = 0;
      const result = await requestTyped({
        schema: probeSchema,
        jsonSchema,
        schemaName: 'probe',
        prepareCall: async () => ({ prompt: `Current input ${++preparations}`, call }),
      });

      expect(expectError(result).data.attempts).toBe(2);
      expect(invokes).toHaveLength(2);
      expect(invokes[0]?.prompt).toContain('Current input 1');
      expect(invokes[1]?.prompt).toContain('Current input 2');
      expect(invokes[1]?.prompt).not.toContain('Current input 1');
      expect(invokes[1]?.prompt).toContain('invalid first answer');
      expect(preparations).toBe(2);
    },
  );

  it('checks the refreshed repair input against its binding cap before dispatch', async () => {
    const { call, invokes } = makeSeatCall({
      seat: 'reviewer',
      typedOutput: 'native',
      results: [completed('invalid answer')],
    });
    let preparations = 0;
    const notices: string[] = [];

    await expect(
      requestTyped({
        schema: probeSchema,
        jsonSchema,
        schemaName: 'probe',
        onRepair: (message) => notices.push(message),
        prepareCall: async () => {
          const first = ++preparations === 1;
          return {
            prompt: first ? 'Review the diff' : 'Queued input '.repeat(100),
            call: { ...call, promptLimit: { max: first ? 10_000 : 100, unit: 'characters' } },
          };
        },
      }),
    ).rejects.toMatchObject({ kind: 'input-too-large' });
    expect(invokes).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it.each(['native', 'fallback'] satisfies TypedOutputCapability[])(
    'refuses an oversized first %s prompt before invoking the seat',
    async (typedOutput) => {
      const prompt = 'Answer the question';
      const maxInputChars = prompt.length - 1;
      const { call, invokes } = makeSeatCall({
        typedOutput,
        results: [completed('{"answer":"a","count":1}')],
      });
      const sentPrompt =
        typedOutput === 'native' ? prompt : prompt + fallbackInstruction(jsonSchema);

      await expect(
        requestTyped(
          options({
            call: { ...call, promptLimit: { max: maxInputChars, unit: 'characters' } },
            prompt,
          }),
        ),
      ).rejects.toMatchObject({
        kind: 'input-too-large',
        data: {
          error: {
            code: 'input-too-large',
            message: expect.stringContaining(
              `"max_chars":${maxInputChars},"actual_chars":${sentPrompt.length}`,
            ),
          },
        },
      });
      expect(invokes).toHaveLength(0);
    },
  );

  it.each([
    { typedOutput: 'native', canResume: false },
    { typedOutput: 'fallback', canResume: false },
    { typedOutput: 'native', canResume: true },
    { typedOutput: 'fallback', canResume: true },
  ] satisfies Pick<TypedSeatCall, 'typedOutput' | 'canResume'>[])(
    'refuses an oversized $typedOutput repair with canResume=$canResume before a second invocation',
    async ({ typedOutput, canResume }) => {
      const prompt = 'Answer the question';
      const firstPrompt =
        typedOutput === 'native' ? prompt : prompt + fallbackInstruction(jsonSchema);
      const maxInputChars = firstPrompt.length;
      const { call, invokes } = makeSeatCall({
        typedOutput,
        canResume,
        results: [
          makeRunnerCallResult({
            status: 'completed',
            text: '{"answer":1}',
            nativeSessionId: 's1',
          }),
          completed('{"answer":"a","count":1}'),
        ],
      });

      await expect(
        requestTyped(
          options({
            call: { ...call, promptLimit: { max: maxInputChars, unit: 'characters' } },
            prompt,
          }),
        ),
      ).rejects.toMatchObject({
        kind: 'input-too-large',
        data: {
          error: {
            code: 'input-too-large',
            message: expect.stringContaining(`"max_chars":${maxInputChars}`),
          },
        },
      });
      expect(invokes).toHaveLength(1);
      expect(invokes[0]?.prompt).toBe(firstPrompt);
    },
  );

  it('sends the schema natively and trusts the structured answer', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'native',
      results: [
        makeRunnerCallResult({
          status: 'completed',
          text: 'garbage',
          structured: { answer: 'x', count: 1 },
        }),
      ],
    });

    const result = await requestTyped(options({ call, prompt: 'Ask something' }));

    expect(expectValue(result).value).toEqual({ answer: 'x', count: 1 });
    expect(invokes).toHaveLength(1);
    expect(invokes[0]?.schema).toEqual({ json: jsonSchema, name: 'probe' });
    expect(invokes[0]?.prompt).toBe('Ask something');
  });

  it('appends the fallback instruction and reads the JSON from the text', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      results: [completed('Done. {"answer":"x","count":1}')],
    });

    const result = await requestTyped(options({ call, prompt: 'Ask something' }));

    expect(expectValue(result).value).toEqual({ answer: 'x', count: 1 });
    expect(invokes).toHaveLength(1);
    expect(invokes[0]?.schema).toBeUndefined();
    expect(invokes[0]?.prompt).toBe('Ask something' + fallbackInstruction(jsonSchema));
    expect(invokes[0]?.prompt.endsWith(fallbackInstruction(jsonSchema))).toBe(true);
  });

  it('repairs a planner answer once and sums the usage of both calls', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      results: [
        completed('{"answer":1}', { inputTokens: 3, outputTokens: 4 }),
        completed('{"answer":"a","count":2}', { inputTokens: 5, outputTokens: 6 }),
      ],
    });

    const result = await requestTyped(options({ call }));

    const success = expectValue(result);
    expect(success.value).toEqual({ answer: 'a', count: 2 });
    expect(success.usage).toEqual({ inputTokens: 8, outputTokens: 10 });
    expect(invokes).toHaveLength(2);
  });

  it('returns a seat protocol error after the repair also fails', async () => {
    const invalid = completed('{"answer":1}');
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      results: [invalid, invalid],
    });

    const failure = expectError(await requestTyped(options({ call })));

    expect(failure.kind).toBe('seat-protocol-error');
    expect(failure.data.attempts).toBe(2);
    expect(failure.data.seat).toBe('planner');
    expect(invokes).toHaveLength(2);
  });

  it('carries the usage of both billed calls on a seat protocol error', async () => {
    const { call } = makeSeatCall({
      typedOutput: 'fallback',
      results: [
        completed('{"answer":1}', { inputTokens: 3, outputTokens: 4 }),
        completed('{"answer":2}', { inputTokens: 5, outputTokens: 6 }),
      ],
    });

    const result = await requestTyped(options({ call }));

    expectError(result);
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 10 });
  });

  it('sends a strict schema natively to a strict-mode seat', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'strict-native',
      results: [
        makeRunnerCallResult({
          status: 'completed',
          text: '',
          structured: { answer: 'x', count: 1 },
        }),
      ],
    });

    expectValue(await requestTyped(options({ call, prompt: 'Ask something' })));

    expect(invokes[0]?.schema).toEqual({ json: jsonSchema, name: 'probe' });
    expect(invokes[0]?.prompt).toBe('Ask something');
  });

  it('asks a strict-mode seat in the prompt for a schema its strict mode rejects', async () => {
    const openSchema = { ...jsonSchema, required: ['answer'] };
    const { call, invokes } = makeSeatCall({
      typedOutput: 'strict-native',
      results: [completed('{"answer":1}'), completed('{"answer":2}')],
    });

    const failure = expectError(
      await requestTyped({ ...options({ call, prompt: 'Ask something' }), jsonSchema: openSchema }),
    );

    expect(failure.data.transport).toBe('fallback');
    expect(invokes[0]?.schema).toBeUndefined();
    expect(invokes[0]?.prompt).toBe('Ask something' + fallbackInstruction(openSchema));
    expect(invokes[1]?.schema).toBeUndefined();
  });

  it('does not repair a valid first answer', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      results: [completed('{"answer":"a","count":1}')],
    });

    const result = await requestTyped(options({ call }));

    expect(expectValue(result).value).toEqual({ answer: 'a', count: 1 });
    expect(invokes).toHaveLength(1);
  });

  it('never repairs an implementer answer', async () => {
    const { call, invokes } = makeSeatCall({
      seat: 'implementer',
      typedOutput: 'fallback',
      results: [completed('{"answer":1}', { inputTokens: 2, outputTokens: 1 })],
    });

    const result = await requestTyped(options({ call }));

    expect(expectError(result).data.attempts).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
    expect(invokes).toHaveLength(1);
  });

  it('keeps the ambiguous answer in the reported errors', async () => {
    const ambiguous = '{"answer":"a","count":1}\n{"answer":"b","count":2}';
    const { call } = makeSeatCall({
      typedOutput: 'fallback',
      results: [completed(ambiguous), completed(ambiguous)],
    });

    const failure = expectError(await requestTyped(options({ call })));

    expect(failure.data.errors).toContain(
      'Ambiguous answer: several JSON objects end the reply; send exactly one.',
    );
  });

  it('tells the repair that the answer was truncated', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      results: [
        completed('{"answer":"a","extra":{"n":1},"count":'),
        completed('{"answer":"a","count":1}'),
      ],
    });

    expectValue(await requestTyped(options({ call })));

    expect(invokes[1]?.prompt).toContain('The JSON object in the answer is truncated');
  });

  it('tells the repair that the object did not parse', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      results: [completed('{"answer":"a","count":1,}'), completed('{"answer":"a","count":1}')],
    });

    expectValue(await requestTyped(options({ call })));

    expect(invokes[1]?.prompt).toContain('The last JSON object in the answer is not valid JSON.');
    expect(invokes[1]?.prompt).not.toContain('No JSON object found');
  });

  it('continues the planner thread that gave the invalid answer', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      canResume: true,
      results: [
        makeRunnerCallResult({ status: 'completed', text: '{"answer":1}', nativeSessionId: 's2' }),
        completed('{"answer":"a","count":2}'),
      ],
    });

    const result = await requestTyped(options({ call, prompt: 'Answer the question' }));

    expect(expectValue(result).value).toEqual({ answer: 'a', count: 2 });
    expect(invokes).toHaveLength(2);
    const repair = invokes[1];
    if (repair === undefined) throw new Error('Expected a repair invoke');
    expect(repair.prompt).not.toContain('Answer the question');
    expect(repair.prompt.startsWith('Your previous answer failed validation:')).toBe(true);
    expect(repair.prompt.endsWith(fallbackInstruction(jsonSchema))).toBe(true);
  });

  it('makes a fresh planner call when the session cannot resume', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'fallback',
      canResume: false,
      results: [completed('{"answer":1}'), completed('{"answer":"a","count":2}')],
    });

    await requestTyped(options({ call, prompt: 'Answer the question' }));

    const repair = invokes[1];
    if (repair === undefined) throw new Error('Expected a repair invoke');
    expect(repair.prompt).toContain('Answer the question');
    expect(repair.prompt).toContain('Your previous answer:');
    expect(repair.prompt).toContain('{"answer":1}');
    expect(repair.prompt).toContain('It failed validation:');
    expect(repair.prompt.endsWith(fallbackInstruction(jsonSchema))).toBe(true);
  });

  it('makes a fresh reviewer call even when the session could resume', async () => {
    const { call, invokes } = makeSeatCall({
      seat: 'reviewer',
      typedOutput: 'fallback',
      canResume: true,
      results: [
        makeRunnerCallResult({ status: 'completed', text: '{"answer":1}', nativeSessionId: 's2' }),
        completed('{"answer":"a","count":2}'),
      ],
    });

    await requestTyped(options({ call, prompt: 'Answer the question' }));

    const repair = invokes[1];
    if (repair === undefined) throw new Error('Expected a repair invoke');
    expect(repair.prompt).toContain('Answer the question');
    expect(repair.prompt).toContain('Your previous answer:');
    expect(repair.prompt).toContain('{"answer":1}');
    expect(repair.prompt).toContain('It failed validation:');
  });

  it('throws a failed runner call through', async () => {
    const { call, invokes } = makeSeatCall({
      typedOutput: 'native',
      results: [
        makeRunnerCallResult({
          status: 'failed',
          text: '',
          error: { code: 'x', message: 'boom' },
        }),
      ],
    });

    await expect(requestTyped(options({ call }))).rejects.toMatchObject({
      kind: 'runner-call-failed',
    });
    expect(invokes).toHaveLength(1);
  });

  it('bounds the answer preview', async () => {
    const longAnswer = `{"answer":"${'x'.repeat(5000)}"}`;
    const { call } = makeSeatCall({
      seat: 'implementer',
      typedOutput: 'fallback',
      results: [completed(longAnswer)],
    });

    const failure = expectError(await requestTyped(options({ call })));

    expect(failure.data.answerPreview.length).toBeLessThanOrEqual(2000);
  });
});

describe('requestTyped repair notice', () => {
  it('names the refused field before it asks the seat again', async () => {
    const order: string[] = [];
    const { call } = makeSeatCall({
      seat: 'reviewer',
      typedOutput: 'fallback',
      results: [completed('{"answer":1,"count":2}'), completed('{"answer":"a","count":2}')],
    });
    const notices: string[] = [];

    const result = await requestTyped({
      schema: probeSchema,
      jsonSchema,
      schemaName: 'probe',
      prepareCall: async () => {
        order.push('prepare');
        return { prompt: 'Review it', call };
      },
      onRepair: (message) => {
        order.push('repair');
        notices.push(message);
      },
    });

    expect(expectValue(result).value).toEqual({ answer: 'a', count: 2 });
    expect(notices).toEqual([
      'The reviewer seat answer did not match its contract. Wrong or missing value in answer. Asking the seat again.',
    ]);
    expect(order).toEqual(['prepare', 'prepare', 'repair']);
  });

  it('says an answer had no JSON object', async () => {
    const { call } = makeSeatCall({
      typedOutput: 'fallback',
      results: [completed('I think it is fine.'), completed('{"answer":"a","count":2}')],
    });
    const notices: string[] = [];

    await requestTyped({ ...options({ call }), onRepair: (message) => notices.push(message) });

    expect(notices).toEqual([
      'The planner seat answer did not match its contract. No JSON object found in the answer. Asking the seat again.',
    ]);
  });

  it('names the nearest field once, without list positions, and keeps contract rules whole', async () => {
    const schema = z
      .object({ findings: z.array(z.object({ severity: z.enum(['high', 'low']) })) })
      .superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'custom', message: 'Task T1 is missing from the verdict.' });
      });
    const { call } = makeSeatCall({
      seat: 'reviewer',
      typedOutput: 'fallback',
      results: [
        completed('{"findings":[{"severity":"x"},{"severity":"y"}]}'),
        completed('{"findings":[]}'),
      ],
    });
    const notices: string[] = [];

    await requestTyped({
      prompt: 'Review it',
      schema,
      jsonSchema,
      schemaName: 'probe',
      call,
      onRepair: (message) => notices.push(message),
    });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Wrong or missing value in severity.');
    expect(notices[0]).not.toContain('findings.0');
  });

  it('lists at most three reasons', async () => {
    const schema = z.object({}).superRefine((_value, ctx) => {
      for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
        ctx.addIssue({ code: 'custom', message: `Task ${id} is missing from the verdict.` });
      }
    });
    const { call } = makeSeatCall({
      seat: 'reviewer',
      typedOutput: 'fallback',
      results: [completed('{}'), completed('{}')],
    });
    const notices: string[] = [];

    await requestTyped({
      prompt: 'Review it',
      schema,
      jsonSchema,
      schemaName: 'probe',
      call,
      onRepair: (message) => notices.push(message),
    });

    expect(notices).toEqual([
      'The reviewer seat answer did not match its contract. Task T1 is missing from the verdict. Task T2 is missing from the verdict. Task T3 is missing from the verdict. And 2 more. Asking the seat again.',
    ]);
  });

  it('gives no notice when the first answer holds or the seat gets no repair', async () => {
    const valid = makeSeatCall({
      typedOutput: 'fallback',
      results: [completed('{"answer":"a","count":2}')],
    });
    const implementer = makeSeatCall({
      seat: 'implementer',
      typedOutput: 'fallback',
      results: [completed('{"answer":1}')],
    });
    const notices: string[] = [];

    await requestTyped({
      ...options({ call: valid.call }),
      onRepair: (message) => notices.push(message),
    });
    await requestTyped({
      ...options({ call: implementer.call }),
      onRepair: (message) => notices.push(message),
    });

    expect(notices).toEqual([]);
  });
});
