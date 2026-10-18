import { describe, expect, it } from 'vitest';
import type { SavedCatalog } from '../discovery/catalog-read-merge.js';
import type { CliProviderAuth, CliProviderAuthFact } from '../discovery/detection.js';
import type { CliToolId } from './cli-tool-catalog.js';
import {
  routeAuthState,
  routeNoCredential,
  routeRefusal,
  routeSignInCommand,
} from './route-auth.js';

// Shapes `opencode auth list --standalone --format json` prints (opencode 2.0.29):
// the listing's provider `id` is the model-id segment, the name is display text.
const GO: CliProviderAuthFact = { id: 'opencode-go', provider: 'OpenCode Go', source: 'stored' };
const KIMI_GLOBAL: CliProviderAuthFact = {
  id: 'kimi-code-plan-global',
  provider: 'Kimi For Coding (kimi.ai)',
  source: 'env',
  envVar: 'KIMI_API_KEY',
};
const DEEPSEEK: CliProviderAuthFact = { id: 'deepseek', provider: 'DeepSeek', source: 'stored' };
// The boxed listing opencode 1 and kilo print: display names only, no id.
const BOXED_GO: CliProviderAuthFact = { provider: 'OpenCode Go', source: 'api' };
const BOXED_ZEN: CliProviderAuthFact = { provider: 'OpenCode', source: 'api' };
const BOXED_GO_ENV: CliProviderAuthFact = {
  provider: 'OpenCode Go',
  source: 'env',
  envVar: 'OPENCODE_GO_API_KEY',
};

/** A model listing read once, serving nothing: the tool lists no route of its own. */
const LISTS_NOTHING: SavedCatalog = { models: [] };

function listing(...ids: string[]): SavedCatalog {
  return { models: ids.map((id) => ({ id })) };
}

function stateOf(
  model: string,
  providerAuth: CliProviderAuth,
  catalog: SavedCatalog | null = LISTS_NOTHING,
  tool: CliToolId = 'opencode',
): ReturnType<typeof routeAuthState> {
  return routeAuthState({ tool, model, providerAuth, catalog });
}

function kindOf(model: string, facts: readonly CliProviderAuthFact[]): string {
  return stateOf(model, { kind: 'read', facts }).kind;
}

describe('credential-to-provider assignment', () => {
  it('matches the listing id to the model-id segment, not the display name', () => {
    expect(stateOf('kimi-code-plan-global/k3', { kind: 'read', facts: [KIMI_GLOBAL] })).toEqual({
      kind: 'configured',
      source: 'env',
      envVar: 'KIMI_API_KEY',
    });
    expect(kindOf('kimi-code-plan-cn/k3', [KIMI_GLOBAL])).toBe('needs-sign-in');
    expect(kindOf('kimi/k3', [KIMI_GLOBAL])).toBe('needs-sign-in');
    expect(kindOf('opencode-go/kimi-k3', [GO])).toBe('configured');
    expect(kindOf('opencode/big-pickle', [GO])).toBe('needs-sign-in');
  });

  it('keeps OpenCode and OpenCode Go apart in the boxed listing, credentials and env alike', () => {
    expect(kindOf('opencode-go/kimi-k3', [BOXED_GO])).toBe('configured');
    expect(kindOf('opencode/big-pickle', [BOXED_ZEN])).toBe('configured');
    expect(kindOf('opencode/big-pickle', [BOXED_GO])).toBe('needs-sign-in');
    expect(kindOf('opencode-go/kimi-k3', [BOXED_ZEN])).toBe('needs-sign-in');
    expect(kindOf('opencode-go/kimi-k3', [BOXED_GO_ENV])).toBe('configured');
    expect(kindOf('opencode/big-pickle', [BOXED_GO_ENV])).toBe('needs-sign-in');
  });

  it('backs the documented boxed aliases: Alibaba Coding Plan to alibaba, GitHub Copilot to github-copilot', () => {
    expect(kindOf('alibaba/qwen3', [{ provider: 'Alibaba Coding Plan', source: 'api' }])).toBe(
      'configured',
    );
    const copilot: CliProviderAuthFact = { provider: 'GitHub Copilot', source: 'oauth' };
    expect(kindOf('github-copilot/gpt-5.6', [copilot])).toBe('configured');
    expect(kindOf('copilot/gpt-5.6', [copilot])).toBe('needs-sign-in');
  });

  it('rejects shared prefixes and env stems that only resemble the segment', () => {
    expect(kindOf('open/x', [BOXED_GO])).toBe('needs-sign-in');
    expect(kindOf('ollama/llama3', [{ provider: 'Ollama Cloud', source: 'api' }])).toBe(
      'needs-sign-in',
    );
    const openrouterFree: CliProviderAuthFact = {
      provider: 'OpenRouter Free',
      source: 'env',
      envVar: 'OPENROUTER_FREE_API_KEY',
    };
    expect(kindOf('openrouter/free', [openrouterFree])).toBe('needs-sign-in');
  });

  it('lets an unknown boxed identity back only its own slug', () => {
    const vendor: CliProviderAuthFact = { provider: 'Some Future Vendor', source: 'api' };
    expect(kindOf('opencode/x', [vendor])).toBe('needs-sign-in');
    expect(kindOf('some-future-vendor/x', [vendor])).toBe('configured');
    expect(kindOf('some/x', [vendor])).toBe('needs-sign-in');
  });
});

