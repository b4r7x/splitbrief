import { describe, it, expect } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { runnerShortLabel } from './runner-label.js';

const ESC = String.fromCharCode(27);

describe('runnerShortLabel', () => {
  it('formats an api implementer model id into a brand label', () => {
    const config = makeConfig();
    expect(runnerShortLabel(config.implementer)).toBe('Qwen 2.5 Coder 7B');
  });

  it('falls back to the tool name when a cli planner declares no model', () => {
    const config = makeConfig();
    expect(runnerShortLabel(config.planner)).toBe('claude-code');
  });

  it('strips terminal control bytes from a raw config model id', () => {
    const config = makeConfig({ implementer: { model: `qwen${ESC}[2J-coder` } });
    const label = runnerShortLabel(config.implementer);
    expect(label).not.toContain(ESC);
  });
});
