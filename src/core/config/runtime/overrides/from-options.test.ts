import { describe, it, expect } from 'vitest';
import { resolveCliWorkflowMode } from './from-options.js';
import type { Config } from '../../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

const baseConfig: Config = makeConfig({ workflow: { approve: 'default' } });

describe('resolveCliWorkflowMode', () => {
  it('uses the config workflow mode when --mode is omitted', () => {
    const config: Config = { ...baseConfig, workflow: { ...baseConfig.workflow, mode: 'quick' } };
    expect(resolveCliWorkflowMode({}, config)).toBe('quick');
  });

  it('prefers an explicit --mode override', () => {
    const config: Config = { ...baseConfig, workflow: { ...baseConfig.workflow, mode: 'quick' } };
    expect(resolveCliWorkflowMode({ mode: 'speckit' }, config)).toBe('speckit');
  });
});
