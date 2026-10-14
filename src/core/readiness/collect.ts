import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPackageJson } from '../project-meta.js';
import { configErrorDiagnosticState } from '../config/errors.js';
import { loadConfig } from '../config/load/io.js';
import {
  configPath,
  readConfigDocument,
  type ConfigDocumentSnapshot,
} from '../config/load/document.js';
import { getIsolationStrategy } from '../config/accessors/values.js';
import { workflowOptsToCLIOverrides } from '../config/runtime/overrides/from-options.js';
import { resolveEffectiveConfig } from '../config/runtime/effective-config.js';
import { readActive } from '../sessions/active-pointer.js';
import { isSessionLive } from '../sessions/liveness.js';
import { isInternalGitStatusPath } from '../paths.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreWorktreeUncommittedPath,
} from '../gitignore-bookkeeping.js';
import { isGitRepo, hasCommits, getInProgressGitOp } from '../../lib/git/repository.js';
import { getGitStatus } from '../../lib/git/files.js';
import { getCurrentBranch } from '../../lib/git/refs.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { isRecord } from '../../utils/type-guards.js';
import { buildReadinessReport } from './checks/build.js';
import { buildIsolationChecks } from './checks/isolation.js';
import { buildClaudeSandboxChecks, isOnSeatPath } from './checks/claude-sandbox.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from './status.js';
import type { Config } from '../schemas/config.js';
import type { IsolationStrategy } from '../schemas/enums.js';
import { cliReadinessCheckId, type CliReadinessResult } from '../schemas/readiness.js';
import { CLI_TOOL_IDS } from '../runners/cli-tool-catalog.js';
import type { ActiveRunnerRole } from '../runners/seat-roles.js';
import type { WorkflowOpts } from '../types/config-options.js';
import type { SessionRef } from '../types/session-ref.js';
import type { BuildReadinessReportInput } from './checks/build.js';
import type { RunnerAvailabilityFact } from './checks/availability.js';
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
  /**
   * Live reachability probe for the `api` runners a run will
   * actually call. Without it readiness makes no availability claim, and an
   * unreachable implementer only surfaces after the planning phase is paid for.
   */
  probeRunnerAvailability?:
    | ((input: { config: Config }) => Promise<readonly RunnerAvailabilityFact[]>)
    | undefined;
  /** How the run the report describes starts; a headless one approves its plan card unattended. */
  interaction?: 'interactive' | 'headless' | undefined;
  /** The seats the run will call. Omitted, the report covers every seat, as `doctor` does. */
  roles?: readonly ActiveRunnerRole[] | undefined;
  /**
   * Optional headless-equivalent runner admission probe for doctor-style
   * diagnostics. Execution admission performs its own fresh generic runner
   * preparation.
   */
  probeRunnerAdmission?:
    | ((input: {
        projectDir: string;
        config: Config;
        interaction: 'interactive' | 'headless';
      }) => Promise<readonly ReadinessCheck[]>)
    | undefined;
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
  const repo = await readRepoPosture(options.projectDir, options.resumeSession);
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
  let availability: readonly RunnerAvailabilityFact[] | undefined;
  if (loaded.config && options.probeRunnerAvailability) {
    try {
      availability = await options.probeRunnerAvailability({ config: loaded.config });
    } catch {
      // A probe that could not run makes no claim, so readiness falls back to
      // its "not probed" notice rather than reporting the runners as available.
      availability = undefined;
    }
  }
  const input: BuildReadinessReportInput = {
    projectDir: options.projectDir,
    configLoad: loaded.configLoad,
    packageScripts,
    repo,
    ...(loaded.config !== undefined && { config: loaded.config }),
    ...(cliReadiness !== undefined && { cliReadiness }),
    ...(availability !== undefined && { availability }),
    ...(options.interaction !== undefined && { interaction: options.interaction }),
  };

  let report = buildReadinessReport(input);
  let isolationChecks: ReadinessCheck[];
  try {
    isolationChecks = buildIsolationChecks(options.projectDir, loaded.isolation);
  } catch (err) {
    isolationChecks = [
      {
        id: 'isolation.check-failed',
        severity: 'warning',
        summary: 'Worktree compatibility could not be checked.',
        details: [toErrorMessage(err, { preserveLineBreaks: true })],
      },
    ];
  }
  if (isolationChecks.length > 0) {
    mergeChecks(report, { id: 'repo', title: 'Repository' }, isolationChecks);
  }
  // Only the implementer starts Claude Code's sandbox, so a run that calls no
  // implementer (a spec run, a one-shot review) does not need bwrap or socat.
  if (loaded.config && (options.roles?.includes('implementer') ?? true)) {
    const sandboxChecks = buildClaudeSandboxChecks(loaded.config, {
      platform: process.platform,
      isOnPath: (program) => isOnSeatPath(program, options.projectDir),
    });
    if (sandboxChecks.length > 0) {
      mergeChecks(report, { id: 'runners', title: 'Runners' }, sandboxChecks);
    }
  }
  if (loaded.config && options.interaction && options.probeRunnerAdmission) {
    try {
      const admissionChecks = await options.probeRunnerAdmission({
        projectDir: options.projectDir,
        config: loaded.config,
        interaction: options.interaction,
      });
      if (admissionChecks.length > 0) {
        report = applyRunnerPreparationChecks(report, admissionChecks);
      }
    } catch {
      // A probe that could not run makes no admission claim.
    }
  }

  return {
    report,
    config: loaded.config,
  };
}

