import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveApproveLevel, resolveEffortLevel, resolveMode } from '../config/runtime/resolve.js';
import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { getRunnerDisplayName, getRunnerModelName } from '../config/accessors/runner-config.js';
import { isProviderLocal, isProviderSubscription } from '../providers/catalog.js';
import { parseShellCommand } from '../../utils/parse-shell-command.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from './status.js';
import type { Config } from '../schemas/config.js';
import type { ReadinessCheck, ReadinessReport, ReadinessSection } from './types.js';

export interface ConfigReadinessInput {
  state: 'loaded' | 'missing' | 'invalid';
  path: string;
  warnings: string[];
  error?: string | undefined;
  migratedInMemory?: boolean | undefined;
}

export interface PackageScriptsReadinessInput {
  packageJsonExists: boolean;
  scripts: Record<string, string>;
  parseError?: string | undefined;
}

export interface RepoReadinessInput {
  isGitRepo: boolean;
  dirtyFiles: string[];
  untrackedFiles: string[];
  activeSession?: string | undefined;
  activeSessionLive?: boolean | undefined;
  requiresCleanWorktree?: boolean | undefined;
}

export interface BuildReadinessReportInput {
  projectDir: string;
  config?: Config | undefined;
  configLoad: ConfigReadinessInput;
  packageScripts: PackageScriptsReadinessInput;
  repo: RepoReadinessInput;
}

const MODE_CONTEXT_FLOORS: Record<string, number> = {
  instant: 8_000,
  quick: 16_000,
  standard: 32_000,
  speckit: 64_000,
};

export function buildReadinessReport(input: BuildReadinessReportInput): ReadinessReport {
  const sections = buildSections(input);
  const checks = flattenReadinessChecks(sections);
  const counts = countReadinessChecks(checks);
  const status = aggregateReadinessStatus(counts);
  const nextAction = selectNextAction(checks, status);
  const mode = input.config ? resolveMode({ config: input.config }) : undefined;
  const approve = input.config
    ? resolveApproveLevel({
      mode: resolveMode({ config: input.config }),
      configApprove: input.config.workflow.approve,
      legacyAutoFlag: input.config.workflow.autoApproveSpec === true && input.config.workflow.autoApprovePlan === true,
    })
    : undefined;

  return {
    generatedAt: new Date().toISOString(),
    projectDir: input.projectDir,
    status,
    counts,
    nextAction,
    sections,
    metadata: {
      configPath: input.configLoad.path,
      configExists: input.configLoad.state !== 'missing',
      ...(mode !== undefined && { mode }),
      ...(approve !== undefined && { approve }),
    },
  };
}

function buildSections(input: BuildReadinessReportInput): ReadinessSection[] {
  const sections: ReadinessSection[] = [
    {
      id: 'config',
      title: 'Config',
      checks: buildConfigChecks(input.configLoad),
    },
    {
      id: 'repo',
      title: 'Repository',
      checks: buildRepoChecks(input.repo),
    },
  ];

  if (!input.config) return sections;

  sections.splice(
    1,
    0,
    {
      id: 'mode',
      title: 'Mode',
      checks: buildModeChecks(input.config),
    },
    {
      id: 'runners',
      title: 'Runners',
      checks: buildRunnerChecks(input.config),
    },
    {
      id: 'context',
      title: 'Context',
      checks: buildContextChecks(input.config),
    },
    {
      id: 'validation',
      title: 'Validation',
      checks: buildValidationChecks(input.config, input.packageScripts, input.projectDir),
    },
    {
      id: 'cost',
      title: 'Cost',
      checks: buildCostChecks(input.config),
    },
  );

  return sections;
}

