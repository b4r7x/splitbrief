import { describe, expect, it } from 'vitest';
import { isDeclaredCliProbeContract } from '../runners/cli-tools/contract.js';
import { lookupCliReadinessProbe } from '../runners/cli-tools/registry.js';

describe('OpenCode catalog probe parsing', () => {
  it.each(['planner', 'implementer'] as const)(
    'returns a successful empty read through the %s declared probe',
    (role) => {
      const contract = lookupCliReadinessProbe({ tool: 'opencode', role });
      if (!isDeclaredCliProbeContract(contract) || contract.declared.catalog.kind !== 'catalog') {
        throw new Error('Expected an OpenCode catalog probe');
      }
      const output = {
        stdout: '{"data": []}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        outputExceeded: false,
      };

      expect(contract.declared.catalog.parse(output)).toEqual({ kind: 'success', value: [] });
      for (const stdout of ['{"data": [', '{"models": []}', '{"data": null}']) {
        expect(contract.declared.catalog.parse({ ...output, stdout })).toEqual({
          kind: 'malformed',
        });
      }
    },
  );
});
