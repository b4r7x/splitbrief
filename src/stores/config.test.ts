import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { configStore } from './config.js';
import { feedbackStore } from './feedback.js';

let tmpDir: string;

function writeConfigYaml(extras: Record<string, unknown> = {}) {
  mkdirSync(join(tmpDir, '.tiny-spec'), { recursive: true });
  const base = {
    planner: { tool: 'claude-code' },
    implementer: { tool: 'ollama', model: 'qwen2.5-coder:7b', context_length: 8192, temperature: 0.3 },
    validation: { typecheck: true, lint: true, test: true, test_command: 'npm test' },
    workflow: { auto_approve_spec: false, auto_approve_plan: false, max_retries: 3, commit_strategy: 'none', mode: 'standard' },
    theme: 'terminal',
    sessions: { scope: 'project' },
    ...extras,
  };
  writeFileSync(join(tmpDir, '.tiny-spec', 'config.yaml'), YAML.stringify(base), 'utf-8');
}

describe('configStore.load', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-store-test-'));
    configStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    configStore.reset();
    feedbackStore.reset();
  });

  it('starts empty', () => {
    expect(configStore.get().config).toBeNull();
    expect(configStore.get().projectDir).toBe('');
  });

  it('loads config from disk', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    expect(configStore.get().projectDir).toBe(tmpDir);
    expect(configStore.get().config!.planner.tool).toBe('claude-code');
    expect(configStore.get().config!.implementer.model).toBe('qwen2.5-coder:7b');
  });

  it('falls back to defaults when no config file exists', () => {
    configStore.load(tmpDir);
    expect(configStore.get().config!.planner.tool).toBe('claude-code');
    expect(configStore.get().config!.implementer.tool).toBe('ollama');
  });

  it('applies implementer override to provider and model', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { tool: 'deepseek', model: 'deepseek-r1' } });
    expect(configStore.get().config!.implementer.tool).toBe('deepseek');
    expect(configStore.get().config!.implementer.model).toBe('deepseek-r1');
  });

  it('applies planner overrides', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { planner: { tool: 'aider', model: 'opus', command: 'my-planner' } });
    expect(configStore.get().config!.planner.tool).toBe('aider');
    expect(configStore.get().config!.planner.model).toBe('opus');
    expect(configStore.get().config!.planner.command).toBe('my-planner');
  });

  it('applies contextLength override', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { contextLength: 16384 });
    expect(configStore.get().config!.implementer.contextLength).toBe(16384);
  });

  it('applies mode override', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { mode: 'full' });
    expect(configStore.get().config!.workflow.mode).toBe('full');
  });

  it('autoApprove undefined preserves config-file values', () => {
    writeConfigYaml({ workflow: { auto_approve_spec: true, auto_approve_plan: true, max_retries: 3, commit_strategy: 'none', mode: 'standard' } });
    configStore.load(tmpDir, { autoApprove: undefined });
    expect(configStore.get().config!.workflow.autoApproveSpec).toBe(true);
    expect(configStore.get().config!.workflow.autoApprovePlan).toBe(true);
  });

  it('reload re-reads config and re-applies overrides', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'first' } });
    expect(configStore.get().config!.implementer.model).toBe('first');
    configStore.reload();
    expect(configStore.get().config!.implementer.model).toBe('first');
  });
});

describe('configStore.save', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-store-test-'));
    configStore.reset();
    feedbackStore.reset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    configStore.reset();
    feedbackStore.reset();
  });

  it('throws when save is called before load', () => {
    expect(() => configStore.save({} as any)).toThrow('configStore.load must be called before save');
  });

  it('writes config to disk and updates store', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    const updated = { ...configStore.get().config!, theme: 'mono' as const };
    configStore.save(updated);

    expect(configStore.get().config!.theme).toBe('mono');
    const written = YAML.parse(readFileSync(join(tmpDir, '.tiny-spec', 'config.yaml'), 'utf-8'));
    expect(written.theme).toBe('mono');
  });

  it('reports error to feedbackStore when write fails', () => {
    writeConfigYaml();
    configStore.load(tmpDir);
    // Replace projectDir with a path containing a null byte to force mkdirSync to throw
    configStore.reset({ ...configStore.get(), projectDir: '/tmp/\0invalid' });
    configStore.save(configStore.get().config!);
    expect(feedbackStore.get().message).toMatch(/Failed to save config/);
    expect(feedbackStore.get().isError).toBe(true);
  });

  it('save does not re-apply CLI overrides', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    expect(configStore.get().config!.implementer.model).toBe('cli-override');
    const updated = { ...configStore.get().config!, implementer: { ...configStore.get().config!.implementer, model: 'picker-choice' } };
    configStore.save(updated);
    expect(configStore.get().config!.implementer.model).toBe('picker-choice');
  });

  it('save then reload re-applies overrides, overwriting picker selection', () => {
    writeConfigYaml();
    configStore.load(tmpDir, { implementer: { model: 'cli-override' } });
    const updated = { ...configStore.get().config!, implementer: { ...configStore.get().config!.implementer, model: 'picker-choice' } };
    configStore.save(updated);
    expect(configStore.get().config!.implementer.model).toBe('picker-choice');
    configStore.reload();
    expect(configStore.get().config!.implementer.model).toBe('cli-override');
  });
});
