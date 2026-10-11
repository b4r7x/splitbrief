import { describe, expect, it } from 'vitest';
import { HELP_EXAMPLES } from '../../../src/cli/help-examples.js';
import { getApiProviderDescriptor } from '../../../src/core/providers/api-provider-catalog.js';
import { CLI_TOOL_CATALOG, isCliToolId } from '../../../src/core/runners/cli-tool-catalog.js';

describe('CLI help examples', () => {
  it('uses only catalog tools and providers that admit the named seat', () => {
    const overrides = [
      ...HELP_EXAMPLES.matchAll(/--(planner|reviewer|implementer|provider) (\S+)/g),
    ];
    expect(overrides.length).toBeGreaterThan(0);

    for (const [, flag, tool] of overrides) {
      if (tool === undefined) throw new Error('missing tool in help example');
      const role = flag === 'provider' ? 'implementer' : flag;
      const roles = isCliToolId(tool)
        ? CLI_TOOL_CATALOG[tool].roles
        : getApiProviderDescriptor(tool)?.roles;

      expect(roles, `${flag} ${tool}`).toContain(role);
    }
  });

  it('shows catalog-backed provider overrides', () => {
    expect(
      HELP_EXAMPLES.split('\n')
        .filter((line) => line.includes('--planner '))
        .join('\n'),
    ).toMatchInlineSnapshot(
      `"    $ splitbrief "add tests" --planner claude-code --implementer ollama"`,
    );
  });
});
