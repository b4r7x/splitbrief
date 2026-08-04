import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPackageJson } from '../project-meta.js';
import { configErrorDiagnosticState } from '../config/errors.js';
import { configPath, loadConfig } from '../config/load/io.js';
import { workflowOptsToCLIOverrides } from '../config/runtime/overrides/from-options.js';
import { resolveEffectiveConfig } from '../config/runtime/effective-config.js';
import { readActive, isSessionLive } from '../sessions/lifecycle.js';
import {
  isGitRepo,
  hasCommits,
  getInProgressGitOp,
  hasCommitterIdentity,
} from '../../lib/git/repository.js';
import { getGitStatus } from '../../lib/git/files.js';
import { getCurrentBranch } from '../../lib/git/refs.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { isRecord } from '../../utils/type-guards.js';
import { buildReadinessReport } from './checks/build.js';
import { probeValidationBaseline } from './checks/validation.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from './status.js';
import type { Config } from '../schemas/config.js';
import type { ApproveLevel, CommitStrategy } from '../schemas/enums.js';
import { cliReadinessCheckId, type CliReadinessResult } from '../schemas/readiness.js';
import { CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import type { WorkflowOpts } from '../types/config-options.js';
import type { SessionRef } from '../types/session-ref.js';
import type { BuildReadinessReportInput } from './checks/build.js';
import type { ConfigReadinessInput } from './checks/config.js';
import type { PackageScriptsReadinessInput } from './checks/validation.js';
import type { RepoReadinessInput } from './checks/repo.js';
import type { ReadinessCheck, ReadinessReport } from './types.js';

export interface CollectedReadiness {
  report: ReadinessReport;
  config?: Config | undefined;
}

export interface CollectReadinessOptions {
  projectDir: string;
  opts?: WorkflowOpts | undefined;
  config?: Config | undefined;
  cliReadiness?: readonly CliReadinessResult[] | undefined;
  /**
   * Optional live CLI probe for doctor-style diagnostics. Execution admission
   * performs its own fresh generic runner preparation.
   */
  detectCliReadiness?:
    | ((input: {
        projectDir: string;
        config: Config;
        opts: WorkflowOpts;
      }) => Promise<readonly CliReadinessResult[]>)
    | undefined;
  defaultApprove?: ApproveLevel | undefined;
  probeValidation?: boolean | undefined;
  resumeSession?: SessionRef | undefined;
}

const CLI_READINESS_CHECK_IDS = new Set(CLI_TOOL_IDS.map((tool) => cliReadinessCheckId(tool)));

export function applyRunnerPreparationChecks(
  report: ReadinessReport,
  runnerChecks: readonly ReadinessCheck[],
): ReadinessReport {
  const sections = report.sections.map((section) =>
    section.id === 'runners'
      ? {
          ...section,
          checks: [
            ...section.checks.filter((check) => !CLI_READINESS_CHECK_IDS.has(check.id)),
            ...runnerChecks,
          ],
        }
      : section,
  );
  const checks = flattenReadinessChecks(sections);
  const counts = countReadinessChecks(checks);
  const status = aggregateReadinessStatus(counts);
  return {
    ...report,
    sections,
    counts,
    status,
    nextAction: selectNextAction(checks, status),
  };
}

export async function collectReadiness(
  options: CollectReadinessOptions,
): Promise<CollectedReadiness> {
  const configFile = configPath(options.projectDir);
  const configExists = existsSync(configFile);
  const loaded = loadReadinessConfig(options, configFile, configExists);
  const packageScripts = readPackageScripts(options.projectDir);
  const repo = await readRepoPosture(
    options.projectDir,
    loaded.config?.workflow.git?.commitStrategy,
    options.resumeSession,
  );
  let cliReadiness = options.cliReadiness;
  if (cliReadiness === undefined && loaded.config && options.detectCliReadiness) {
    try {
      cliReadiness = await options.detectCliReadiness({
        projectDir: options.projectDir,
        config: loaded.config,
        opts: options.opts ?? {},
      });
    } catch {
      // A missing or failed live probe is represented by an empty diagnostic
      // result so runner readiness emits its existing blocker.
      cliReadiness = [];
    }
  }
  const input: BuildReadinessReportInput = {
    projectDir: options.projectDir,
    configLoad: loaded.configLoad,
    packageScripts,
    repo,
    ...(loaded.config !== undefined && { config: loaded.config }),
    ...(cliReadiness !== undefined && { cliReadiness }),
  };

  const report = buildReadinessReport(input);
  if (options.probeValidation === true && loaded.config) {
    const probeChecks = await probeValidationBaseline(loaded.config, options.projectDir);
    if (probeChecks.length > 0) {
      mergeProbeChecks(report, probeChecks);
    }
  }

  return {
    report,
    config: loaded.config,
  };
}

function mergeProbeChecks(report: ReadinessReport, probeChecks: ReadinessCheck[]): void {
  const validationSection = report.sections.find((section) => section.id === 'validation');
  if (validationSection) {
    validationSection.checks.push(...probeChecks);
  } else {
    report.sections.push({ id: 'validation', title: 'Validation', checks: probeChecks });
  }
  const checks = flattenReadinessChecks(report.sections);
  report.counts = countReadinessChecks(checks);
  report.status = aggregateReadinessStatus(report.counts);
  report.nextAction = selectNextAction(checks, report.status);
}

function loadReadinessConfig(
  options: CollectReadinessOptions,
  filePath: string,
  configExists: boolean,
): { config?: Config | undefined; configLoad: ConfigReadinessInput } {
  if (options.config) {
    return {
      config: options.config,
      configLoad: {
        state: configExists ? 'loaded' : 'missing',
        path: filePath,
        warnings: [],
      },
    };
  }

  if (!configExists) {
    return {
      configLoad: {
        state: 'missing',
        path: filePath,
        warnings: [],
      },
    };
  }

  try {
    const loaded = loadConfig(options.projectDir);
    const cliOverrides = workflowOptsToCLIOverrides(options.opts ?? {});
    const { config, warnings: effectiveWarnings } = resolveEffectiveConfig({
      base: loaded.config,
      overrides: { ...cliOverrides, approve: cliOverrides.approve ?? options.defaultApprove },
      loaderDiagnostics: loaded.loaderDiagnostics,
    });
    return {
      config,
      configLoad: { state: 'loaded', path: filePath, warnings: effectiveWarnings },
    };
  } catch (err) {
    const diagnosticState = configErrorDiagnosticState(err);
    return {
      configLoad: {
        state: 'invalid',
        path: filePath,
        warnings: [],
        error: toErrorMessage(err, { preserveLineBreaks: true }),
        ...(diagnosticState !== undefined && { diagnosticState }),
      },
    };
  }
}

function readPackageScripts(projectDir: string): PackageScriptsReadinessInput {
  const packageJsonPath = join(projectDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return { packageJsonExists: false, scripts: {} };
  }

  try {
    const parsed: unknown = readPackageJson(projectDir, { throwOnInvalid: true });
    if (!isRecord(parsed)) {
      return {
        packageJsonExists: true,
        scripts: {},
        parseError: 'package.json root is not an object.',
      };
    }
    const scripts: unknown = parsed['scripts'];
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      return { packageJsonExists: true, scripts: {} };
    }
    const entries = Object.entries(scripts).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return { packageJsonExists: true, scripts: Object.fromEntries(entries) };
  } catch (err) {
    return {
      packageJsonExists: true,
      scripts: {},
      parseError: toErrorMessage(err),
    };
  }
}

