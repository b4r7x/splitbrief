import { describe, expect, it } from 'vitest';
import YAML, { parseDocument } from 'yaml';
import { applyConfigDocumentEdits } from './document.js';
import { fromYaml } from './transform.js';

/** What the loader reads from a rendered document, before defaults and validation. */
function loaded(text: string): Record<string, unknown> {
  return fromYaml(YAML.parse(text));
}

function edited(yaml: string, path: readonly string[], value: unknown): string {
  const document = parseDocument(yaml);
  applyConfigDocumentEdits(document, [{ path, value }]);
  return document.toString();
}

const KEYS = [
  { camel: 'outputFormat', snake: 'output_format', before: 'text', after: 'jsonl' },
  { camel: 'contextLength', snake: 'context_length', before: 32_768, after: 65_536 },
  { camel: 'customModels', snake: 'custom_models', before: ['a'], after: ['a', 'b'] },
] as const;

type Spelling = 'camel' | 'snake' | 'camel-then-snake' | 'snake-then-camel';
const SPELLINGS: readonly Spelling[] = ['camel', 'snake', 'camel-then-snake', 'snake-then-camel'];

function plannerYaml(
  key: (typeof KEYS)[number],
  spelling: Spelling,
  earlier: unknown,
  later: unknown,
): string {
  const line = (name: string, value: unknown) => `  ${name}: ${JSON.stringify(value)}`;
  const lines =
    spelling === 'camel'
      ? [line(key.camel, later)]
      : spelling === 'snake'
        ? [line(key.snake, later)]
        : spelling === 'camel-then-snake'
          ? [line(key.camel, earlier), line(key.snake, later)]
          : [line(key.snake, earlier), line(key.camel, later)];
  return ['version: 3', 'planner:', '  kind: shell', '  command: my-planner', ...lines, ''].join(
    '\n',
  );
}

/** Every line of the planner block that spells the key, in either spelling. */
function spellingsIn(text: string, key: (typeof KEYS)[number]): string[] {
  return text
    .split('\n')
    .map((line) => line.trim().split(':')[0] ?? '')
    .filter((name) => name === key.camel || name === key.snake);
}

describe('applyConfigDocumentEdits', () => {
  describe.each(KEYS)('$camel', (key) => {
    it.each(SPELLINGS)(
      'sets the key the loader reads in a %s file, leaving no twin',
      (spelling) => {
        // The twin files carry a stale earlier value the loader never reads.
        const text = edited(
          plannerYaml(key, spelling, 'stale', key.before),
          ['planner', key.snake],
          key.after,
        );
        const planner = loaded(text)['planner'] as Record<string, unknown>;

        expect(planner[key.camel]).toEqual(key.after);
        expect(spellingsIn(text, key)).toHaveLength(1);
        if (spelling === 'camel' || spelling === 'snake-then-camel') {
          expect(spellingsIn(text, key)).toEqual([key.camel]);
        } else {
          expect(spellingsIn(text, key)).toEqual([key.snake]);
        }
      },
    );

    it.each(SPELLINGS)('deletes every spelling of the key in a %s file', (spelling) => {
      const text = edited(
        plannerYaml(key, spelling, 'stale', key.before),
        ['planner', key.snake],
        undefined,
      );
      const planner = loaded(text)['planner'] as Record<string, unknown>;

      expect(planner).not.toHaveProperty(key.camel);
      expect(spellingsIn(text, key)).toEqual([]);
      expect(planner).toMatchObject({ kind: 'shell', command: 'my-planner' });
    });
  });

  it('adds a key the file does not carry yet in the writer spelling', () => {
    const text = edited(
      'version: 3\nplanner:\n  kind: cli\n  tool: codex\n',
      ['planner', 'context_length'],
      1000,
    );

    expect(text).toContain('context_length: 1000');
    expect(loaded(text)['planner']).toMatchObject({ contextLength: 1000 });
  });

  it('reaches a nested key through the maps the file spells in camelCase', () => {
    const yaml = [
      'version: 3',
      'implementerProfiles:',
      '  default: fast',
      '  profiles:',
      '    fast:',
      '      kind: api',
      '      provider: ollama',
      '      model: qwen3-coder:30b',
      '      contextLength: 32768',
      '',
    ].join('\n');
    const path = ['implementer_profiles', 'profiles', 'fast', 'context_length'];

    const set = edited(yaml, path, 65_536);
    expect(set).not.toContain('implementer_profiles');
    expect(set).not.toContain('context_length');
    expect(loaded(set)).toMatchObject({
      implementerProfiles: { profiles: { fast: { contextLength: 65_536 } } },
    });

    const deleted = edited(yaml, path, undefined);
    expect(deleted).not.toContain('contextLength');
    expect(loaded(deleted)).toMatchObject({
      implementerProfiles: { profiles: { fast: { model: 'qwen3-coder:30b' } } },
    });
  });

  it("keeps the file's comments while it removes a stale twin", () => {
    const yaml = [
      'version: 3',
      'planner:',
      '  # the harness seat',
      '  kind: shell',
      '  command: my-planner',
      '  outputFormat: text',
      '  output_format: jsonl',
      '',
    ].join('\n');
    const text = edited(yaml, ['planner', 'output_format'], undefined);

    expect(text).toContain('# the harness seat');
    expect(text).not.toMatch(/output_?[fF]ormat/);
  });
});