describe('routeAuthState', () => {
  const model = 'openai/gpt-5.6';

  it('claims nothing when the tool has no credential listing, the seat has no model, or the model names no route', () => {
    const providerAuth = {
      kind: 'read',
      facts: [{ provider: 'OpenAI', source: 'oauth' }],
    } as const;
    const catalog = LISTS_NOTHING;
    expect(routeAuthState({ tool: 'codex', model, providerAuth, catalog })).toEqual({
      kind: 'unchecked',
    });
    expect(routeAuthState({ tool: undefined, model, providerAuth, catalog })).toEqual({
      kind: 'unchecked',
    });
    expect(routeAuthState({ tool: 'opencode', model: undefined, providerAuth, catalog })).toEqual({
      kind: 'unchecked',
    });
    expect(routeAuthState({ tool: 'opencode', model: 'auto', providerAuth, catalog })).toEqual({
      kind: 'unchecked',
    });
  });

  it('reads a listing signed in to no provider, whose read model list does not serve the route, as empty', () => {
    expect(stateOf(model, { kind: 'empty' })).toEqual({
      kind: 'unknown',
      reason: 'empty',
      tool: 'opencode',
      provider: 'openai',
    });
    expect(stateOf(model, { kind: 'read', facts: [] })).toEqual({
      kind: 'unknown',
      reason: 'empty',
      tool: 'opencode',
      provider: 'openai',
    });
  });

  it('reads a route the model list serves as set up while the tool stores no credential at all', () => {
    // A local-only OpenCode: `ollama/llama3` set up in the global opencode.json, `auth list` prints [].
    expect(stateOf('ollama/llama3', { kind: 'empty' }, listing('ollama/llama3'))).toEqual({
      kind: 'configured',
      source: 'listed',
    });
    expect(
      stateOf(
        'ollama/llama3',
        { kind: 'empty' },
        { models: [{ id: 'ollama/llama3' }] },
        'kilo-code',
      ),
    ).toEqual({ kind: 'configured', source: 'listed' });
  });

  it('reads an empty listing as empty when the read model list does not serve the route', () => {
    expect(stateOf('ollama/llama3', { kind: 'empty' }, listing('lmstudio/qwen3'))).toEqual({
      kind: 'unknown',
      reason: 'empty',
      tool: 'opencode',
      provider: 'ollama',
    });
    expect(
      stateOf(
        'ollama/llama3',
        { kind: 'empty' },
        {
          models: [{ id: 'ollama/llama3' }],
          missingOnce: ['ollama/llama3'],
        },
      ),
    ).toEqual({ kind: 'unknown', reason: 'empty', tool: 'opencode', provider: 'ollama' });
  });

  it('reads an empty listing whose model list was not read, or failed to read, as catalog-not-read', () => {
    // A failed read reaches here as no list at all: nothing proves the route is signed out.
    expect(stateOf('ollama/llama3', { kind: 'empty' }, null)).toEqual({
      kind: 'unknown',
      reason: 'catalog-not-read',
    });
    expect(stateOf('ollama/llama3', { kind: 'empty' }, { models: null })).toEqual({
      kind: 'unknown',
      reason: 'catalog-not-read',
    });
    expect(routeRefusal(stateOf('ollama/llama3', { kind: 'empty' }, null))).toEqual({
      kind: 'unknown',
    });
  });

  it("never reads the tool's own gateway as set up while the tool stores no credential", () => {
    expect(
      stateOf('opencode/big-pickle', { kind: 'empty' }, listing('opencode/big-pickle')),
    ).toEqual({ kind: 'unknown', reason: 'empty', tool: 'opencode', provider: 'opencode' });
    expect(stateOf('opencode/big-pickle', { kind: 'empty' }, null)).toEqual({
      kind: 'unknown',
      reason: 'empty',
      tool: 'opencode',
      provider: 'opencode',
    });
  });

  it('names the source when a fact backs the route provider', () => {
    expect(kindOf(model, [{ provider: 'OpenAI', source: 'oauth' }])).toBe('configured');
    expect(
      stateOf(model, { kind: 'read', facts: [{ provider: 'OpenAI', source: 'oauth' }] }),
    ).toEqual({ kind: 'configured', source: 'oauth' });
  });

  it('needs sign-in, naming the tool and the provider, when the listing names other providers only', () => {
    expect(stateOf(model, { kind: 'read', facts: [DEEPSEEK] })).toEqual({
      kind: 'needs-sign-in',
      tool: 'opencode',
      provider: 'openai',
    });
  });

  it('reads a route the tool lists as usable when its provider is set up outside the credential listing', () => {
    // A provider defined in opencode.json (a local ollama, a proxy with apiKey)
    // has no credential entry, but the tool's own model listing serves it.
    const lists = listing('ollama/llama3');
    expect(stateOf('ollama/llama3', { kind: 'read', facts: [DEEPSEEK] }, lists)).toEqual({
      kind: 'configured',
      source: 'listed',
    });
    expect(stateOf('ollama/llama3', { kind: 'read', facts: [DEEPSEEK] })).toEqual({
      kind: 'needs-sign-in',
      tool: 'opencode',
      provider: 'ollama',
    });
  });

  it('reads a model id the listing lacks on a provider it serves as set up: the model is the cause', () => {
    expect(
      stateOf('ollama/llama-typo', { kind: 'read', facts: [DEEPSEEK] }, listing('ollama/llama3')),
    ).toEqual({ kind: 'configured', source: 'listed' });
  });

  it('reads the model list as not read when no credential backs the route and the model listing was never read', () => {
    expect(stateOf('ollama/llama3', { kind: 'read', facts: [DEEPSEEK] }, null)).toEqual({
      kind: 'unknown',
      reason: 'catalog-not-read',
    });
    expect(stateOf('ollama/llama3', { kind: 'read', facts: [DEEPSEEK] }, { models: null })).toEqual(
      { kind: 'unknown', reason: 'catalog-not-read' },
    );
    expect(stateOf('deepseek/v4', { kind: 'read', facts: [DEEPSEEK] }, null)).toEqual({
      kind: 'configured',
      source: 'stored',
    });
  });

  it("never reads the tool's own gateway account as set up because the tool lists its models", () => {
    expect(
      stateOf(
        'opencode/big-pickle',
        { kind: 'read', facts: [DEEPSEEK] },
        listing('opencode/big-pickle'),
      ),
    ).toEqual({ kind: 'needs-sign-in', tool: 'opencode', provider: 'opencode' });
    expect(
      stateOf(
        'kilo/openrouter/free',
        { kind: 'read', facts: [DEEPSEEK] },
        listing('kilo/openrouter/free'),
        'kilo-code',
      ),
    ).toEqual({ kind: 'needs-sign-in', tool: 'kilo-code', provider: 'kilo' });
    expect(stateOf('opencode/big-pickle', { kind: 'read', facts: [DEEPSEEK] }, null)).toEqual({
      kind: 'needs-sign-in',
      tool: 'opencode',
      provider: 'opencode',
    });
  });

  it("reads another tool's gateway segment like any provider: only the seat's own gateway needs its credential", () => {
    expect(
      stateOf(
        'opencode/big-pickle',
        { kind: 'read', facts: [DEEPSEEK] },
        listing('opencode/big-pickle'),
        'kilo-code',
      ),
    ).toEqual({ kind: 'configured', source: 'listed' });
    expect(
      stateOf('kilo/openrouter/free', { kind: 'read', facts: [DEEPSEEK] }, null, 'opencode'),
    ).toEqual({ kind: 'unknown', reason: 'catalog-not-read' });
  });

  it('carries the reason an unreadable listing gave', () => {
    expect(stateOf(model, { kind: 'unreadable', reason: 'parse-failure' }, listing(model))).toEqual(
      {
        kind: 'unknown',
        reason: 'parse-failure',
      },
    );
  });
});

