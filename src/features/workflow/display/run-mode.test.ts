import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { resolveRunMode } from './run-mode.js';

function config(mode: WorkflowMode) {
  return makeConfig({ workflow: { mode } });
}

describe('resolveRunMode', () => {
  it('leads with the engine-resolved mode over the record and the config', () => {
    expect(
      resolveRunMode({
        resolvedMode: 'quick',
        savedMode: 'speckit',
        preparedConfig: config('standard'),
        config: config('standard'),
      }),
    ).toBe('quick');
  });

  it('falls back to the prepared run’s recorded mode before the config', () => {
    expect(
      resolveRunMode({
        resolvedMode: null,
        savedMode: 'speckit',
        preparedConfig: config('quick'),
        config: config('standard'),
      }),
    ).toBe('speckit');
  });

  it('reads the prepared execution’s config before the store’s next-run config', () => {
    const prepared = config('quick');
    expect(
      resolveRunMode({
        resolvedMode: null,
        savedMode: null,
        preparedConfig: prepared,
        config: config('standard'),
      }),
    ).toBe('quick');
    // A `/mode … for the next run` write moves the store's config only; the run keeps its own.
    expect(
      resolveRunMode({
        resolvedMode: null,
        savedMode: null,
        preparedConfig: prepared,
        config: config('speckit'),
      }),
    ).toBe('quick');
  });

  it('reads the store’s config mode only while a run has no prepared execution either', () => {
    expect(
      resolveRunMode({
        resolvedMode: null,
        savedMode: null,
        preparedConfig: null,
        config: config('speckit'),
      }),
    ).toBe('speckit');
    expect(
      resolveRunMode({
        resolvedMode: null,
        savedMode: null,
        preparedConfig: null,
        config: config('standard'),
      }),
    ).toBe('standard');
  });

  it('answers nothing without a config to stand on', () => {
    expect(
      resolveRunMode({ resolvedMode: null, savedMode: null, preparedConfig: null, config: null }),
    ).toBeNull();
  });

  it('keeps a fresh run on its resolved mode after the next-run config changes', () => {
    const before = resolveRunMode({
      resolvedMode: 'quick',
      savedMode: null,
      preparedConfig: config('quick'),
      config: config('standard'),
    });
    const after = resolveRunMode({
      resolvedMode: 'quick',
      savedMode: null,
      preparedConfig: config('quick'),
      config: config('speckit'),
    });

    expect(after).toBe(before);
    expect(after).toBe('quick');
  });
});
