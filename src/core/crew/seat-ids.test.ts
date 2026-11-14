import { describe, expect, it } from 'vitest';
import { isSeatIdentity } from './seat-ids.js';

describe('isSeatIdentity', () => {
  const seat = { tool: 'codex', model: 'gpt-5' };

  it('is the seat on the same tool and model, whatever the effort', () => {
    expect(isSeatIdentity(seat, { tool: 'codex', model: 'gpt-5' })).toBe(true);
  });

  it("is the seat on the same tool with no model: that is the tool's own default", () => {
    expect(isSeatIdentity(seat, { tool: 'codex' })).toBe(true);
    expect(isSeatIdentity(seat, { tool: 'codex', model: 'auto' })).toBe(true);
  });

  it('reads auto and an absent model as one model on both sides', () => {
    expect(isSeatIdentity({ tool: 'claude-code', model: 'auto' }, { tool: 'claude-code' })).toBe(
      true,
    );
    expect(isSeatIdentity({ tool: 'claude-code' }, { tool: 'claude-code', model: 'default' })).toBe(
      true,
    );
  });

  it('is a move on another model of the same tool or on another tool', () => {
    expect(isSeatIdentity(seat, { tool: 'codex', model: 'gpt-5-codex' })).toBe(false);
    expect(isSeatIdentity(seat, { tool: 'claude-code', model: 'gpt-5' })).toBe(false);
    expect(isSeatIdentity({ tool: 'claude-code' }, { tool: 'claude-code', model: 'opus' })).toBe(
      false,
    );
  });
});
