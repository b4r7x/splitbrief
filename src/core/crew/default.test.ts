import { describe, expect, it } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { createDefaultConfig } from '../config/load/defaults.js';
import { detectedSeatReady, selectDefaultCrew, selectInitialCrew } from './default.js';

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
});

describe('selectDefaultCrew', () => {
  it('uses a ready build tool when the default local server is unavailable', () => {
    const config = selectDefaultCrew({
      cliTools: [cliDetectionFor('ready', 'claude-code'), cliDetectionFor('ready', 'opencode')],
      providers: [{ provider: 'ollama', available: false, isLocal: true }],
    });
    expect(config?.planner).toEqual({ kind: 'cli', tool: 'claude-code' });
    expect(config?.implementer).toEqual({ kind: 'cli', tool: 'opencode' });
    expect(config?.reviewer).toBeUndefined();
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

  it('selects only a model the local server lists', () => {
    const cliTools = [cliDetectionFor('ready', 'claude-code')];
    const provider = { provider: 'ollama' as const, available: true, isLocal: true };
    expect(selectDefaultCrew({ cliTools, providers: [provider] })?.implementer.kind).toBe('cli');
    const models = [{ id: 'installed-coder', displayName: 'Installed coder' }];
    const detected = { cliTools, providers: [{ ...provider, models }] };
    const config = selectDefaultCrew(detected);
    expect(config?.implementer).toMatchObject({ provider: 'ollama', model: 'installed-coder' });
    expect(detectedSeatReady(createDefaultConfig().implementer, detected)).toBe(false);
    if (config === null) throw new Error('Expected a ready crew');
    expect(detectedSeatReady(config.implementer, detected)).toBe(true);
  });
});
