# 01 — Anthropic Prompt Caching

> Implement only this brief. Do not run git add/commit/stage/stash.

## Goal

Enable Anthropic API prompt caching by sending the system prompt as an array of content blocks with `cache_control` markers. The system prompt and repo-map are stable across planner calls within a session — caching them saves 80-90% on repeated input tokens.

## Required Skills

- `/claude-api` — verify current Anthropic prompt caching format before writing code
- `/clean-code`
- `/test-behavior-not-implementation`

## Required Reading

- `CLAUDE.md`
- `src/engine/providers/anthropic/stream.ts` — `splitSystemMessages()` (lines 53-71) and `streamAnthropicCompletion()` (lines 220-254)
- `src/engine/planners/base.ts` — how system prompt + repo-map are assembled
- `src/engine/spec/prompts/system.ts` — system prompt template
- https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching — current API format

## Write Ownership

```
src/engine/providers/anthropic/stream.ts              (modify)
src/engine/providers/anthropic/stream.test.ts         (modify if exists, else create)
```

## Required Behavior

### Part A: Change system prompt format from string to block array

Current code in `splitSystemMessages()` joins all system messages into one string:

```typescript
system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
```

Change this to return an array of Anthropic content blocks. The LAST block gets the `cache_control` marker (Anthropic caches everything up to and including the marked block).

New return type for system:

```typescript
type AnthropicSystemBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

function splitSystemMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): { system: AnthropicSystemBlock[] | undefined; conversation: AnthropicMessage[] } {
  const systemBlocks: AnthropicSystemBlock[] = [];
  const conversation: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemBlocks.push({ type: 'text', text: message.content });
      continue;
    }
    conversation.push({ role: message.role, content: message.content });
  }

  if (systemBlocks.length === 0) return { system: undefined, conversation };

  // Mark the LAST system block for caching — Anthropic caches up to this point
  systemBlocks[systemBlocks.length - 1]!.cache_control = { type: 'ephemeral' };

  return { system: systemBlocks, conversation };
}
```

### Part B: Update the request body

In `streamAnthropicCompletion()`, the body already spreads `system`:

```typescript
...(system && { system }),
```

This already works — the Anthropic API accepts both `string` and `Array<{ type: 'text'; text: string; cache_control?: ... }>` for the `system` field. No change needed to the body construction itself.

### Part C: Verify usage tracking still works

The existing `parseUsage()` at lines 73-104 already reads `cache_read_input_tokens` and `cache_creation_input_tokens` from responses. No change needed — verify it still works by checking test output.

### Part D: Update the AnthropicSystemBlock type

Add the type at the top of `stream.ts`, after the existing `AnthropicMessage` interface (around line 33):

```typescript
interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}
```

## Tests

Write a colocated test (or extend existing) for `splitSystemMessages`:

```typescript
import { describe, it, expect } from 'vitest';

// splitSystemMessages is not exported — test through streamAnthropicCompletion
// OR extract and export it if the file doesn't already export it.
// If it's internal, test behavior through integration.

describe('Anthropic prompt caching', () => {
  it('system blocks have cache_control on last block', () => {
    // If splitSystemMessages is exported for testing:
    const result = splitSystemMessages([
      { role: 'system', content: 'system preamble' },
      { role: 'system', content: 'repo map content' },
      { role: 'user', content: 'research the codebase' },
    ]);

    expect(result.system).toHaveLength(2);
    expect(result.system![0].cache_control).toBeUndefined();
    expect(result.system![1].cache_control).toEqual({ type: 'ephemeral' });
    expect(result.conversation).toHaveLength(1);
  });

  it('returns undefined system when no system messages', () => {
    const result = splitSystemMessages([
      { role: 'user', content: 'hello' },
    ]);
    expect(result.system).toBeUndefined();
  });

  it('single system message gets cache_control', () => {
    const result = splitSystemMessages([
      { role: 'system', content: 'only system' },
      { role: 'user', content: 'query' },
    ]);
    expect(result.system).toHaveLength(1);
    expect(result.system![0].cache_control).toEqual({ type: 'ephemeral' });
  });
});
```

If `splitSystemMessages` is not exported, temporarily export it for testing, or test through a higher-level integration that validates the request body shape.

## Verification

- [ ] `splitSystemMessages` returns array of blocks, not a string
- [ ] Last system block has `cache_control: { type: 'ephemeral' }`
- [ ] Request body format accepted by Anthropic API (test with a real call if possible)
- [ ] Cache usage fields (`cacheReadTokens`, `cacheCreateTokens`) still populate in token tracking
- [ ] `npm run test-ci` passes
