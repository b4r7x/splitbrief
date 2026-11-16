import { describe, expect, it } from 'vitest';
import { CONFORMANCE_MODULES, CONFORMANCE_ROWS } from '#testing/helpers/cli-conformance-rows.js';
import type { CliConformanceRole } from './contract-harness/harness.js';

function rowKey(id: string, role: CliConformanceRole): string {
  return `${id}:${role}`;
}

const PROMPT_HEAD = 'HEAD_SENTINEL ';
const PROMPT_OVERSIZED = PROMPT_HEAD + 'x'.repeat(200_000);

function buildConformanceAdapterArgs(
  row: (typeof CONFORMANCE_ROWS)[number],
  prompt: string,
): readonly string[] {
  const input =
    row.role === 'planner'
      ? {
          prompt,
          model: undefined,
          projectDir: '/tmp',
          configuredArgs: [] as const,
          sessionId: null,
          effort: undefined,
        }
      : { prompt, model: undefined, projectDir: '/tmp', configuredArgs: [] as const };
  const result = Reflect.apply(row.adapter.buildArgs, undefined, [input]);
  if (!Array.isArray(result) || !result.every((value) => typeof value === 'string')) {
    throw new Error(`adapter buildArgs returned invalid args for ${row.id} ${row.role}`);
  }
  return [...result];
}

describe('existing CLI prompt transport contract', () => {
  it.each(CONFORMANCE_ROWS)(
    '$id $role takes an oversized prompt on stdin and keeps it out of argv',
    (row) => {
      const args = buildConformanceAdapterArgs(row, PROMPT_OVERSIZED);
      expect(row.rawContract.promptTransport).toBe('stdin');
      expect(row.adapter.promptTransport).toEqual({ kind: 'stdin' });
      expect(args.some((arg) => arg.includes(PROMPT_HEAD))).toBe(false);
    },
  );
});

describe('existing CLI common contract', () => {
  it('imports exactly 14 unique planner-then-implementer conformance rows', () => {
    expect(CONFORMANCE_ROWS).toHaveLength(14);
    const keys = CONFORMANCE_ROWS.map((row) => rowKey(row.id, row.role));
    expect(new Set(keys).size).toBe(14);
    for (const module of CONFORMANCE_MODULES) {
      expect(module.candidates).toHaveLength(2);
      expect(module.candidates.map((candidate) => candidate.role)).toEqual([
        'planner',
        'implementer',
      ]);
    }
  });
});
