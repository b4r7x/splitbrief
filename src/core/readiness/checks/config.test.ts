import { describe, expect, it } from 'vitest';
import { formatConfigLoaderDiagnostic } from '../../config/load/io.js';
import type { ConfigLoaderDiagnostic } from '../../config/load/io.js';
import { buildConfigChecks } from './config.js';

describe('buildConfigChecks', () => {
  it('surfaces loader and validation warnings without a next action', () => {
    const checks = buildConfigChecks({
      state: 'loaded',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [
        {
          source: 'loader',
          diagnostic: {
            kind: 'config-file-permissions',
            path: '/tmp/.splitbrief/config.yaml',
          },
        },
        { source: 'validation', message: 'planner.model: unknown model' },
      ],
    });

    const permissions = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('permissive'),
    );
    const validation = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('unknown model'),
    );

    expect(permissions?.nextAction).toBeUndefined();
    expect(validation?.nextAction).toBeUndefined();
  });

  it('publishes the loader diagnostic state on an invalid config', () => {
    const [check] = buildConfigChecks({
      state: 'invalid',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [],
      error: 'implementer.apiBase: Invalid apiBase: must use http or https',
      diagnosticState: 'endpoint-invalid',
    });

    expect(check?.id).toBe('config.invalid');
    expect(check?.diagnosticState).toBe('endpoint-invalid');
  });

  it('publishes no diagnostic state when the loader reports no known failure family', () => {
    const [check] = buildConfigChecks({
      state: 'invalid',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [],
      error: 'planner.model: Required',
    });

    expect(check?.diagnosticState).toBeUndefined();
  });

  it('does not offer a config rewrite for a validation warning that repeats a loader message', () => {
    const diagnostic = {
      kind: 'config-file-permissions',
      path: '/tmp/.splitbrief/config.yaml',
    } satisfies ConfigLoaderDiagnostic;
    const message = formatConfigLoaderDiagnostic(diagnostic);

    const checks = buildConfigChecks({
      state: 'loaded',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [{ source: 'validation', message }],
    });
    const warning = checks.find((check) => check.id === 'config.warning');

    expect(warning?.summary).toBe(message);
    expect(warning?.nextAction).toBeUndefined();
    expect(warning?.fix).toBeUndefined();
  });
});
