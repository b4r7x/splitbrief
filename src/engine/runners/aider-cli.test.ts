import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aiderImplementerAdapter,
  aiderPlannerAdapter,
  aiderPromptArgs,
} from './cli-tools/aider.js';

describe('aider implementer — keeps the staged working tree dirty for change detection', () => {
  it('disables aider self-commits so edits are observable as uncommitted changes', () => {
    const args = aiderImplementerAdapter.buildArgs({
      prompt: '<PROMPT>',
      model: undefined,
      projectDir: '/project',
      configuredArgs: [],
    });
    expect(args).toContain('--no-auto-commits');
    expect(args).toContain('--no-dirty-commits');
    expect(aiderImplementerAdapter.validateArgs(args)).toEqual({ valid: true });
  });
});

describe('aider planner — only seeds --read src/ for projects that have a src/ dir', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'aider-read-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('adds --read src/ in plan mode when src/ exists', () => {
    mkdirSync(join(projectDir, 'src'));
    const args = aiderPlannerAdapter.buildArgs({
      prompt: '<PROMPT>',
      model: undefined,
      projectDir,
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    expect(args).toContain('--read');
    expect(args[args.indexOf('--read') + 1]).toBe('src/');
  });

  it('omits --read src/ in plan mode when src/ is absent', () => {
    const args = aiderPlannerAdapter.buildArgs({
      prompt: '<PROMPT>',
      model: undefined,
      projectDir,
      configuredArgs: [],
      mode: 'plan',
      sessionId: null,
      effort: undefined,
    });
    expect(args).not.toContain('--read');
    expect(args).not.toContain('src/');
  });

  it('never seeds --read src/ in escalate mode even when src/ exists', () => {
    mkdirSync(join(projectDir, 'src'));
    const args = aiderPlannerAdapter.buildArgs({
      prompt: '<PROMPT>',
      model: undefined,
      projectDir,
      configuredArgs: [],
      mode: 'escalate',
      sessionId: null,
      effort: undefined,
    });
    expect(args).not.toContain('--read');
  });

  it('keeps the prompt sentinel as one standalone argv element', () => {
    expect(
      aiderPromptArgs({ role: 'planner', projectDir: '', mode: 'plan', configuredArgs: [] }),
    ).toContain('<PROMPT>');
    expect(aiderPromptArgs({ role: 'implementer', projectDir: '', configuredArgs: [] })).toContain(
      '<PROMPT>',
    );
  });
});
