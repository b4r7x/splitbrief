import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
  CLI_PROMPT_PLACEHOLDER,
  CLI_TOOLS,
  createCliImplementerAdapter,
  createCliPlannerAdapter,
  invokeCliAdapter,
} from './cli-tools.js';
import { parseTextLine } from '../streaming/parse-text.js';
import type { RunnerCallContext } from '../calls/types.js';

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
    implementerBare: ['run', '--format', 'json', 'prompt'],
    implementerWithModel: ['run', '--model', 'claude-sonnet-4-6', '--format', 'json', 'prompt'],
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

function argsContainPhrase(args: string[], phrase: string): boolean {
  const parts = phrase.split(' ');
  return args.some((_, index) => parts.every((part, offset) => args[index + offset] === part));
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

describe('CLI_TOOLS trust metadata', () => {
  it('marks built-in CLI implementers as local command, network, and direct-write capable', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const trust = CLI_TOOLS[tool].trust.implementer;
      expect(trust.executesLocalCommand).toBe(true);
      expect(trust.mayUseNetwork).toBe(true);
      expect(trust.mayWriteFilesDirectly).toBe(true);
    }
  });

  it('records the claude-code accept-edits direct-write path', () => {
    expect(CLI_TOOLS['claude-code'].trust.implementer.autoAllowFlags).toEqual([
      '--permission-mode acceptEdits',
    ]);
  });

  it('keeps auto/allow metadata aligned with built implementer args', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      if (tool === 'claude-code') continue;
      const entry = CLI_TOOLS[tool];
      if (!entry.implementer) continue;

      const args = entry.implementer.buildArgs({ prompt: 'prompt', model: undefined });
      for (const flag of entry.trust.implementer.autoAllowFlags) {
        expect(argsContainPhrase(args, flag)).toBe(true);
      }
    }
  });
});

describe('CLI_TOOLS prompt argv transport', () => {
  const longHead = 'HEAD_SENTINEL ';
  const longTail = ' TAIL_SENTINEL';
  const oversizedPrompt = longHead + 'x'.repeat(200_000) + longTail;

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
      expect(args.join('\n')).toContain('compile this brief');
    }
  });

  it('passes short prompts through verbatim for every implementer', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const impl = CLI_TOOLS[tool].implementer;
      if (!impl) continue;
      const args = impl.buildArgs({ prompt: 'apply this brief', model: undefined });
      expect(args).toContain('apply this brief');
      expect(args.join('\n')).toContain('apply this brief');
    }
  });

  it('keeps an oversized planner prompt byte-for-byte for the adapter to reject before spawn', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const planner = CLI_TOOLS[tool].planner;
      if (!planner) continue;
      const args = planner.buildArgs({
        prompt: oversizedPrompt,
        model: undefined,
        projectDir: '/tmp',
        mode: 'plan',
      });
      expect(args).toContain(oversizedPrompt);
      expect(args.find((arg) => arg.includes(longHead))).toBe(oversizedPrompt);
      expect(args.find((arg) => arg.includes(longTail))).toBe(oversizedPrompt);
    }
  });

  it('keeps an oversized implementer prompt byte-for-byte for the adapter to reject before spawn', () => {
    for (const tool of Object.keys(CLI_TOOLS) as (keyof typeof CLI_TOOLS)[]) {
      const impl = CLI_TOOLS[tool].implementer;
      if (!impl) continue;
      const args = impl.buildArgs({ prompt: oversizedPrompt, model: undefined });
      expect(args).toContain(oversizedPrompt);
      expect(args.find((arg) => arg.includes(longHead))).toBe(oversizedPrompt);
      expect(args.find((arg) => arg.includes(longTail))).toBe(oversizedPrompt);
    }
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

describe('CLI adapter argument contract', () => {
  it('keeps configured argument order and rejects protected flags/placeholders', () => {
    const planner = getPlanner('codex');
    const adapter = createCliPlannerAdapter({
      toolName: 'codex',
      planner,
      parseLine: planner.parseLine,
    });
    const base = adapter.buildArgs({
      prompt: CLI_PROMPT_PLACEHOLDER,
      model: undefined,
      projectDir: '/tmp/project',
      mode: 'plan',
      sessionId: null,
      effort: undefined,
      configuredArgs: ['--label', 'two words', 'Zażółć 🙂'],
    });

    expect(adapter.validateArgs(base)).toEqual({ valid: true });
    expect(adapter.validateArgs([...base, '--model', 'unsafe'])).toEqual({
      valid: false,
      conflicts: ['--model'],
    });
    expect(adapter.validateArgs([...base, 'prefix-<PROMPT>'])).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(adapter.validateArgs([...base, CLI_PROMPT_PLACEHOLDER])).toEqual({
      valid: false,
      conflicts: ['prompt-transport'],
    });
    expect(adapter.validateArgs([CLI_PROMPT_PLACEHOLDER, ...base])).toEqual({
      valid: false,
      conflicts: ['argument-order', 'prompt-transport'],
    });
  });

  it('uses the same lossless argv contract for implementers', () => {
    const implementer = getImplementer('opencode');
    const adapter = createCliImplementerAdapter({
      toolName: 'opencode',
      implementer,
      parseLine: implementer.parseLine ?? parseTextLine,
    });
    const args = adapter.buildArgs({
      prompt: CLI_PROMPT_PLACEHOLDER,
      model: 'claude-sonnet-4-6',
      projectDir: '/tmp/project',
      configuredArgs: ['--label', 'Describe --model as data'],
    });

    expect(adapter.promptTransport).toEqual({ kind: 'argv', maxBytes: 120_000 });
    expect(args).toEqual([
      'run',
      '--model',
      'claude-sonnet-4-6',
      '--format',
      'json',
      CLI_PROMPT_PLACEHOLDER,
      '--label',
      'Describe --model as data',
    ]);
    expect(adapter.validateArgs(args)).toEqual({ valid: true });
  });

  it('rejects an oversized multibyte prompt before executable identity or spawn', async () => {
    const implementer = getImplementer('opencode');
    const adapter = createCliImplementerAdapter({
      toolName: 'opencode',
      implementer,
      parseLine: implementer.parseLine ?? parseTextLine,
    });
    const args = adapter.buildArgs({
      prompt: CLI_PROMPT_PLACEHOLDER,
      model: undefined,
      projectDir: '/tmp/project',
      configuredArgs: [],
    });
    const callContext = {
      callId: 'cli-tools-adapter-test',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'opencode',
    } satisfies RunnerCallContext;

    const result = await invokeCliAdapter({
      adapter,
      invocation: {
        executable: {
          path: `${tmpdir()}/missing-opencode`,
          fingerprint: { dev: 0, ino: 0, size: 0, mtimeMs: 0 },
        },
        args,
        promptTransport: adapter.promptTransport,
        environment: {},
        cwd: tmpdir(),
        timeoutMs: 5_000,
        signal: undefined,
      },
      prompt: `${'🙂漢字'.repeat(30_001)}FINAL-SENTINEL-Ω`,
      callContext,
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'prompt-transport-error' },
    });
    expect(result.error?.message).not.toContain('FINAL-SENTINEL-Ω');
  });
});