function mergeChecks(
  report: ReadinessReport,
  section: { id: string; title: string },
  checks: ReadinessCheck[],
): void {
  const existing = report.sections.find((candidate) => candidate.id === section.id);
  if (existing) {
    existing.checks.push(...checks);
  } else {
    report.sections.push({ id: section.id, title: section.title, checks });
  }
  const all = flattenReadinessChecks(report.sections);
  report.counts = countReadinessChecks(all);
  report.status = aggregateReadinessStatus(report.counts);
  report.nextAction = selectNextAction(all, report.status);
}

function loadReadinessConfig(
  options: CollectReadinessOptions,
  filePath: string,
  configExists: boolean,
): {
  config?: Config | undefined;
  configLoad: ConfigReadinessInput;
  isolation?: IsolationStrategy | undefined;
} {
  if (options.config) {
    return {
      config: options.config,
      isolation: configuredIsolation(
        options.config,
        readConfigDocument(options.projectDir).document,
      ),
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
      overrides: cliOverrides,
      loaderDiagnostics: loaded.loaderDiagnostics,
    });
    return {
      config,
      configLoad: { state: 'loaded', path: filePath, warnings: effectiveWarnings },
      isolation: configuredIsolation(config, loaded.document),
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

/** The loaded config always carries a default; only the file says whether the user chose one. */
function configuredIsolation(
  config: Config,
  document: ConfigDocumentSnapshot['document'],
): IsolationStrategy | undefined {
  return document.hasIn(['workflow', 'isolation']) ? getIsolationStrategy(config) : undefined;
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
  // The dirty-worktree check is about the operator's own edits. SPLITBRIEF's
  // state directory, old `.trees/` directories and its own `.gitignore` lines can show up
  // in git status, so counting them would report the tool's own bookkeeping as local work
  // the run might overwrite. The run sets the same files apart from its pre-run changes.
  const gitignoreOnlyBookkeeping =
    status.files.some((file) => file.path === '.gitignore') &&
    (await gitignoreDiffersOnlyBySplitbriefBookkeeping(projectDir));
  const isOperatorChange = (path: string) =>
    !isInternalGitStatusPath(path) &&
    !shouldIgnoreWorktreeUncommittedPath(path, gitignoreOnlyBookkeeping);
  const dirtyFiles = status.files
    .map((file) => file.path)
    .filter((path) => !untracked.has(path) && isOperatorChange(path));
  const untrackedFiles = status.not_added.filter(isOperatorChange);
  const inProgressGitOp = await getInProgressGitOp(projectDir).catch(() => null);
  const onDetachedHead = (await getCurrentBranch(projectDir).catch(() => '')) === 'HEAD';
  const activeSession = readActive(projectDir);
  const activeSessionBelongsToResume =
    activeSession !== null &&
    resumeSession?.projectDir === projectDir &&
    resumeSession.sessionId === activeSession;

  return {
    isGitRepo: true,
    hasCommits: true,
    dirtyFiles,
    untrackedFiles,
    onDetachedHead,
    inProgressGitOp,
    ...(activeSession !== null &&
      !activeSessionBelongsToResume && {
        activeSession,
        activeSessionLive: isSessionLive({ projectDir: projectDir, sessionId: activeSession }),
      }),
  };
}