describe('route sign-in words', () => {
  it("spells the tool's own sign-in command", () => {
    expect(routeSignInCommand('opencode', 'ollama-cloud')).toBe('opencode auth login ollama-cloud');
    expect(routeSignInCommand('kilo-code', 'openrouter')).toBe('kilo auth login openrouter');
  });
});

describe('a seat route against the saved model list', () => {
  const route = 'ollama-cloud/glm-5';
  const signedInToGo: CliProviderAuth = { kind: 'read', facts: [GO] };

  it("reads a route the tool's saved model list serves as configured, with no credential named", () => {
    expect(
      routeAuthState({
        tool: 'opencode',
        model: route,
        providerAuth: signedInToGo,
        catalog: { models: [{ id: route }] },
      }),
    ).toEqual({ kind: 'configured', source: 'listed' });
  });

  it('reads a provider whose every row the last successful read dropped as needing sign-in', () => {
    expect(
      routeAuthState({
        tool: 'opencode',
        model: route,
        providerAuth: signedInToGo,
        catalog: {
          models: [{ id: route }, { id: 'ollama-cloud/kimi-k3' }, { id: 'opencode-go/kimi-k3' }],
          missingOnce: [route, 'ollama-cloud/kimi-k3'],
        },
      }),
    ).toEqual({ kind: 'needs-sign-in', tool: 'opencode', provider: 'ollama-cloud' });
  });

  it('reads a dropped route as set up while another row of its provider survives', () => {
    expect(
      routeAuthState({
        tool: 'opencode',
        model: route,
        providerAuth: signedInToGo,
        catalog: {
          models: [{ id: route }, { id: 'ollama-cloud/kimi-k3' }],
          missingOnce: [route],
        },
      }),
    ).toEqual({ kind: 'configured', source: 'listed' });
  });

  it('claims no sign-in for a project with no saved model list', () => {
    expect(
      routeAuthState({
        tool: 'opencode',
        model: route,
        providerAuth: signedInToGo,
        catalog: undefined,
      }),
    ).toEqual({ kind: 'unknown', reason: 'catalog-not-read' });
  });
});

