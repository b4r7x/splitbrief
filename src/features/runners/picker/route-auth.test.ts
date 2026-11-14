import { describe, expect, it } from 'vitest';
import { formatRouteAuth, formatRouteRemedy } from './route-auth.js';
import { SOFT_SEP } from '../../../core/separators.js';

describe('formatRouteAuth', () => {
  it('claims nothing when the tool cannot report sign-in state', () => {
    expect(formatRouteAuth({ auth: { kind: 'unchecked' } })).toEqual({
      word: undefined,
      dim: false,
    });
  });

  it('names a configured route by credential source', () => {
    expect(formatRouteAuth({ auth: { kind: 'configured', source: 'oauth' } })).toEqual({
      word: 'signed in · oauth',
      dim: false,
    });
    expect(formatRouteAuth({ auth: { kind: 'configured', source: 'api' } }).word).toBe(
      'signed in · api key',
    );
  });

  it('distinguishes a configured route, a missing one and an unreadable one', () => {
    const configured = formatRouteAuth({
      auth: { kind: 'configured', source: 'oauth' },
    });
    const missing = formatRouteAuth({
      auth: { kind: 'needs-sign-in', tool: 'opencode', provider: 'openai' },
    });
    const unknown = formatRouteAuth({
      auth: { kind: 'unknown', reason: 'timeout' },
    });

    expect(configured.word).toBe('signed in · oauth');
    expect(configured.dim).toBe(false);
    expect(missing.word).toBe('needs sign-in');
    expect(missing.dim).toBe(true);
    expect(unknown.word).toBe('sign-in unknown');
    expect(unknown.dim).toBe(true);
    expect(new Set([configured.word, missing.word, unknown.word]).size).toBe(3);
  });

  it('reads every route of a tool signed in to no provider as needing a sign-in, as it read before', () => {
    expect(
      formatRouteAuth({
        auth: { kind: 'unknown', reason: 'empty', tool: 'opencode', provider: 'ollama' },
      }),
    ).toEqual({ word: 'needs sign-in', dim: true });
  });

  it('reads a route the tool lists, with no credential behind it, as available rather than signed in', () => {
    expect(formatRouteAuth({ auth: { kind: 'configured', source: 'listed' } })).toEqual({
      word: 'available',
      dim: false,
    });
  });

  it('names the environment variable a configured route reads', () => {
    expect(
      formatRouteAuth({
        auth: { kind: 'configured', source: 'env', envVar: 'OPENAI_API_KEY' },
      }).word,
    ).toContain('OPENAI_API_KEY');
  });
});

describe('formatRouteRemedy', () => {
  const route = {
    toolName: 'OpenCode CLI',
    oracleCommand: 'opencode providers list',
    versions: { observed: '0.3.0', required: '0.40.0' },
  };

  it('has nothing to remedy for a configured route', () => {
    expect(formatRouteRemedy({ auth: { kind: 'configured', source: 'oauth' }, ...route })).toBe(
      undefined,
    );
  });

  it('leads with the sign-in command for a route the tool has no credential for', () => {
    const remedy =
      formatRouteRemedy({
        auth: { kind: 'needs-sign-in', tool: 'opencode', provider: 'opencode-go' },
        ...route,
      }) ?? '';

    expect(remedy).toContain('opencode auth login opencode-go');
    expect(remedy.indexOf('opencode auth login opencode-go')).toBeLessThan(
      remedy.indexOf('ctrl+r'),
    );
  });

  it('names the sign-in command when the tool is signed in to no provider, as it did before', () => {
    expect(
      formatRouteRemedy({
        auth: { kind: 'unknown', reason: 'empty', tool: 'opencode', provider: 'ollama' },
        ...route,
      }),
    ).toBe('signed in to no providers yet: opencode auth login ollama · then ctrl+r');
  });

  it('asks for the model list, not a sign-in check, when only the model list was not read', () => {
    const remedy =
      formatRouteRemedy({ auth: { kind: 'unknown', reason: 'catalog-not-read' }, ...route }) ?? '';

    expect(remedy.startsWith('ctrl+r to read the model list')).toBe(true);
    expect(remedy).not.toBe(
      formatRouteRemedy({ auth: { kind: 'unknown', reason: 'not-probed' }, ...route }),
    );
  });

  it.each(['timeout', 'exit-failure', 'parse-failure', 'version-mismatch', 'not-probed'] as const)(
    'puts the action ahead of the explanation for %s',
    (reason) => {
      const remedy = formatRouteRemedy({ auth: { kind: 'unknown', reason }, ...route }) ?? '';
      const [head = ''] = remedy.split(SOFT_SEP);

      expect(remedy).not.toBe('');
      expect(head).toMatch(/ctrl\+r|upgrade|auth login/);
    },
  );

  it('names the version gap the upgrade has to close', () => {
    const remedy =
      formatRouteRemedy({ auth: { kind: 'unknown', reason: 'version-mismatch' }, ...route }) ?? '';

    expect(remedy).toContain('0.3.0');
    expect(remedy).toContain('0.40.0');
  });

  it('never dangles a retry promise in front of the parse failure it cannot fix', () => {
    const remedy =
      formatRouteRemedy({ auth: { kind: 'unknown', reason: 'parse-failure' }, ...route }) ?? '';

    expect(remedy).toContain('will not help');
    expect(remedy.indexOf('ctrl+r')).toBe(remedy.indexOf('ctrl+r will not help'));
  });

  it('says the state is unreadable, not that the route needs sign-in, without an oracle', () => {
    const remedy = formatRouteRemedy({ auth: { kind: 'unchecked' }, ...route }) ?? '';

    expect(remedy).toContain('OpenCode CLI');
    expect(remedy).not.toContain('ctrl+r');
    expect(remedy).not.toContain('needs sign-in');
  });
});
