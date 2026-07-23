import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
