// @vitest-environment node

import { ConfigSchema } from '../../../../../src/core/schemas/config.js';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { API_KEY_CONTRACT } from './pairings-auth.test-data.js';
import {
  DEFAULT_SELECTION,
  IMPLEMENTER_JACK_IDS,
  IMPLEMENTER_JACKS,
  MODEL_PROVENANCE,
  PLANNER_JACK_IDS,
  PLANNER_JACKS,
  pairingYaml,
} from './pairings.js';

const ROOT_KEYS = ['version', 'planner', 'implementer', 'validation', 'workflow'];

const DEFAULT_YAML = `version: 3
planner:
  kind: cli
  tool: claude-code
implementer:
  kind: api
  provider: ollama
  apiBase: http://localhost:11434/v1
  model: qwen3-coder:30b
validation:
  typecheck: true
  lint: true
  test: true
workflow:
  mode: standard
  approve: default
  maxRetries: 3
  git:
    commitStrategy: none
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be a YAML mapping`);
  }
  return value;
}

function expectRunnerContract(value: unknown, role: 'planner' | 'implementer'): void {
  const runner = requireRecord(value, role);

  expect(runner).not.toHaveProperty('baseUrl');
  expect(runner.model).not.toBe('auto');

  if (runner.kind === 'cli') {
    expect(typeof runner.tool).toBe('string');
    expect(runner).not.toHaveProperty('provider');
    expect(runner).not.toHaveProperty('apiBase');
    return;
  }

  if (runner.kind === 'api') {
    expect(typeof runner.provider).toBe('string');
    expect(typeof runner.apiBase).toBe('string');
    expect(typeof runner.model).toBe('string');
    return;
  }

  expect(runner.kind).toBe('agent-sdk');
  expect(typeof runner.model).toBe('string');
  expect(runner).not.toHaveProperty('provider');
  expect(runner).not.toHaveProperty('apiBase');
}

function expectModelProvenance(value: {
  readonly modelSourceUrl: string;
  readonly modelVerifiedOn: string;
}): void {
  const source = new URL(value.modelSourceUrl);

  expect(source.protocol).toBe('https:');
  expect(value.modelVerifiedOn).toBe('2026-07-30');
}

describe('landing pairing configs', () => {
  it('exposes the canonical default config byte for byte', () => {
    expect(DEFAULT_SELECTION).toEqual({
      plannerId: 'claude-code',
      implementerId: 'ollama',
    });
    expect(pairingYaml(DEFAULT_SELECTION)).toBe(DEFAULT_YAML);
  });

  it('contains exactly 36 distinct documents', () => {
    const documents = PLANNER_JACK_IDS.flatMap((plannerId) =>
      IMPLEMENTER_JACK_IDS.map((implementerId) => pairingYaml({ plannerId, implementerId })),
    );

    expect(PLANNER_JACK_IDS.length * IMPLEMENTER_JACK_IDS.length).toBe(36);
    expect(documents).toHaveLength(36);
    expect(new Set(documents).size).toBe(36);
  });

  it('pins the ordered labels and launch models', () => {
    expect(
      PLANNER_JACK_IDS.map((plannerId) => {
        const jack = PLANNER_JACKS[plannerId];
        return [plannerId, jack.label, 'model' in jack.runner ? jack.runner.model : null];
      }),
    ).toEqual([
      ['claude-code', 'Claude Code', null],
      ['codex', 'Codex', null],
      ['opencode', 'OpenCode', null],
      ['aider', 'Aider', null],
      ['anthropic', 'Anthropic', 'claude-opus-4-6'],
      ['agent-sdk', 'Agent SDK', 'claude-sonnet-4-6'],
    ]);

    expect(
      IMPLEMENTER_JACK_IDS.map((implementerId) => {
        const jack = IMPLEMENTER_JACKS[implementerId];
        return [implementerId, jack.label, jack.runner.apiBase, jack.runner.model];
      }),
    ).toEqual([
      ['ollama', 'Ollama', 'http://localhost:11434/v1', 'qwen3-coder:30b'],
      ['lm-studio', 'LM Studio', 'http://localhost:1234/v1', 'qwen2.5-coder-7b'],
      ['deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-v4-flash'],
      ['groq', 'Groq', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4.6'],
      ['together', 'Together AI', 'https://api.together.xyz/v1', 'zai-org/GLM-5.1'],
    ]);
  });

  for (const plannerId of PLANNER_JACK_IDS) {
    for (const implementerId of IMPLEMENTER_JACK_IDS) {
      it(`emits schema-valid ${plannerId} × ${implementerId} YAML`, () => {
        const yaml = pairingYaml({ plannerId, implementerId });
        const raw: unknown = parse(yaml);
        const config = requireRecord(raw, 'config');

        expect(Object.keys(config)).toEqual(ROOT_KEYS);
        expect(ConfigSchema.safeParse(config).success).toBe(true);
        expectRunnerContract(config.planner, 'planner');
        expectRunnerContract(config.implementer, 'implementer');
      });
    }
  }

  it('records current provenance for every model-bearing jack', () => {
    const currentModels = [
      ...PLANNER_JACK_IDS.flatMap((id) => {
        const runner = PLANNER_JACKS[id].runner;
        return 'model' in runner ? [{ id, model: runner.model }] : [];
      }),
      ...IMPLEMENTER_JACK_IDS.map((id) => ({ id, model: IMPLEMENTER_JACKS[id].runner.model })),
    ];

    expect(Object.entries(MODEL_PROVENANCE).map(([id, { model }]) => ({ id, model }))).toEqual(
      currentModels,
    );
    for (const provenance of Object.values(MODEL_PROVENANCE)) {
      expectModelProvenance(provenance);
    }
  });

  it('records the provider environment contract without serializing credentials', () => {
    expect(Object.keys(API_KEY_CONTRACT)).toEqual([
      'anthropic',
      'agent-sdk',
      'ollama',
      'deepseek',
      'groq',
      'openrouter',
      'together',
    ]);
    for (const { env } of Object.values(API_KEY_CONTRACT)) {
      expect(env).toMatch(/^[A-Z]+(?:_[A-Z]+)*_API_KEY$/);
    }
    expect(
      Object.entries(API_KEY_CONTRACT)
        .filter(([, contract]) => 'optional' in contract)
        .map(([id]) => id),
    ).toEqual(['ollama']);

    for (const plannerId of PLANNER_JACK_IDS) {
      for (const implementerId of IMPLEMENTER_JACK_IDS) {
        expect(pairingYaml({ plannerId, implementerId })).not.toContain('apiKey:');
      }
    }
  });
});
