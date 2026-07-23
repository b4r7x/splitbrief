import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../../src/core/paths.js';

export function writeHeadlessConfigYaml(projectDir: string, yamlLines: string[]): void {
  const dir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, CONFIG_FILE);
  writeFileSync(filePath, yamlLines.join('\n'));
  chmodSync(filePath, 0o600);
}

export function writeBudgetHeadlessConfigYaml(projectDir: string, pauseThreshold = 0.85): void {
  writeHeadlessConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: api',
    '  provider: anthropic',
    '  model: claude-sonnet-4-6',
    '  api_base: https://api.anthropic.com/v1',
    '  api_key: test-key',
    'implementer:',
    '  kind: api',
    '  provider: anthropic',
    '  model: claude-sonnet-4-6',
    '  api_base: https://api.anthropic.com/v1',
    '  api_key: test-key',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  mode: quick',
    '  auto_approve_spec: true',
    '  auto_approve_plan: true',
    '  approve: none',
    '  commit_strategy: none',
    '  persist_transcript: false',
    '  max_budget: 20',
    `  budget_pause_threshold: ${pauseThreshold}`,
  ]);
}

export function writeMinimalHeadlessConfigYaml(projectDir: string): void {
  writeHeadlessConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  auto_approve_spec: true',
    '  auto_approve_plan: true',
    '  approve: none',
    '  commit_strategy: none',
    '  mode: quick',
    '  persist_transcript: false',
  ]);
}

export function writeCurrentTranscriptHeadlessConfigYaml(projectDir: string): void {
  writeHeadlessConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  auto_approve_spec: true',
    '  auto_approve_plan: true',
    '  approve: none',
    '  commit_strategy: none',
    '  mode: quick',
    '  persist_transcript: true',
  ]);
}

export function createHeadlessGitProject(tempPrefix: string): string {
  const projectDir = createTempDir(tempPrefix);
  createTestGitRepo(projectDir);
  return projectDir;
}

export function setupBudgetHeadlessProject(pauseThreshold = 0.85): string {
  const projectDir = createHeadlessGitProject('headless-budget-test');
  writeBudgetHeadlessConfigYaml(projectDir, pauseThreshold);
  return projectDir;
}
