import { describe, expect, it } from 'vitest';
import { formatConfigLoaderDiagnostic } from '../../config/load/io.js';
import type { ConfigLoaderDiagnostic } from '../../config/load/io.js';
import { buildConfigChecks } from './config.js';

describe('buildConfigChecks', () => {
  it('sets fix-config for config-migration loader diagnostics', () => {
    const checks = buildConfigChecks({
      state: 'loaded',
      path: '/tmp/.splitbrief/config.yaml',
      warnings: [
        {
          source: 'loader',
          diagnostic: { kind: 'config-migration', code: 'deprecated-v2' },
        },
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

    const migration = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('deprecated'),
    );
    const permissions = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('permissive'),
    );
    const validation = checks.find(
      (check) => check.id === 'config.warning' && check.summary.includes('unknown model'),
    );

    expect(migration?.nextAction).toBe('fix-config');
    expect(migration?.fix).toContain('reconfigure');
    expect(permissions?.nextAction).toBeUndefined();
    expect(validation?.nextAction).toBeUndefined();
  });

  it('does not offer a config rewrite for a validation warning with migration wording', () => {
    const diagnostic = {
      kind: 'config-migration',
      code: 'deprecated-v2',
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
