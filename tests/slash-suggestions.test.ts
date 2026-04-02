import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('SlashSuggestions', () => {
  it('exports a named SlashSuggestions component', async () => {
    const mod = await import('../src/ui/slash-suggestions.js');
    assert.equal(typeof mod.SlashSuggestions, 'function');
  });

  it('does not export filterCommands (internal helper)', async () => {
    const mod = await import('../src/ui/slash-suggestions.js');
    assert.equal((mod as Record<string, unknown>).filterCommands, undefined);
  });
});
