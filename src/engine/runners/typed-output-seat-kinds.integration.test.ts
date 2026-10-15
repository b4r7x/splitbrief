import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerCallResult } from '../calls/types.js';
import { createAgentPlanner } from '../planners/agent.js';
import { createPlannerBase } from '../planners/base.js';
import { ONE_SHOT_API_CAPS } from '../planners/types.js';
import { toOpenAIRequest } from '../providers/openai-stream/request.js';
import { claudeCodePlannerAdapter } from './cli-tools/claude-code.js';
import { opencodePlannerAdapter } from './cli-tools/opencode.js';
import {
  fallbackInstruction,
  requestTyped,
  type RequestTypedResult,
  type TypedSchemaInput,
} from './typed-output.js';

const probeSchema = z.object({ answer: z.string(), count: z.number() });
type Probe = z.infer<typeof probeSchema>;

const jsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' }, count: { type: 'number' } },
  required: ['answer', 'count'],
  additionalProperties: false,
};

const planInput = {
  prompt: 'x',
  model: undefined,
  projectDir: '/p',
  configuredArgs: [],
  sessionId: null,
  effort: undefined,
} as const;

function seat(
  typedOutput: 'native' | 'fallback',
  backendKind: 'cli' | 'api',
  respond: (input: { prompt: string; schema?: TypedSchemaInput }) => RunnerCallResult,
) {
  return createPlannerBase({
    backendKind,
    typedOutput,
    capabilities: ONE_SHOT_API_CAPS,
    isAvailable: async () => true,
    invokePlan: async ({ prompt, schema: s }) =>
      respond({ prompt, ...(s !== undefined && { schema: s }) }),
    invokeOneShot: async () => {
      throw new Error('a planner typed call runs on its planning thread');
    },
  });
}

function typedValue(result: RequestTypedResult<Probe>): Probe {
  if ('error' in result) throw new Error(`Expected a typed value, got ${result.error.message}`);
  return result.value;
}

const projectDir = '/p';
const callbacks = { onOutput: () => {} };

describe('requestTyped against the cli, api and agent seat kinds', () => {
  it('cli-native: builds the claude-code argv with the schema', async () => {
    const calls: Array<{ prompt: string; argv: readonly string[] }> = [];
    const base = seat('native', 'cli', (input) => {
      calls.push({
        prompt: input.prompt,
        argv: claudeCodePlannerAdapter.baseArgs({
          ...planInput,
          ...(input.schema !== undefined && { schema: { json: input.schema.json } }),
        }),
      });
      return makeRunnerCallResult({
        status: 'completed',
        text: '',
        structured: { answer: 'c', count: 1 },
      });
    });

    const result = await requestTyped({
      prompt: 'q',
      schema: probeSchema,
      jsonSchema,
      schemaName: 'probe',
      call: base.typedCall({ projectDir, callbacks, seat: 'planner' }),
    });

    expect(typedValue(result)).toEqual({ answer: 'c', count: 1 });
    const call = calls[0];
    if (call === undefined) throw new Error('requestTyped made no runner call');
    expect(call.prompt).toBe('q');
    expect(call.argv).toContain('--json-schema');
    const schemaIndex = call.argv.indexOf('--json-schema');
    expect(call.argv.slice(schemaIndex, schemaIndex + 2)).toEqual([
      '--json-schema',
      JSON.stringify(jsonSchema),
    ]);
  });

  it('cli-fallback: appends the fallback instruction to the opencode argv prompt', async () => {
    const calls: Array<{ prompt: string; argv: readonly string[] }> = [];
    const base = seat('fallback', 'cli', (input) => {
      calls.push({
        prompt: input.prompt,
        argv: opencodePlannerAdapter.baseArgs({
          ...planInput,
          ...(input.schema !== undefined && { schema: { json: input.schema.json } }),
        }),
      });
      return makeRunnerCallResult({
        status: 'completed',
        text: '```json\n{"answer":"o","count":2}\n```',
      });
    });

    const result = await requestTyped({
      prompt: 'q',
      schema: probeSchema,
      jsonSchema,
      schemaName: 'probe',
      call: base.typedCall({ projectDir, callbacks, seat: 'planner' }),
    });

    expect(typedValue(result)).toEqual({ answer: 'o', count: 2 });
    const call = calls[0];
    if (call === undefined) throw new Error('requestTyped made no runner call');
    expect(call.argv).toEqual(opencodePlannerAdapter.baseArgs(planInput));
    expect(call.prompt.endsWith(fallbackInstruction(jsonSchema))).toBe(true);
  });

  it('api: sends the schema as an OpenAI response_format', async () => {
    const bodies: Array<ReturnType<typeof toOpenAIRequest>> = [];
    const base = seat('native', 'api', (input) => {
      bodies.push(
        toOpenAIRequest({
          model: 'm',
          messages: [{ role: 'user', content: input.prompt }],
          stream: true,
          ...(input.schema !== undefined && {
            response_format: {
              type: 'json_schema',
              json_schema: { name: input.schema.name, schema: input.schema.json },
            },
          }),
        }),
      );
      return makeRunnerCallResult({ status: 'completed', text: '{"answer":"a","count":3}' });
    });

    const result = await requestTyped({
      prompt: 'q',
      schema: probeSchema,
      jsonSchema,
      schemaName: 'probe',
      call: base.typedCall({ projectDir, callbacks, seat: 'planner' }),
    });

    expect(typedValue(result)).toEqual({ answer: 'a', count: 3 });
    const body = bodies[0];
    if (body === undefined) throw new Error('requestTyped made no runner call');
    const format = body.response_format;
    if (format === undefined || format.type !== 'json_schema') {
      throw new Error('Expected a json_schema response format');
    }
    expect(format.json_schema).toEqual({ name: 'probe', schema: jsonSchema });
  });

  it('agent: reads the typed answer from the agent command stdout', async () => {
    const agentDir = createTempDir('typed-output-agent');
    try {
      createTestGitRepo(agentDir);
      const planner = createAgentPlanner(
        makeConfig({
          planner: {
            kind: 'agent',
            command: 'bash',
            args: [
              '-c',
              'case "$(cat)" in *"No prose after it.") echo \'Done: {"answer":"g","count":5}\';; esac',
            ],
          },
        }),
      );

      const result = await requestTyped({
        prompt: 'q',
        schema: probeSchema,
        jsonSchema,
        schemaName: 'probe',
        call: planner.typedCall({ projectDir: agentDir, callbacks, seat: 'planner' }),
      });

      expect(typedValue(result)).toEqual({ answer: 'g', count: 5 });
    } finally {
      cleanupTempDir(agentDir);
    }
  });
});
