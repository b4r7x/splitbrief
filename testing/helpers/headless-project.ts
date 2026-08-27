import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeRunnerGate } from '#testing/helpers/runner-gate.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../src/core/paths.js';
import { resolveImplementerProfiles } from '../../src/core/config/accessors/implementer-profiles.js';
import { configuredReviewerRunner } from '../../src/core/config/accessors/reviewer-runner.js';
import { loadConfig } from '../../src/core/config/load/io.js';
import { configForSessionTranscriptPolicy } from '../../src/core/sessions/io.js';
import { reactivateExistingSession } from '../../src/core/sessions/active-pointer.js';
import type { WorkflowState } from '../../src/core/schemas/workflow.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../src/engine/runners/prepared-execution.js';

export function preparedHeadlessExecution(input: {
  projectDir: string;
  sessionId: string;
  feature: string;
  resumeState?: WorkflowState | undefined;
  purpose?: PreparedExecution['purpose'];
}): PreparedExecution {
  const ref = { projectDir: input.projectDir, sessionId: input.sessionId };
  const config = parsePreparedConfig(
    configForSessionTranscriptPolicy(loadConfig(input.projectDir).config, ref),
  );
  const active = reactivateExistingSession(ref);
  const preparationId = `headless-test-${input.sessionId}`;
  const configuredReviewer = configuredReviewerRunner(config);
  const gates = [
    makeRunnerGate(config.planner, { role: 'planner' }, preparationId),
    ...resolveImplementerProfiles(config).profiles.map((profile) =>
      makeRunnerGate(profile.config, { role: 'implementer', profile: profile.name }, preparationId),
    ),
    ...(configuredReviewer === undefined
      ? []
      : [makeRunnerGate(configuredReviewer, { role: 'reviewer' }, preparationId)]),
  ];
  return {
    purpose: input.purpose ?? (input.resumeState === undefined ? 'new-workflow' : 'resume'),
    config,
    preparationId,
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir: input.projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates,
    session: { kind: 'existing', ref, active },
    runtime: {
      feature: input.feature,
      ...(input.resumeState !== undefined && { resumeState: input.resumeState }),
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

export function writeHeadlessConfigYaml(projectDir: string, yamlLines: string[]): void {
  const dir = join(projectDir, SPLITBRIEF_DIR);
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
    '  service: anthropic',
    '  offering: payg',
    '  model: claude-sonnet-4-6',
    '  api_base: https://api.anthropic.com/v1',
    '  api_key: test-key',
    'implementer:',
    '  kind: api',
    '  provider: anthropic',
    '  service: anthropic',
    '  offering: payg',
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
    '  approve: none',
    '  persist_transcript: false',
    '  max_budget: 20',
    `  budget_pause_threshold: ${pauseThreshold}`,
  ]);
}

export function writeMinimalHeadlessConfigYaml(
  projectDir: string,
  opts?: { reviewerTool: string },
): void {
  writeHeadlessConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: cli',
    '  tool: claude-code',
    ...(opts === undefined ? [] : ['reviewer:', '  kind: cli', `  tool: ${opts.reviewerTool}`]),
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  service: ollama',
    '  offering: local',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  approve: none',
    '  mode: quick',
    '  task_review: none',
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
    '  service: ollama',
    '  offering: local',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'workflow:',
    '  approve: none',
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
