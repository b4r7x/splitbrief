import { join } from 'node:path';
import { afterEach, it } from 'vitest';
import { normalizeCustomCommand } from '../../src/core/config/custom-commands.js';
import { SPLITBRIEF_DIR } from '../../src/core/paths.js';
import {
  beginDeclaredArtifactReview,
  cleanupStaleArtifactReviews,
} from '../../src/engine/orchestrator/approval/planner-artifact.js';
import { createStagedProject } from '../../src/engine/orchestrator/approval/staged-project.js';
import type { ConfiguredCustomRunner } from '../../src/engine/runners/custom-trust.js';
import type { CustomRunnerRuntimePort } from '../../src/engine/runners/types.js';
import { createTempDir, cleanupTempDir } from './temp-dir.js';
import { createTestGitRepo } from './git.js';

export const itUnix = process.platform === 'win32' ? it.skip : it;

export function createCommandInvokeTestFixtures() {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) cleanupTempDir(directory);
  });

  return {
    testProject(name: string): { projectDir: string; stateDir: string } {
      const projectDir = createTempDir(`${name}-project`);
      const stateDir = createTempDir(`${name}-state`);
      directories.push(projectDir, stateDir);
      createTestGitRepo(projectDir);
      return { projectDir, stateDir };
    },
    trackDirectories(...newDirectories: string[]): void {
      directories.push(...newDirectories);
    },
  };
}

export function configuredPlanner(
  input: Readonly<{
    contract: 'output' | 'direct';
    script: string;
    env?: readonly string[] | undefined;
  }>,
): ConfiguredCustomRunner {
  return {
    source: 'configured',
    command: normalizeCustomCommand(`planner-${input.contract}-test`, {
      label: `Planner ${input.contract} test`,
      contract: input.contract,
      executable: process.execPath,
      argv: ['-e', input.script],
      env: [...(input.env ?? [])],
    }),
  };
}

export function runtimeFor(
  input: Readonly<{
    projectDir: string;
    stateDir: string;
    sourceEnv?: NodeJS.ProcessEnv | undefined;
    allowRepoRunners?: boolean | undefined;
    authorizationPathEnv?: string | undefined;
    authorizationPathExt?: string | undefined;
    createStage?: CustomRunnerRuntimePort['createStage'] | undefined;
    cleanupStaleArtifactReviews?:
      | CustomRunnerRuntimePort['cleanupStaleArtifactReviews']
      | undefined;
    beginDeclaredArtifactReview?:
      | CustomRunnerRuntimePort['beginDeclaredArtifactReview']
      | undefined;
    onApprovalNeeded?: Parameters<typeof beginDeclaredArtifactReview>[0]['onApprovalNeeded'];
  }>,
): CustomRunnerRuntimePort {
  const onApprovalNeeded = input.onApprovalNeeded ?? (async () => ({ approved: true as const }));
  return {
    sessionId: 'planner-adapter-session',
    authorizationProjectDir: input.projectDir,
    sourceEnv: input.sourceEnv ?? {},
    ...(input.authorizationPathEnv === undefined
      ? { authorizationPathEnv: process.env.PATH }
      : { authorizationPathEnv: input.authorizationPathEnv }),
    ...(input.authorizationPathExt === undefined
      ? process.env.PATHEXT === undefined
        ? {}
        : { authorizationPathExt: process.env.PATHEXT }
      : { authorizationPathExt: input.authorizationPathExt }),
    createStage:
      input.createStage ??
      (async (sourceProjectDir: string, _role: 'planner' | 'implementer') =>
        createStagedProject(sourceProjectDir)),
    admission: {
      interaction: 'headless',
      allowRepoRunners: input.allowRepoRunners ?? true,
      stateDir: input.stateDir,
    },
    cleanupStaleArtifactReviews:
      input.cleanupStaleArtifactReviews ??
      (() =>
        cleanupStaleArtifactReviews({
          projectDir: input.projectDir,
          sessionId: 'planner-adapter-session',
        })),
    beginDeclaredArtifactReview:
      input.beginDeclaredArtifactReview ??
      ((artifactInput) =>
        beginDeclaredArtifactReview({
          ...artifactInput,
          onApprovalNeeded,
        })),
  };
}

export function reviewCandidateRoot(projectDir: string): string {
  return join(
    projectDir,
    SPLITBRIEF_DIR,
    'sessions',
    'planner-adapter-session',
    '.custom-runner-review',
  );
}

export function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}
