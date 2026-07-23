import { describe, it, expect } from 'vitest';
import { CLI_TOOLS } from './cli-tools.js';

function getPlanner(tool: keyof typeof CLI_TOOLS) {
  const planner = CLI_TOOLS[tool].planner;
  if (!planner) throw new Error(`Expected planner entry for ${tool}`);
  return planner;
}

function getImplementer(tool: keyof typeof CLI_TOOLS) {
  const impl = CLI_TOOLS[tool].implementer;
  if (!impl) throw new Error(`Expected implementer entry for ${tool}`);
  return impl;
}

function promptArg(args: string[]): string {
  const longest = args.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest;
}

describe('codex planner — session resume (CLI contract)', () => {
  const codex = getPlanner('codex');

  it('declares supportsSessionResume: true', () => {
    expect(codex.supportsSessionResume).toBe(true);
  });

  it('drops planner effort because the current Codex CLI has no stable reasoning flag', () => {
    expect(codex.supportsEffort).toBe(false);
    const args = codex.buildArgs({
      prompt: 'new feature',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
      effort: 'high',
    });
    expect(args).not.toContain('--reasoning-effort');
  });

  it('also drops planner effort on resumed Codex sessions', () => {
    const args = codex.buildArgs({
      prompt: 'continue',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
      sessionId: 'abc-123',
      effort: 'high',
    });
    expect(args).toEqual(['exec', 'resume', '--model', 'gpt-5', '--json', 'abc-123', 'continue']);
    expect(args).not.toContain('--reasoning-effort');
  });

  it('uses `exec resume --model <m> --json <id> <prompt>` in plan mode with sessionId', () => {
    const args = codex.buildArgs({
      prompt: 'continue',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
      sessionId: 'abc-123',
    });
    expect(args).toEqual(['exec', 'resume', '--model', 'gpt-5', '--json', 'abc-123', 'continue']);
  });

  it('uses read-only `exec --json` in plan mode when no sessionId is provided', () => {
    const args = codex.buildArgs({
      prompt: 'new feature',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
    });
    expect(args).toEqual([
      '--model',
      'gpt-5',
      'exec',
      '--json',
      '--cd',
      '/tmp/proj',
      'new feature',
    ]);
    expect(args).not.toContain('--full-auto');
  });

  it('uses write-permissive `--sandbox workspace-write` with `--skip-git-repo-check` in escalate mode', () => {
    const args = codex.buildArgs({
      prompt: 'escalate',
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'escalate',
      sessionId: 'abc-123',
    });
    expect(args).toEqual([
      '--model',
      'gpt-5',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--cd',
      '/tmp/proj',
      'escalate',
    ]);
    expect(args).not.toContain('--full-auto');
  });
});

describe('codex implementer — runs in the git-less staged copy', () => {
  const codex = getImplementer('codex');

  it('passes --skip-git-repo-check so codex does not exit before the model call', () => {
    const skipFlag = (args: string[]) => args.includes('--skip-git-repo-check');
    expect(skipFlag(codex.buildArgs({ prompt: 'do it', model: undefined }))).toBe(true);
    expect(skipFlag(codex.buildArgs({ prompt: 'do it', model: 'gpt-5.2' }))).toBe(true);
  });

  it('uses --sandbox workspace-write instead of the deprecated --full-auto', () => {
    const args = codex.buildArgs({ prompt: 'do it', model: undefined });
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args).not.toContain('--full-auto');
  });
});

describe('codex planner — prompt argv clamping (Linux MAX_ARG_STRLEN guard)', () => {
  const MAX_ARGV_PROMPT_BYTES = 120_000;
  const TRUNCATION_MARKER = '[diptych: prompt truncated to fit the OS argv limit';
  const longHead = 'HEAD_SENTINEL ';
  const longTail = ' TAIL_SENTINEL';
  const oversizedPrompt = longHead + 'x'.repeat(200_000) + longTail;
  const codex = getPlanner('codex');

  it('truncates the codex resumed-session prompt as well', () => {
    const args = codex.buildArgs({
      prompt: oversizedPrompt,
      model: 'gpt-5',
      projectDir: '/tmp/proj',
      mode: 'plan',
      sessionId: 'abc-123',
    });
    const arg = promptArg(args);
    expect(Buffer.byteLength(arg, 'utf8')).toBeLessThanOrEqual(MAX_ARGV_PROMPT_BYTES);
    expect(arg).toContain(TRUNCATION_MARKER);
    expect(arg).not.toContain(longTail);
  });

  it('does not split a multibyte character at the truncation boundary', () => {
    const args = codex.buildArgs({
      prompt: '😀'.repeat(80_000),
      model: undefined,
      projectDir: '/tmp',
      mode: 'plan',
    });
    const arg = promptArg(args);
    expect(arg).not.toContain('\uFFFD');
    expect(Buffer.byteLength(arg, 'utf8')).toBeLessThanOrEqual(MAX_ARGV_PROMPT_BYTES);
  });
});
