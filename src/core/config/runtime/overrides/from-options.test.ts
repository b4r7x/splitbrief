import { describe, it, expect } from 'vitest';
import { resolveCliWorkflowMode } from './from-options.js';
import type { Config } from '../../../schemas/config.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

function buildBaseConfig(): Config {
  const c = makeConfig({ workflow: { approve: 'default' } });
  delete (c.workflow as Record<string, unknown>).autoApproveSpec;
  delete (c.workflow as Record<string, unknown>).autoApprovePlan;
  return c;
}
const baseConfig: Config = buildBaseConfig();

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
