import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { preparedGates, testCliSeats } from '#testing/helpers/runner-gate.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../src/core/paths.js';
import { loadConfig } from '../../src/core/config/load/io.js';
import { reactivateExistingSession } from '../../src/core/sessions/active-pointer.js';
import type { WorkflowState } from '../../src/core/schemas/workflow/state.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../src/engine/runners/prepare-execution/prepared.js';

export function preparedHeadlessExecution(input: {
  projectDir: string;
  sessionId: string;
  feature: string;
  resumeState?: WorkflowState | undefined;
  purpose?: PreparedExecution['purpose'];
}): PreparedExecution {
  const ref = { projectDir: input.projectDir, sessionId: input.sessionId };
  const config = parsePreparedConfig(loadConfig(input.projectDir).config);
  const active = reactivateExistingSession(ref);
  const preparationId = `headless-test-${input.sessionId}`;
  const purpose = input.purpose ?? (input.resumeState === undefined ? 'new-workflow' : 'resume');
  const gates = preparedGates(config, purpose, preparationId);
  return {
    purpose,
    config,
    sourceConfig: config,
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
    cliSeats: testCliSeats(gates),
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
    '  end_checks: false',
    '  test_command: "true"',
    'workflow:',
    '  approve: none',
  ]);
}

export function createHeadlessGitProject(tempPrefix: string): string {
  const projectDir = createTempDir(tempPrefix);
  createTestGitRepo(projectDir);
  return projectDir;
}
