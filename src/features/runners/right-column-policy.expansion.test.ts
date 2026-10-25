import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../stores/project/config.js';
import type { ModelOption } from './model-catalog/recency.js';
import { mergeOptionFamilies } from './model-catalog/option-merge.js';
import { expansionDraft } from './right-column-policy.js';

describe('expansionDraft', () => {
  const [gemini4Argon] = mergeOptionFamilies([
    { id: 'gemini-4-argon-high' },
    { id: 'gemini-4-argon-low' },
  ]);
  if (gemini4Argon === undefined) throw new Error('Missing model family');

  const opus: ModelOption = { id: 'opus', effortChoices: ['low', 'medium', 'high'] };
  const codex: ModelOption = { id: 'gpt-5-codex', effortChoices: ['low', 'high'] };
  const routed: ModelOption = {
    id: 'openai/gpt-5.6',
    variants: [
      {
        fullId: 'openai/gpt-5.6',
        providerPrefix: 'openai',
        tag: 'openai',
        variantChoices: ['high', 'max'],
      },
    ],
  };

  it('keeps the drafted option on an offered fallback with an option family', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });

    const draft = expansionDraft(gemini4Argon, {
      expandedModelId: 'gemini-4-argon-high',
      optionDraftId: 'gemini-4-argon-high',
      effortDraft: null,
      currentModel: 'opus',
      role: 'planner',
      slot: 'fallback',
    });

    expect(draft).toEqual({
      optionDraftId: 'gemini-4-argon-high',
      effortDraft: null,
    });
  });

  it('keeps the drafted effort on an offered fallback with an effort', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'low' },
      }),
    });

    const draft = expansionDraft(opus, {
      expandedModelId: 'opus',
      optionDraftId: undefined,
      effortDraft: 'high',
      currentModel: 'gpt-5',
      role: 'planner',
      slot: 'fallback',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: 'high',
    });
  });

  it('resets effort to null on a row of another tool model', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });

    const draft = expansionDraft(codex, {
      expandedModelId: 'opus',
      optionDraftId: undefined,
      effortDraft: 'high',
      currentModel: 'opus',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: null,
    });
  });

  it('reads configured effort for the fallback slot', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: 'opus',
          effort: 'high',
          fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'low' },
        },
      }),
    });

    const draft = expansionDraft(codex, {
      expandedModelId: null,
      optionDraftId: null,
      effortDraft: null,
      currentModel: 'gpt-5-codex',
      role: 'planner',
      slot: 'fallback',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: 'low',
    });
  });

  it('falls back to configured effort when drafted effort is not on row ladder and row matches seat', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'low' },
      }),
    });

    const draft = expansionDraft(opus, {
      expandedModelId: 'opus',
      optionDraftId: undefined,
      effortDraft: 'max',
      currentModel: 'opus',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: 'low',
    });
  });

  it('falls back to null when drafted effort is not on row ladder and row does not match seat', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'low' },
      }),
    });

    const draft = expansionDraft(codex, {
      expandedModelId: 'gpt-5-codex',
      optionDraftId: undefined,
      effortDraft: 'max',
      currentModel: 'opus',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: null,
    });
  });

  it('opens the ladder on the level an effort-flag seat already runs', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
      }),
    });

    const draft = expansionDraft(opus, {
      currentModel: 'opus',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: 'high',
    });
  });

  it('opens the ladder on the preset a variant-channel seat already runs', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'high' },
      }),
    });

    const draft = expansionDraft(routed, {
      currentModel: 'openai/gpt-5.6',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: 'high',
    });
  });

  it('opens the ladder on a variant that the route ladder spells', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'max' },
      }),
    });

    const draft = expansionDraft(routed, {
      currentModel: 'openai/gpt-5.6',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: 'max',
    });
  });

  it('seeds null when the route ladder does not spell the persisted variant', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'cli', tool: 'opencode', model: 'openai/gpt-5.6', variant: 'minimal' },
      }),
    });

    const draft = expansionDraft(routed, {
      currentModel: 'openai/gpt-5.6',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: null,
    });
  });

  it('seeds null when the seat channel is none', () => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({
        planner: { kind: 'shell', command: 'old-command' },
      }),
    });

    const draft = expansionDraft(opus, {
      currentModel: 'opus',
      role: 'planner',
      slot: 'seat',
    });

    expect(draft).toEqual({
      optionDraftId: undefined,
      effortDraft: null,
    });
  });
});
