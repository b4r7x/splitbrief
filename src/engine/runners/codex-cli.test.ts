import { describe, expect, it } from 'vitest';
import {
  CLI_CONFORMANCE_CANDIDATES,
  codexImplementerAdapter,
  codexPlannerAdapter,
} from './cli-tools/codex.js';

const PROMPT = '<PROMPT>';

describe('Codex planner adapter — session resume', () => {
  it('uses exec resume with global read-only flags, model, ignore flags, json, session, and prompt in order', () => {
    const args = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: 'session-1',
      effort: 'high',
    });
    expect(args).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      'resume',
      '--model',
      'gpt-5',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      'session-1',
      PROMPT,
    ]);
    expect(args).not.toContain('--reasoning-effort');
  });

  it('uses global read-only exec with never approval and --cd when no session is provided', () => {
    const args = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    expect(args).toEqual([
      '--model',
      'gpt-5',
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--json',
      '--cd',
      '/project',
      PROMPT,
    ]);
  });

  it('uses global workspace-write escalation and skips the git repository check', () => {
    const args = codexPlannerAdapter.buildArgs({
      prompt: PROMPT,
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'escalate',
      sessionId: 'session-1',
      effort: undefined,
    });
    expect(args).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/project',
      PROMPT,
    ]);
  });
});

describe('Codex implementer adapter — staged direct writes', () => {
  it('keeps workspace-write, skip-git-repo-check, cd, and model placement', () => {
    const args = codexImplementerAdapter.buildArgs({
      prompt: PROMPT,
      model: 'gpt-5.2',
      projectDir: '/staged',
      configuredArgs: [],
    });
    expect(args).toEqual([
      '--model',
      'gpt-5.2',
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'never',
      'exec',
      '--ignore-user-config',
      '--json',
      '--skip-git-repo-check',
      '--cd',
      '/staged',
      PROMPT,
    ]);
    expect(args).not.toContain('--full-auto');
  });

  it('rejects custom arguments that weaken the terminal or sandbox contract', () => {
    const args = codexImplementerAdapter.buildArgs({
      prompt: PROMPT,
      model: undefined,
      projectDir: '/staged',
      configuredArgs: [],
    });
    expect(
      codexImplementerAdapter.validateArgs({ invocationArgs: [...args, '--json'], baseArgs: args }),
    ).toEqual({
      valid: false,
      conflicts: ['--json'],
    });
    expect(
      codexImplementerAdapter.validateArgs({
        invocationArgs: [...args, '--sandbox', 'danger'],
        baseArgs: args,
      }),
    ).toEqual({
      valid: false,
      conflicts: ['--sandbox'],
    });
  });
});

describe('Codex lossless prompt transport', () => {
  it('keeps an oversized planner prompt byte-for-byte for pre-launch rejection', () => {
    const longHead = 'HEAD_SENTINEL ';
    const longTail = ' TAIL_SENTINEL';
    const oversizedPrompt = longHead + 'x'.repeat(200_000) + longTail;
    const args = codexPlannerAdapter.buildArgs({
      prompt: oversizedPrompt,
      model: 'gpt-5',
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: 'session-1',
      effort: undefined,
    });
    expect(args.at(-1)).toBe(oversizedPrompt);
  });

  it('does not alter multibyte prompt code points', () => {
    const prompt = '😀'.repeat(80_000);
    const args = codexPlannerAdapter.buildArgs({
      prompt,
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    expect(args.at(-1)).toBe(prompt);
  });
});

describe('Codex conformance candidates', () => {
  it('keeps exactly planner then implementer entries with matching adapters', () => {
    expect(CLI_CONFORMANCE_CANDIDATES).toHaveLength(2);
    expect(CLI_CONFORMANCE_CANDIDATES.map((candidate) => candidate.role)).toEqual([
      'planner',
      'implementer',
    ]);
    expect(CLI_CONFORMANCE_CANDIDATES[0]?.adapter).toBe(codexPlannerAdapter);
    expect(CLI_CONFORMANCE_CANDIDATES[1]?.adapter).toBe(codexImplementerAdapter);
    expect(
      CLI_CONFORMANCE_CANDIDATES.every((candidate) =>
        /^[a-f0-9]{64}$/.test(candidate.contractSha256),
      ),
    ).toBe(true);
  });
});
