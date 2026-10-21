import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { runSeatIdentity } from './seat-identity.js';

describe('runSeatIdentity', () => {
  it('keeps each seat tool, model and kind from the same configured runner', () => {
    const identity = runSeatIdentity(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
        implementer: { kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
      }),
    );

    expect(identity).toMatchObject({
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      plannerKind: 'cli',
      implementerKind: 'api',
      reviewerTool: 'codex',
      reviewerModel: 'gpt-5',
      reviewerKind: 'cli',
    });
  });

  it('keeps the axis words each seat runs at', () => {
    const identity = runSeatIdentity(
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'high' },
        implementer: { kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5', effort: 'low' },
      }),
    );

    expect(identity).toMatchObject({
      plannerAxes: ['high'],
      implementerAxes: [],
      reviewerAxes: ['low'],
    });
  });

  it('keeps an api provider that reuses a cli tool name on its own kind', () => {
    const identity = runSeatIdentity(
      makeConfig({
        planner: { kind: 'cli', tool: 'opencode' },
        implementer: { kind: 'api', provider: 'opencode', model: 'qwen2.5-coder:7b' },
      }),
    );

    expect(identity.plannerTool).toBe('opencode');
    expect(identity.plannerKind).toBe('cli');
    expect(identity.implementerTool).toBe('opencode');
    expect(identity.implementerKind).toBe('api');
  });

  it('records no reviewer identity when the planner holds the review seat', () => {
    const identity = runSeatIdentity(makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }));

    expect(identity.plannerKind).toBe('cli');
    expect(identity).not.toHaveProperty('reviewerTool');
    expect(identity).not.toHaveProperty('reviewerKind');
  });
});
