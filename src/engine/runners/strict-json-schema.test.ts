import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CONSULT_ANSWER_JSON_SCHEMA,
  DEVIATION_CONSULT_ANSWER_JSON_SCHEMA,
  STALE_CONSULT_ANSWER_JSON_SCHEMA,
} from '../../core/schemas/consult.js';
import { PLAN_ANSWER_JSON_SCHEMA } from '../../core/schemas/plan.js';
import { isStrictJsonSchema } from './strict-json-schema.js';

const leaf = {
  type: 'object',
  properties: { kind: { type: 'string' } },
  required: ['kind'],
  additionalProperties: false,
};

describe('isStrictJsonSchema', () => {
  it('accepts a closed object with every key required and a null union for an optional value', () => {
    expect(
      isStrictJsonSchema(
        z.toJSONSchema(
          z.object({
            answer: z.string(),
            note: z.string().nullable(),
            items: z.array(z.object({ id: z.string() })),
          }),
        ),
      ),
    ).toBe(true);
  });

  it('accepts the planning session answer, so planners use the native transport', () => {
    expect(isStrictJsonSchema(PLAN_ANSWER_JSON_SCHEMA)).toBe(true);
  });

  it('accepts the consult answers, so a codex consult uses the native transport', () => {
    expect(isStrictJsonSchema(CONSULT_ANSWER_JSON_SCHEMA)).toBe(true);
    expect(isStrictJsonSchema(STALE_CONSULT_ANSWER_JSON_SCHEMA)).toBe(true);
    expect(isStrictJsonSchema(DEVIATION_CONSULT_ANSWER_JSON_SCHEMA)).toBe(true);
  });

  it('emits the consult answers as anyOf, which OpenAI strict mode takes', () => {
    // Live probe 2026-10-06 (codex --output-schema): HTTP 400 "'oneOf' is not permitted".
    for (const schema of [
      CONSULT_ANSWER_JSON_SCHEMA,
      STALE_CONSULT_ANSWER_JSON_SCHEMA,
      DEVIATION_CONSULT_ANSWER_JSON_SCHEMA,
    ]) {
      expect(JSON.stringify(schema)).not.toContain('"oneOf"');
    }
  });

  it('accepts a strict object reached through $ref', () => {
    const task = z.object({ id: z.string() });
    expect(
      isStrictJsonSchema(z.toJSONSchema(z.object({ a: task, b: task }), { reused: 'ref' })),
    ).toBe(true);
  });

  it.each([
    [
      'an optional key',
      {
        type: 'object',
        properties: { answer: { type: 'string' }, note: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    ],
    [
      'an open nested object',
      {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'object', properties: {} } } },
        required: ['items'],
        additionalProperties: false,
      },
    ],
    ['an object without properties', { type: 'object', additionalProperties: false }],
    ['a root union', { anyOf: [leaf, leaf] }],
    [
      'a oneOf, even of closed objects',
      {
        ...leaf,
        properties: {
          kind: {
            oneOf: [
              leaf,
              {
                type: 'object',
                properties: { extra: { type: 'string' } },
                required: ['extra'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
    ],
    ['an allOf', { ...leaf, properties: { kind: { allOf: [leaf] } } }],
    [
      'an optional key behind $ref',
      {
        ...leaf,
        properties: { kind: { $ref: '#/$defs/open' } },
        $defs: { open: { ...leaf, required: [] } },
      },
    ],
  ])('rejects a schema with %s', (_case, json) => {
    expect(isStrictJsonSchema(json)).toBe(false);
  });

  it('rejects what Zod emits for a discriminated union and an intersection', () => {
    const union = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a') }),
      z.object({ kind: z.literal('b') }),
    ]);
    expect(isStrictJsonSchema(z.toJSONSchema(union))).toBe(false);
    expect(isStrictJsonSchema(z.toJSONSchema(z.object({ diagnosis: z.string() }).and(union)))).toBe(
      false,
    );
  });
});
