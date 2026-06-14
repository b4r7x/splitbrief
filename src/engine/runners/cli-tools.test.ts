import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI_TOOLS } from './cli-tools.js';

type PlannerScenario = {
  tool: keyof typeof CLI_TOOLS;
  plannerBare: string[];
  plannerWithModel: string[];
  modelBeforePrompt?: boolean;
};

const PLANNER_SCENARIOS: PlannerScenario[] = [
  {
    tool: 'copilot',
    plannerBare: ['-p', 'prompt', '--output-format', 'json'],
    plannerWithModel: ['--model', 'gpt-5.2', '-p', 'prompt', '--output-format', 'json'],
    modelBeforePrompt: true,
  },
  {
    tool: 'kilo-code',
    plannerBare: ['run', '--format', 'json', '--agent', 'architect', 'prompt'],
    plannerWithModel: [
      'run',
      '--model',
      'claude-sonnet-4-6',
      '--format',
      'json',
      '--agent',
      'architect',
      'prompt',
    ],
  },
];

type ImplementerScenario = {
  tool: keyof typeof CLI_TOOLS;
  implementerBare: string[];
  implementerWithModel: string[];
};

const IMPLEMENTER_SCENARIOS: ImplementerScenario[] = [
  {
    tool: 'codex',
    implementerBare: [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'prompt',
    ],
    implementerWithModel: [
      '--model',
      'gpt-5.2',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      'prompt',
    ],
  },
  {
    tool: 'copilot',
    implementerBare: ['-p', 'prompt', '--allow-all'],
    implementerWithModel: ['--model', 'claude-sonnet-4-6', '-p', 'prompt', '--allow-all'],
  },
  {
    tool: 'kilo-code',
    implementerBare: ['run', '--auto', 'prompt'],
    implementerWithModel: ['run', '--model', 'qwen2.5-coder:7b', '--auto', 'prompt'],
  },
  {
    tool: 'opencode',
    implementerBare: ['run', 'prompt'],
    implementerWithModel: ['run', '--model', 'claude-sonnet-4-6', 'prompt'],
  },
  {
    tool: 'aider',
    implementerBare: [
      '--message',
      'prompt',
      '--yes-always',
      '--no-auto-commits',
      '--no-dirty-commits',
    ],
    implementerWithModel: [
      '--message',
      'prompt',
      '--yes-always',
      '--no-auto-commits',
      '--no-dirty-commits',
      '--model',
      'claude-sonnet-4-6',
    ],
  },
];

function extractModel(args: string[]): string {
  const idx = args.indexOf('--model');
  if (idx < 0) throw new Error(`Expected --model flag in args: ${args.join(' ')}`);
  const model = args[idx + 1];
  if (!model) throw new Error(`Expected value after --model in args: ${args.join(' ')}`);
  return model;
}

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

describe('CLI_TOOLS planner buildArgs', () => {
  it.each(PLANNER_SCENARIOS)('$tool: produces bare args without --model', ({
    tool,
    plannerBare,
  }) => {
    const args = getPlanner(tool).buildArgs({
      prompt: 'prompt',
      model: undefined,
      projectDir: '/tmp',
      mode: 'plan',
    });
    expect(args).toEqual(plannerBare);
    expect(args).not.toContain('--model');
  });

  it.each(PLANNER_SCENARIOS)('$tool: inserts --model <model> when provided', ({
    tool,
    plannerWithModel,
    modelBeforePrompt,
  }) => {
    const model = extractModel(plannerWithModel);
    const args = getPlanner(tool).buildArgs({
      prompt: 'prompt',
      model,
      projectDir: '/tmp',
      mode: 'plan',
    });
    expect(args).toEqual(plannerWithModel);
    if (modelBeforePrompt) {
      expect(args.indexOf('--model')).toBeLessThan(args.indexOf('-p'));
    }
  });
});

describe('CLI_TOOLS implementer buildArgs', () => {
  it.each(IMPLEMENTER_SCENARIOS)('$tool: produces bare args without --model', ({
    tool,
    implementerBare,
  }) => {
    const args = getImplementer(tool).buildArgs({ prompt: 'prompt', model: undefined });
    expect(args).toEqual(implementerBare);
    expect(args).not.toContain('--model');
  });

  it.each(IMPLEMENTER_SCENARIOS)('$tool: appends --model <model> when provided', ({
    tool,
    implementerWithModel,
  }) => {
    const model = extractModel(implementerWithModel);
    const args = getImplementer(tool).buildArgs({ prompt: 'prompt', model });
    expect(args).toEqual(implementerWithModel);
  });
});

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

describe('aider implementer — keeps the staged working tree dirty for change detection', () => {
  const aider = getImplementer('aider');

  it('disables aider self-commits so edits are observable as uncommitted changes', () => {
    const args = aider.buildArgs({ prompt: 'do it', model: undefined });
    expect(args).toContain('--no-auto-commits');
    expect(args).toContain('--no-dirty-commits');
  });
});

describe('aider planner — only seeds --read src/ for projects that have a src/ dir', () => {
  const aider = getPlanner('aider');
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aider-read-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('adds --read src/ in plan mode when src/ exists', () => {
    mkdirSync(join(projectDir, 'src'));
    const args = aider.buildArgs({ prompt: 'plan it', model: undefined, projectDir, mode: 'plan' });
    expect(args).toContain('--read');
    expect(args[args.indexOf('--read') + 1]).toBe('src/');
  });

  it('omits --read src/ in plan mode when src/ is absent', () => {
    const args = aider.buildArgs({ prompt: 'plan it', model: undefined, projectDir, mode: 'plan' });
    expect(args).not.toContain('--read');
    expect(args).not.toContain('src/');
  });

  it('never seeds --read src/ in escalate mode even when src/ exists', () => {
    mkdirSync(join(projectDir, 'src'));
    const args = aider.buildArgs({
      prompt: 'escalate it',
      model: undefined,
      projectDir,
      mode: 'escalate',
    });
    expect(args).not.toContain('--read');
  });
});

