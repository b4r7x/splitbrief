import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath, loadConfig } from '../config/load/load.js';
import { applyCLIOverrides } from '../config/runtime/overrides.js';
import { readActive, isSessionLive } from '../sessions/lifecycle.js';
import { isGitRepo, getGitStatus } from '../../lib/git.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { isRecord } from '../../utils/type-guards.js';
import { buildReadinessReport } from './checks/build.js';
import type { Config } from '../schemas/config.js';
import type { WorkflowOpts } from '../types/config-options.js';
import type {
  BuildReadinessReportInput,
  ConfigReadinessInput,
  PackageScriptsReadinessInput,
  RepoReadinessInput,
} from './checks/build.js';
import type { ReadinessReport } from './types.js';

export interface CollectedReadiness {
  report: ReadinessReport;
  config?: Config | undefined;
  warnings: string[];
}

export interface CollectReadinessOptions {
  projectDir: string;
  opts?: WorkflowOpts | undefined;
  config?: Config | undefined;
  configWarnings?: string[] | undefined;
  defaultAutoApprove?: boolean | undefined;
  requiresCleanWorktree?: boolean | undefined;
}

export async function collectReadiness(options: CollectReadinessOptions): Promise<CollectedReadiness> {
  const configFile = configPath(options.projectDir);
  const configExists = existsSync(configFile);
  const loaded = loadReadinessConfig(options, configFile, configExists);
  const packageScripts = readPackageScripts(options.projectDir);
  const repo = await readRepoPosture(options.projectDir, options.requiresCleanWorktree === true);
  const input: BuildReadinessReportInput = {
    projectDir: options.projectDir,
    configLoad: loaded.configLoad,
    packageScripts,
    repo,
    ...(loaded.config !== undefined && { config: loaded.config }),
  };

  return {
    report: buildReadinessReport(input),
    config: loaded.config,
    warnings: loaded.warnings,
  };
}

function loadReadinessConfig(
  options: CollectReadinessOptions,
  filePath: string,
  configExists: boolean,
): { config?: Config | undefined; warnings: string[]; configLoad: ConfigReadinessInput } {
  if (options.config) {
    const warnings = options.configWarnings ?? [];
    return {
      config: options.config,
      warnings,
      configLoad: {
        state: configExists ? 'loaded' : 'missing',
        path: filePath,
        warnings,
      },
    };
  }

  if (!configExists) {
    return {
      warnings: [],
      configLoad: {
        state: 'missing',
        path: filePath,
        warnings: [],
      },
    };
  }

  try {
    const loaded = loadConfig(options.projectDir);
    const config = applyCLIOverrides(loaded.config, {
      planner: {
        tool: options.opts?.planner,
        model: options.opts?.plannerModel,
        command: options.opts?.plannerCommand,
      },
      implementer: {
        tool: options.opts?.implementer ?? options.opts?.provider,
        model: options.opts?.implementerModel ?? options.opts?.model,
        command: options.opts?.implementerCommand,
      },
      autoApprove: options.opts?.auto !== undefined ? options.opts.auto : options.defaultAutoApprove,
      approve: options.opts?.approve,
      mode: options.opts?.mode,
      budget: options.opts?.budget,
      plannerEffort: options.opts?.plannerEffort,
    });
    return {
      config,
      warnings: loaded.warnings,
      configLoad: {
        state: 'loaded',
        path: filePath,
        warnings: loaded.warnings,
        migratedInMemory: loaded.warnings.some(warning => warning.includes('config.version 2')),
      },
    };
  } catch (err) {
    return {
      warnings: [],
      configLoad: {
        state: 'invalid',
        path: filePath,
        warnings: [],
        error: toErrorMessage(err),
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
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    if (!isRecord(parsed)) {
      return { packageJsonExists: true, scripts: {}, parseError: 'package.json root is not an object.' };
    }
    const scripts: unknown = parsed['scripts'];
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
      return { packageJsonExists: true, scripts: {} };
    }
    const entries = Object.entries(scripts)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    return { packageJsonExists: true, scripts: Object.fromEntries(entries) };
  } catch (err) {
    return {
      packageJsonExists: true,
      scripts: {},
      parseError: toErrorMessage(err),
    };
  }
}

async function readRepoPosture(projectDir: string, requiresCleanWorktree: boolean): Promise<RepoReadinessInput> {
  const repoExists = await isGitRepo(projectDir).catch(() => false);
  if (!repoExists) {
    return {
      isGitRepo: false,
      dirtyFiles: [],
      untrackedFiles: [],
      requiresCleanWorktree,
    };
  }

  const status = await getGitStatus(projectDir);
  const untracked = new Set(status.not_added);
  const dirtyFiles = status.files
    .map(file => file.path)
    .filter(path => !untracked.has(path));
  const activeSession = readActive(projectDir);

  return {
    isGitRepo: true,
    dirtyFiles,
    untrackedFiles: status.not_added,
    requiresCleanWorktree,
    ...(activeSession !== null && {
      activeSession,
      activeSessionLive: isSessionLive(projectDir, activeSession),
    }),
  };
}