describe('routeRefusal', () => {
  it('names the provider of a signed-out route, and the model or both causes otherwise', () => {
    expect(
      routeRefusal({ kind: 'needs-sign-in', tool: 'opencode', provider: 'ollama-cloud' }),
    ).toEqual({
      kind: 'signed-out',
      provider: 'ollama-cloud',
    });
    expect(routeRefusal({ kind: 'configured', source: 'listed' })).toEqual({ kind: 'wrong-model' });
    expect(routeRefusal({ kind: 'unchecked' })).toEqual({ kind: 'wrong-model' });
    expect(routeRefusal({ kind: 'unknown', reason: 'exit-failure' })).toEqual({ kind: 'unknown' });
    expect(routeRefusal({ kind: 'unknown', reason: 'catalog-not-read' })).toEqual({
      kind: 'unknown',
    });
  });

  it('reads a refusal as signed out when the tool stores no credential and the model list does not serve the route', () => {
    expect(
      routeRefusal({ kind: 'unknown', reason: 'empty', tool: 'opencode', provider: 'ollama' }),
    ).toEqual({ kind: 'signed-out', provider: 'ollama' });
  });

  it("spells a route with no credential in doctor's words", () => {
    expect(routeNoCredential('opencode', 'ollama-cloud')).toBe(
      'OpenCode CLI has no credential for ollama-cloud',
    );
  });

  it('names the provider by the id its sign-in command takes, never a tool name', () => {
    expect(routeNoCredential('opencode', 'opencode')).toBe(
      'OpenCode CLI has no credential for opencode',
    );
    expect(routeNoCredential('opencode', 'ollama')).toBe(
      'OpenCode CLI has no credential for ollama',
    );
    expect(routeNoCredential('kilo-code', 'cursor')).toBe(
      'Kilo Code CLI has no credential for cursor',
    );
  });
});
