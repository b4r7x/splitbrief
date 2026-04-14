import { describe, it, expect } from 'vitest';
import { CLI_TOOLS } from './cli-tools.js';

describe('codex planner buildArgs — session resume', () => {
  const codex = CLI_TOOLS.codex.planner;

  it('declares supportsSessionResume: true', () => {
    expect(codex?.supportsSessionResume).toBe(true);
  });

  it('uses `exec resume --json <id> <prompt>` when sessionId is present on plan mode', () => {
    const args = codex?.buildArgs({
      prompt: 'continue',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
      sessionId: 'abc-123',
    });
    expect(args).toEqual(['exec', 'resume', '--model', 'gpt-5', '--json', 'abc-123', 'continue']);
  });

  it('omits resume for escalate mode even when sessionId is set', () => {
    const args = codex?.buildArgs({
      prompt: 'escalate',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'escalate',
      sessionId: 'abc-123',
    });
    // Escalate ignores sessionId: one-shot exec in original form
    expect(args?.slice(0, 2)).toEqual(['--model', 'gpt-5']);
    expect(args).toContain('exec');
    expect(args).not.toContain('resume');
  });

  it('uses vanilla `exec --json --full-auto` when no sessionId is provided', () => {
    const args = codex?.buildArgs({
      prompt: 'new feature',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
    });
    expect(args).toContain('--full-auto');
    expect(args).not.toContain('resume');
  });
});