function buildConfigChecks(configLoad: ConfigReadinessInput): ReadinessCheck[] {
  if (configLoad.state === 'missing') {
    return [{
      id: 'config.missing',
      severity: 'blocker',
      summary: 'No .diptych/config.yaml found.',
      fix: 'Run `diptych init` to create a config.',
      nextAction: 'run-init',
      metadata: { path: configLoad.path },
    }];
  }

  if (configLoad.state === 'invalid') {
    return [{
      id: 'config.invalid',
      severity: 'blocker',
      summary: 'Config could not be loaded.',
      details: configLoad.error ? [configLoad.error] : undefined,
      fix: 'Fix .diptych/config.yaml or run `diptych init --reconfigure`.',
      nextAction: 'fix-config',
      metadata: { path: configLoad.path },
    }];
  }

  const checks: ReadinessCheck[] = [{
    id: 'config.loaded',
    severity: 'ok',
    summary: 'Config loaded.',
    details: [`Path: ${configLoad.path}`],
    metadata: {
      path: configLoad.path,
      migratedInMemory: configLoad.migratedInMemory === true,
    },
  }];

  for (const warning of configLoad.warnings) {
    checks.push({
      id: 'config.warning',
      severity: 'warning',
      summary: warning,
      fix: warning.includes('version 2') ? 'Run `diptych migrate` or rerun `diptych init`.' : undefined,
      nextAction: warning.includes('version 2') ? 'fix-config' : undefined,
    });
  }

  return checks;
}

function buildModeChecks(config: Config): ReadinessCheck[] {
  const mode = resolveMode({ config });
  const approve = resolveApproveLevel({
    mode,
    configApprove: config.workflow.approve,
    legacyAutoFlag: config.workflow.autoApproveSpec === true && config.workflow.autoApprovePlan === true,
  });
  const effort = resolveEffortLevel({ config });
  return [{
    id: 'mode.resolved',
    severity: 'info',
    summary: `Mode ${mode}; approval ${approve}.`,
    details: [
      `Retries: ${config.workflow.maxRetries}`,
      `Planner effort: ${effort ?? 'provider default'}`,
      `Transcript persistence: ${config.workflow.persistTranscript ? 'on' : 'off'}`,
    ],
    metadata: {
      mode,
      approve,
      maxRetries: config.workflow.maxRetries,
      persistTranscript: config.workflow.persistTranscript,
      effort: effort ?? null,
    },
  }];
}

function buildRunnerChecks(config: Config): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];
  checks.push(runnerCheck('planner', config.planner));

  try {
    const resolved = resolveImplementerProfiles(config);
    const defaultProfile = resolved.defaultProfile;
    checks.push({
      id: 'runners.implementer.default',
      severity: 'info',
      summary: `Default implementer ${formatRunner(defaultProfile.config)} via profile ${defaultProfile.name}.`,
      details: [
        `Profiles: ${resolved.profiles.map(profile => profile.name).join(', ')}`,
        `Cost tier: ${defaultProfile.costTier}`,
        `Write mode: ${defaultProfile.capabilities.writesFiles}`,
      ],
      metadata: {
        defaultProfile: defaultProfile.name,
        profileCount: resolved.profiles.length,
        costTier: defaultProfile.costTier,
        writeMode: defaultProfile.capabilities.writesFiles,
      },
    });
  } catch (err) {
    checks.push({
      id: 'runners.implementer.profiles-invalid',
      severity: 'blocker',
      summary: err instanceof Error ? err.message : String(err),
      fix: 'Fix implementerProfiles.default or remove the broken profile setting.',
      nextAction: 'fix-config',
    });
  }

  checks.push({
    id: 'runners.availability',
    severity: 'info',
    summary: 'Runner availability was not probed.',
    details: [
      'Readiness does not require network probes or CLI auth checks.',
      'Verify the runner CLI directly if availability is uncertain.',
    ],
  });

  return checks;
}

function runnerCheck(role: 'planner' | 'implementer', runner: Config['planner'] | Config['implementer']): ReadinessCheck {
  return {
    id: `runners.${role}.configured`,
    severity: 'ok',
    summary: `${capitalize(role)} ${formatRunner(runner)} configured.`,
    metadata: {
      role,
      kind: runner.kind,
      name: getRunnerDisplayName(runner),
      model: getRunnerModelName(runner) ?? null,
      contextLength: runner.contextLength ?? null,
    },
  };
}

function buildContextChecks(config: Config): ReadinessCheck[] {
  const mode = resolveMode({ config });
  const floor = MODE_CONTEXT_FLOORS[mode] ?? 32_000;
  const checks: ReadinessCheck[] = [
    contextLengthCheck('planner', config.planner.contextLength, floor),
  ];

  try {
    const profiles = resolveImplementerProfiles(config);
    checks.push(contextLengthCheck('implementer', profiles.defaultProfile.config.contextLength, floor));
  } catch {
    return checks;
  }

  return checks;
}

