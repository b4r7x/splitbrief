import { describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createDefaultConfig } from '../config/load/defaults.js';
import { detectedSeatReady, selectDefaultCrew, selectInitialCrew } from './default.js';

const runningOllama = {
  provider: 'ollama',
  available: true,
  isLocal: true,
  models: [{ id: 'qwen3-coder:30b' }, { id: 'installed-coder', displayName: 'Installed coder' }],
};

describe('selectInitialCrew', () => {
  it('uses defaults when no crew is detected and no overrides are supplied', () => {
    const selected = selectInitialCrew({ detected: null, overrides: {} });
    expect(selected.effective).toEqual(createDefaultConfig());
    expect(selected.persisted).toEqual(selected.effective);
  });

  it('persists the explicit crew when no crew is detected', () => {
    const selected = selectInitialCrew({
      detected: null,
      overrides: {
        planner: { command: 'node' },
        implementer: { command: 'node', model: 'fixture' },
        reviewer: { command: 'node' },
      },
    });
    expect(selected.effective.planner).toMatchObject({ kind: 'shell', command: 'node' });
    expect(selected.effective.implementer).toMatchObject({
      kind: 'shell',
      command: 'node',
      model: 'fixture',
    });
    expect(selected.effective.reviewer).toMatchObject({ kind: 'shell', command: 'node' });
    expect(selected.persisted).toEqual(selected.effective);
  });

  it('keeps the detected crew for persistence and applies overrides to the invocation', () => {
    const detected = selectDefaultCrew({
      cliTools: [cliDetectionFor('ready', 'codex')],
      providers: [],
    });
    if (detected === null) throw new Error('Expected a ready crew');
    const selected = selectInitialCrew({
      detected,
      overrides: { implementer: { command: 'node', model: 'fixture' } },
    });
    expect(selected.persisted).toEqual(detected);
    expect(selected.effective.planner).toEqual(detected.planner);
    expect(selected.effective.implementer).toMatchObject({
      kind: 'shell',
      command: 'node',
      model: 'fixture',
    });
    expect(selected.effective.reviewer).toBeUndefined();
  });

  it('keeps the detected seats when only a Prompt budget is given, and applies it to the invocation', () => {
    const detected = selectDefaultCrew({
      cliTools: [cliDetectionFor('ready', 'codex')],
      providers: [],
    });
    if (detected === null) throw new Error('Expected a ready crew');
    const selected = selectInitialCrew({
      detected,
      overrides: { planner: { contextLength: 200_000 }, implementer: { contextLength: 32_768 } },
    });
    expect(selected.persisted).toEqual(detected);
    expect(selected.effective.planner).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      contextLength: 200_000,
    });
    expect(selected.effective.implementer).toMatchObject({
      kind: 'cli',
      tool: 'codex',
      contextLength: 32_768,
    });
  });

  it('keeps a Prompt budget out of the saved crew when no crew is detected', () => {
    const selected = selectInitialCrew({
      detected: null,
      overrides: { implementer: { contextLength: 4096 } },
    });
    expect(selected.effective.implementer.contextLength).toBe(4096);
    expect(selected.persisted).toEqual(createDefaultConfig());
  });
});

describe('selectInitialCrew with an implementer flag over the default crew', () => {
  it('refuses --implementer ollama with no model', () => {
    expect(() =>
      selectInitialCrew({ detected: null, overrides: { implementer: { tool: 'ollama' } } }),
    ).toThrow("implementer: 'model' is required but was not provided.");
  });

  it('gives Claude Code with the model of --implementer-model alone', () => {
    const selected = selectInitialCrew({
      detected: null,
      overrides: { implementer: { model: 'opus' } },
    });
    expect(selected.effective.implementer).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      model: 'opus',
    });
  });

  it('keeps Claude Code and drops the endpoint of --implementer-api-base with no tool', () => {
    const selected = selectInitialCrew({
      detected: null,
      overrides: { implementer: { apiBase: 'http://127.0.0.1:12434/v1', model: 'custom-coder' } },
    });
    expect(selected.effective.implementer).toEqual({
      kind: 'cli',
      tool: 'claude-code',
      model: 'custom-coder',
    });
  });
});

describe('selectDefaultCrew', () => {
  it('uses a ready build tool when the default local server is unavailable', () => {
    const config = selectDefaultCrew({
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'opencode')],
      providers: [{ provider: 'ollama', available: false, isLocal: true }],
    });
    expect(config?.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
    expect(config?.implementer).toEqual({ kind: 'cli', tool: 'claude-code' });
    expect(config?.reviewer).toBeUndefined();
  });

  it('takes the first ready tool of claude-code, codex, opencode, then the other listed tools for BUILD', () => {
    const order = ['claude-code', 'codex', 'opencode', 'kilo-code'] as const;
    const builds = order.map(
      (_, index) =>
        selectDefaultCrew({
          cliTools: order
            .slice(index)
            .reverse()
            .map((tool) => cliDetectionFor('ready', tool)),
          providers: [],
        })?.implementer,
    );
    expect(builds).toEqual(order.map((tool) => ({ kind: 'cli', tool })));
  });

  it('falls back for both seats and refuses a crew when no tool is ready', () => {
    const cliTools = [
      cliDetectionFor('unavailable', 'claude-code'),
      cliDetectionFor('unauthenticated', 'opencode'),
      cliDetectionFor('ready', 'codex'),
    ];
    const config = selectDefaultCrew({ cliTools, providers: [] });
    expect(config?.planner).toEqual({ kind: 'cli', tool: 'codex' });
    expect(config?.implementer).toEqual({ kind: 'cli', tool: 'codex' });
    expect(selectDefaultCrew({ cliTools: cliTools.slice(0, 2), providers: [] })).toBeNull();
  });

  it('keeps a running Ollama with listed models out of the BUILD seat', () => {
    const config = selectDefaultCrew({
      cliTools: [cliDetectionFor('ready', 'claude-code')],
      providers: [runningOllama],
    });
    expect(config?.implementer).toEqual({ kind: 'cli', tool: 'claude-code' });
  });

  it('refuses a crew when no CLI tool is ready, also when Ollama runs with listed models', () => {
    const cliTools = [
      cliDetectionFor('unavailable', 'claude-code'),
      cliDetectionFor('unauthenticated', 'opencode'),
    ];
    expect(selectDefaultCrew({ cliTools, providers: [runningOllama] })).toBeNull();
  });
});

describe('detectedSeatReady', () => {
  it('reads an API seat as ready only on a model its server lists', () => {
    const seat = makeConfig({
      implementer: { kind: 'api', provider: 'ollama', model: 'installed-coder' },
    }).implementer;
    const detection = { cliTools: [], providers: [runningOllama] };
    expect(detectedSeatReady(seat, detection)).toBe(true);
    expect(detectedSeatReady({ ...seat, model: 'missing-coder' }, detection)).toBe(false);
  });
});