describe('copilot planner — parses the {type, data} JSON envelope', () => {
  const copilot = getPlanner('copilot');
  const parse = (event: unknown) => copilot.parseLine(JSON.stringify(event));

  it('extracts the session id from session.start', () => {
    const result = parse({
      type: 'session.start',
      data: { sessionId: 'sess-42' },
      id: 'evt-1',
      timestamp: '2026-06-11T00:00:00Z',
      parentId: null,
    });
    expect(result.sessionId).toBe('sess-42');
  });

  it('extracts assistant text from data.text', () => {
    const result = parse({
      type: 'assistant.message',
      data: { text: 'compiled brief' },
      id: 'evt-2',
    });
    expect(result.text).toBe('compiled brief');
  });

  it('extracts assistant text from a data.content block array', () => {
    const result = parse({
      type: 'assistant.message',
      data: {
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      },
    });
    expect(result.text).toBe('part one part two');
  });

  it('extracts token usage nested under assistant.message data', () => {
    const result = parse({
      type: 'assistant.message',
      data: {
        text: 'done',
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
      },
    });
    expect(result.text).toBe('done');
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
    });
  });

  it('extracts token usage from a standalone assistant.usage event', () => {
    const result = parse({
      type: 'assistant.usage',
      data: { usage: { inputTokens: 500, outputTokens: 120 } },
    });
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 120 });
  });

  it('does not misread the codex item.completed shape as copilot output', () => {
    const result = parse({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'codex-shaped' },
    });
    expect(result.text).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it('returns empty for unknown event types and blank lines', () => {
    expect(copilot.parseLine('')).toEqual({});
    expect(parse({ type: 'tool.execution_start', data: {} })).toEqual({});
  });
});

describe('CLI_TOOLS prompt argv clamping (Linux MAX_ARG_STRLEN guard)', () => {
  const MAX_ARGV_PROMPT_BYTES = 120_000;
  const TRUNCATION_MARKER = '[diptych: prompt truncated to fit the OS argv limit';

  const longHead = 'HEAD_SENTINEL ';
  const longTail = ' TAIL_SENTINEL';
  const oversizedPrompt = longHead + 'x'.repeat(200_000) + longTail;

  function promptArg(args: string[]): string {
    const longest = args.reduce((a, b) => (b.length > a.length ? b : a), '');
    return longest;
  }

  it('passes short prompts through verbatim for every planner', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const planner = CLI_TOOLS[tool].planner;
      if (!planner) continue;
      const args = planner.buildArgs({
        prompt: 'compile this brief',
        model: undefined,
        projectDir: '/tmp',
        mode: 'plan',
      });
      expect(args).toContain('compile this brief');
      expect(args.join('\n')).not.toContain(TRUNCATION_MARKER);
    }
  });

  it('passes short prompts through verbatim for every implementer', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const impl = CLI_TOOLS[tool].implementer;
      if (!impl) continue;
      const args = impl.buildArgs({ prompt: 'apply this brief', model: undefined });
      expect(args).toContain('apply this brief');
      expect(args.join('\n')).not.toContain(TRUNCATION_MARKER);
    }
  });

  it('truncates an oversized planner prompt below the argv cap with a warning marker', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const planner = CLI_TOOLS[tool].planner;
      if (!planner) continue;
      const args = planner.buildArgs({
        prompt: oversizedPrompt,
        model: undefined,
        projectDir: '/tmp',
        mode: 'plan',
      });
      const arg = promptArg(args);
      expect(Buffer.byteLength(arg, 'utf8')).toBeLessThanOrEqual(MAX_ARGV_PROMPT_BYTES);
      expect(arg).toContain(TRUNCATION_MARKER);
      expect(arg.startsWith(longHead)).toBe(true);
      expect(arg).not.toContain(longTail);
    }
  });

  it('truncates an oversized implementer prompt below the argv cap with a warning marker', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const impl = CLI_TOOLS[tool].implementer;
      if (!impl) continue;
      const args = impl.buildArgs({ prompt: oversizedPrompt, model: undefined });
      const arg = promptArg(args);
      expect(Buffer.byteLength(arg, 'utf8')).toBeLessThanOrEqual(MAX_ARGV_PROMPT_BYTES);
      expect(arg).toContain(TRUNCATION_MARKER);
      expect(arg.startsWith(longHead)).toBe(true);
      expect(arg).not.toContain(longTail);
    }
  });

  it('truncates the codex resumed-session prompt as well', () => {
    const codex = getPlanner('codex');
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
    const codex = getPlanner('codex');
    const args = codex.buildArgs({
      prompt: '😀'.repeat(80_000),
      model: undefined,
      projectDir: '/tmp',
      mode: 'plan',
    });
    const arg = promptArg(args);
    expect(arg).not.toContain('�');
    expect(Buffer.byteLength(arg, 'utf8')).toBeLessThanOrEqual(MAX_ARGV_PROMPT_BYTES);
  });
});

describe('CLI_TOOLS tested-version matrix', () => {
  it.each(
    Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[],
  )('%s declares a semver-shaped testedVersion the contract was verified against', (tool) => {
    expect(CLI_TOOLS[tool].testedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('CLI_TOOLS availability timeouts', () => {
  it('kilo-code planner has 5000ms availability timeout', () => {
    expect(getPlanner('kilo-code').isAvailableOpts?.timeout).toBe(5000);
  });

  it('opencode planner has 5000ms availability timeout', () => {
    expect(getPlanner('opencode').isAvailableOpts?.timeout).toBe(5000);
  });
});