function contextLengthCheck(role: 'planner' | 'implementer', contextLength: number | undefined, floor: number): ReadinessCheck {
  if (contextLength === undefined) {
    return {
      id: `context.${role}.missing`,
      severity: 'warning',
      summary: `${capitalize(role)} context length is not configured.`,
      fix: `Set ${role}.contextLength if the provider reports an unreliable context window.`,
      nextAction: 'raise-context',
      metadata: { role, contextLength: null, recommendedMinimum: floor },
    };
  }

  if (contextLength < floor) {
    return {
      id: `context.${role}.tight`,
      severity: 'warning',
      summary: `${capitalize(role)} context length ${contextLength} may be tight for this mode.`,
      fix: 'Use a larger model/context window or choose a smaller workflow mode.',
      nextAction: 'raise-context',
      metadata: { role, contextLength, recommendedMinimum: floor },
    };
  }

  return {
    id: `context.${role}.ok`,
    severity: 'ok',
    summary: `${capitalize(role)} context length ${contextLength} is configured.`,
    metadata: { role, contextLength, recommendedMinimum: floor },
  };
}

function buildValidationChecks(
  config: Config,
  packageScripts: PackageScriptsReadinessInput,
  projectDir: string,
): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [{
    id: 'validation.configured',
    severity: 'info',
    summary: `Validation: typecheck ${onOff(config.validation.typecheck)}, lint ${onOff(config.validation.lint)}, test ${onOff(config.validation.test)}.`,
    details: [`Test command: ${config.validation.testCommand}`],
    metadata: {
      typecheck: config.validation.typecheck,
      lint: config.validation.lint,
      test: config.validation.test,
      testCommand: config.validation.testCommand,
    },
  }];

  const disabled = [
    !config.validation.typecheck ? 'typecheck' : null,
    !config.validation.lint ? 'lint' : null,
    !config.validation.test ? 'test' : null,
  ].filter((value): value is string => value !== null);

  if (disabled.length > 0) {
    checks.push({
      id: 'validation.disabled',
      severity: 'warning',
      summary: `Validation checks disabled: ${disabled.join(', ')}.`,
      fix: 'Enable validation checks in .diptych/config.yaml when the project supports them.',
    });
  }

  if (config.validation.lint && !hasKnownLinterConfig(projectDir)) {
    checks.push({
      id: 'validation.lint-unknown',
      severity: 'info',
      summary: 'No ESLint or Biome config detected.',
      details: ['Task validation skips lint when no supported linter config exists.'],
    });
  }

  if (config.validation.test) {
    const testScriptWarning = testCommandWarning(config.validation.testCommand, packageScripts);
    if (testScriptWarning) checks.push(testScriptWarning);
  }

  if (packageScripts.parseError) {
    checks.push({
      id: 'validation.package-json-invalid',
      severity: 'warning',
      summary: 'package.json could not be parsed for validation posture.',
      details: [packageScripts.parseError],
    });
  }

  return checks;
}