async function readRepoPosture(
  projectDir: string,
  commitStrategy?: CommitStrategy | undefined,
  resumeSession?: SessionRef | undefined,
): Promise<RepoReadinessInput> {
  const repoExists = await isGitRepo(projectDir).catch(() => false);
  if (!repoExists) {
    return {
      isGitRepo: false,
      hasCommits: false,
      dirtyFiles: [],
      untrackedFiles: [],
    };
  }

  const repoHasCommits = await hasCommits(projectDir).catch(() => false);
  if (!repoHasCommits) {
    return {
      isGitRepo: true,
      hasCommits: false,
      dirtyFiles: [],
      untrackedFiles: [],
    };
  }

  const status = await getGitStatus(projectDir);
  const untracked = new Set(status.not_added);
  const dirtyFiles = status.files.map((file) => file.path).filter((path) => !untracked.has(path));
  const inProgressGitOp = await getInProgressGitOp(projectDir).catch(() => null);
  const onDetachedHead = (await getCurrentBranch(projectDir).catch(() => '')) === 'HEAD';
  const activeSession = readActive(projectDir);
  const activeSessionBelongsToResume =
    activeSession !== null &&
    resumeSession?.projectDir === projectDir &&
    resumeSession.sessionId === activeSession;
  const commitsConfigured = commitStrategy !== undefined && commitStrategy !== 'none';
  const committerIdentityConfigured = commitsConfigured
    ? await hasCommitterIdentity(projectDir).catch(() => true)
    : undefined;

  return {
    isGitRepo: true,
    hasCommits: true,
    dirtyFiles,
    untrackedFiles: status.not_added,
    onDetachedHead,
    inProgressGitOp,
    ...(commitStrategy !== undefined && { commitStrategy }),
    ...(committerIdentityConfigured !== undefined && { committerIdentityConfigured }),
    ...(activeSession !== null &&
      !activeSessionBelongsToResume && {
        activeSession,
        activeSessionLive: isSessionLive({ projectDir: projectDir, sessionId: activeSession }),
      }),
  };
}
