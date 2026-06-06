import { describe, it, expect } from 'vitest';
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
    plannerBare: ['-p', 'prompt', '--output-format', 'json', '--allow-all'],
    plannerWithModel: [
      '--model',
      'gpt-5.2',
      '-p',
      'prompt',
      '--output-format',
      'json',
      '--allow-all',
    ],
    modelBeforePrompt: true,
  },
  {
    tool: 'kilo-code',
    plannerBare: ['run', '--auto', '--json', '-m', 'architect', 'prompt'],
    plannerWithModel: [
      'run',
      '--auto',
      '--json',
      '-m',
      'architect',
      'prompt',
      '--model',
      'claude-sonnet-4-6',
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
    implementerBare: ['exec', '--json', '--full-auto', 'prompt'],
    implementerWithModel: ['--model', 'gpt-5.2', 'exec', '--json', '--full-auto', 'prompt'],
  },
  {
    tool: 'copilot',
    implementerBare: ['-p', 'prompt', '--allow-all'],
    implementerWithModel: ['--model', 'claude-sonnet-4-6', '-p', 'prompt', '--allow-all'],
  },
  {
    tool: 'kilo-code',
    implementerBare: ['run', '--auto', '--yolo', 'prompt'],
    implementerWithModel: ['run', '--auto', '--yolo', 'prompt', '--model', 'qwen2.5-coder:7b'],
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

  it('uses vanilla `exec --json --full-auto` when no sessionId is provided', () => {
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
      '--full-auto',
      '--cd',
      '/tmp/proj',
      'new feature',
    ]);
  });

  it('ignores sessionId in escalate mode (one-shot exec form)', () => {
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
      '--full-auto',
      '--cd',
      '/tmp/proj',
      'escalate',
    ]);
    expect(args).not.toContain('resume');
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