function buildRepoChecks(repo: RepoReadinessInput): ReadinessCheck[] {
  if (!repo.isGitRepo) {
    return [{
      id: 'repo.not-git',
      severity: 'blocker',
      summary: 'Project is not a git repository.',
      fix: 'Run `git init` first or choose a project directory inside a git repository.',
      nextAction: 'clean-or-isolate-repo',
    }];
  }

  const checks: ReadinessCheck[] = [{
    id: 'repo.git',
    severity: 'ok',
    summary: 'Git repository detected.',
  }];

  if (repo.activeSession) {
    checks.push({
      id: repo.activeSessionLive ? 'repo.active-session-live' : 'repo.active-session-stale',
      severity: repo.activeSessionLive ? 'blocker' : 'info',
      summary: repo.activeSessionLive
        ? `Active session ${repo.activeSession} is still live.`
        : `Stale active session marker ${repo.activeSession} can be cleared.`,
      fix: repo.activeSessionLive
        ? 'Run `diptych resume` or clear .diptych/active after confirming the session is not live.'
        : undefined,
      nextAction: repo.activeSessionLive ? 'clean-or-isolate-repo' : undefined,
      metadata: { sessionId: repo.activeSession, live: repo.activeSessionLive === true },
    });
  }

  const dirtyCount = repo.dirtyFiles.length;
  const untrackedCount = repo.untrackedFiles.length;
  if (dirtyCount > 0 || untrackedCount > 0) {
    const examples = [...repo.dirtyFiles, ...repo.untrackedFiles].slice(0, 5);
    checks.push({
      id: repo.requiresCleanWorktree ? 'repo.dirty-worktree-blocked' : 'repo.dirty-worktree',
      severity: repo.requiresCleanWorktree ? 'blocker' : 'warning',
      summary: `Working tree has ${dirtyCount} changed and ${untrackedCount} untracked file${untrackedCount === 1 ? '' : 's'}.`,
      details: examples.length > 0 ? [`Examples: ${examples.join(', ')}`] : undefined,
      fix: repo.requiresCleanWorktree
        ? 'Clean the source checkout before creating an isolated worktree.'
        : 'Review local edits before starting if they may overlap the requested change.',
      nextAction: repo.requiresCleanWorktree ? 'clean-or-isolate-repo' : undefined,
      metadata: { dirtyCount, untrackedCount },
    });
  }

  return checks;
}

function buildCostChecks(config: Config): ReadinessCheck[] {
  const runnerNames = [
    getRunnerDisplayName(config.planner),
    getRunnerDisplayName(config.implementer),
  ];
  const priced = runnerNames.some(name => !isProviderLocal(name) && !isProviderSubscription(name));
  const localOrSubscription = runnerNames.every(name => isProviderLocal(name) || isProviderSubscription(name));

  if (config.workflow.maxBudget !== undefined) {
    return [{
      id: 'cost.budget-set',
      severity: 'ok',
      summary: `Budget cap set to $${config.workflow.maxBudget.toFixed(2)}.`,
      details: [`Pause threshold: ${config.workflow.budgetPauseThreshold ?? 'default'}`],
      metadata: {
        maxBudget: config.workflow.maxBudget,
        pauseThreshold: config.workflow.budgetPauseThreshold ?? null,
      },
    }];
  }

  if (localOrSubscription) {
    return [{
      id: 'cost.local-or-subscription',
      severity: 'info',
      summary: 'Configured runners appear local or subscription-based.',
      details: ['No fake savings estimate is shown without pricing data.'],
    }];
  }

  if (priced) {
    return [{
      id: 'cost.budget-missing',
      severity: 'warning',
      summary: 'No budget cap is set for priced or unknown runners.',
      fix: 'Set workflow.maxBudget or pass --budget for this run.',
      nextAction: 'set-budget',
    }];
  }

  return [{
    id: 'cost.pricing-unknown',
    severity: 'info',
    summary: 'Pricing posture is unknown.',
  }];
}

function formatRunner(runner: Config['planner'] | Config['implementer']): string {
  const model = getRunnerModelName(runner);
  return model ? `${getRunnerDisplayName(runner)} (${model})` : getRunnerDisplayName(runner);
}

function testCommandWarning(
  command: string,
  packageScripts: PackageScriptsReadinessInput,
): ReadinessCheck | null {
  const parts = parseShellCommand(command);
  const commandName = parts[0];
  if (commandName !== 'npm') return null;

  const scriptName = parts[1] === 'run' ? parts[2] : parts[1] === 'test' ? 'test' : undefined;
  if (!scriptName) return null;

  if (!packageScripts.packageJsonExists) {
    return {
      id: 'validation.package-json-missing',
      severity: 'warning',
      summary: `Test command "${command}" references npm scripts, but package.json was not found.`,
      fix: 'Add package.json or update validation.testCommand.',
    };
  }

  if (!Object.hasOwn(packageScripts.scripts, scriptName)) {
    return {
      id: 'validation.test-script-missing',
      severity: 'warning',
      summary: `Test command "${command}" references missing package script "${scriptName}".`,
      fix: 'Add the package script or update validation.testCommand.',
    };
  }

  return null;
}

function hasKnownLinterConfig(projectDir: string): boolean {
  const files = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    'biome.json',
  ];
  return files.some(file => existsSync(join(projectDir, file)));
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
