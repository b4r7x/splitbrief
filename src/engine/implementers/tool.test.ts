import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { Config } from '../../types.js';
import { createToolImplementer, TOOL_NAMES } from './tool.js';
import { makeConfig as makeBaseConfig, makeTask, defaultContext } from '#testing/helpers/fixtures.js';

function makeConfig(extra?: Partial<Config['implementer']>): Config {
  return makeBaseConfig({
    implementer: { model: 'test-model', contextLength: 8192, temperature: 0.3, type: 'claude-code', ...extra },
  });
}

const context = { ...defaultContext, runtime: 'node' };

let testDir: string;

function setupGitRepo(): string {
  const dir = join(tmpdir(), `tiny-spec-tool-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'init.txt'), 'init');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('tool implementer', () => {
  beforeEach(() => {
    testDir = setupGitRepo();
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates a valid backend for each supported tool', () => {
    for (const tool of TOOL_NAMES) {
      const config = makeConfig({ type: tool });
      const impl = createToolImplementer(tool, config);
      expect(impl.name).toBe(`tool:${tool}`);
    }
  });

  it('throws on unknown tool name', () => {
    const config = makeConfig();
    expect(() => createToolImplementer('unknown-tool', config)).toThrow('Unknown tool implementer: unknown-tool');
  });

  it('isAvailable returns false for non-existent CLI', async () => {
    const config = makeConfig();
    const impl = createToolImplementer('claude-code', config);

    const originalPath = process.env['PATH'];
    process.env['PATH'] = '';
    try {
      const available = await impl.isAvailable();
      expect(available).toBe(false);
    } finally {
      process.env['PATH'] = originalPath;
    }
  });

  it('succeeds when tool writes a file', async () => {
    const outFile = join(testDir, 'output.txt');
    const config = makeBaseConfig({
      implementer: {
        model: 'test',
        contextLength: 8192,
        temperature: 0.3,
        type: 'agent',
        command: 'bash',
        args: ['-c', `echo "hello" > ${outFile}`],
      },
    });

    const { createAgentImplementer } = await import('./agent.js');
    const implementer = createAgentImplementer(config);
    const result = await implementer.implement({
      task: makeTask(),
      projectDir: testDir,
      config,
      context: { ...context, dir: testDir },
      onProgress: () => {},
    });

    expect(result.success).toBe(true);
  });

  it('TOOL_NAMES contains expected tools', () => {
    expect(TOOL_NAMES).toContain('claude-code');
    expect(TOOL_NAMES).toContain('codex');
    expect(TOOL_NAMES).toContain('opencode');
    expect(TOOL_NAMES).toContain('aider');
    expect(TOOL_NAMES).toHaveLength(4);
  });

  it('getPricing returns non-null pricing', () => {
    const config = makeConfig();
    const impl = createToolImplementer('claude-code', config);
    const pricing = impl.getPricing();
    expect(pricing).toBeDefined();
    expect(pricing.name).toBeTruthy();
  });
});
