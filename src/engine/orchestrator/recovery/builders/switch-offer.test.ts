import { describe, expect, it } from 'vitest';
import { switchSeatOffer } from './switch-offer.js';

describe('switchSeatOffer', () => {
  it('offers only tools the seat can host', () => {
    expect(
      switchSeatOffer({
        seat: 'build',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'a-tool-no-seat-hosts', ready: true },
          { tool: 'claude-code', ready: true },
        ],
      }),
    ).toEqual({ seat: 'build', candidates: [{ tool: 'claude-code' }] });
  });

  it('offers nothing when no ready tool can host the seat', () => {
    expect(
      switchSeatOffer({
        seat: 'plan',
        currentTool: 'codex',
        detectedTools: [{ tool: 'a-tool-no-seat-hosts', ready: true }],
      }),
    ).toBeUndefined();
  });

  it('offers a fallback on the same tool and another model, not the tool alone', () => {
    expect(
      switchSeatOffer({
        seat: 'build',
        currentTool: 'codex',
        currentModel: 'gpt-5',
        detectedTools: [
          { tool: 'codex', ready: true },
          { tool: 'codex', model: 'gpt-5', ready: true },
          { tool: 'codex', model: 'gpt-5-mini', effort: 'high', ready: true },
        ],
      }),
    ).toEqual({
      seat: 'build',
      candidates: [{ tool: 'codex', model: 'gpt-5-mini', effort: 'high' }],
    });
  });

  it('leaves out a tool whose prompt limit the prompt exceeds', () => {
    expect(
      switchSeatOffer(
        {
          seat: 'review',
          currentTool: 'claude-code',
          detectedTools: [
            { tool: 'codex', ready: true },
            { tool: 'opencode', ready: true },
          ],
        },
        { characters: 1_048_577 },
      ),
    ).toEqual({ seat: 'review', candidates: [{ tool: 'opencode' }] });
  });

  it('offers nothing when every ready tool limits the prompt below its size', () => {
    expect(
      switchSeatOffer(
        {
          seat: 'review',
          currentTool: 'claude-code',
          detectedTools: [{ tool: 'codex', ready: true }],
        },
        { characters: 2_000_000 },
      ),
    ).toBeUndefined();
  });

  it('lists tools without a prompt limit before a tool whose limit the prompt fits', () => {
    expect(
      switchSeatOffer(
        {
          seat: 'review',
          currentTool: 'claude-code',
          detectedTools: [
            { tool: 'codex', ready: true },
            { tool: 'opencode', ready: true },
            { tool: 'cursor', ready: true },
          ],
        },
        { characters: 600_000 },
      ),
    ).toEqual({
      seat: 'review',
      candidates: [{ tool: 'opencode' }, { tool: 'cursor' }, { tool: 'codex' }],
    });
  });

  it("passes a candidate's variant through", () => {
    expect(
      switchSeatOffer({
        seat: 'plan',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'claude-code', model: 'opus', effort: 'xhigh', variant: 'xhigh', ready: true },
        ],
      }),
    ).toEqual({
      seat: 'plan',
      candidates: [{ tool: 'claude-code', model: 'opus', effort: 'xhigh', variant: 'xhigh' }],
    });
  });
});
