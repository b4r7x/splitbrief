import { resolveApproveLevel, resolveMode } from '../../config/runtime/resolve.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from '../status.js';
import { buildConfigChecks } from './config.js';
import { buildModeChecks } from './mode.js';
import { buildRunnerChecks } from './runners.js';
import { buildContextChecks } from './context.js';
import { buildValidationChecks } from './validation.js';
import { buildRepoChecks } from './repo.js';
import { buildCostChecks } from './cost.js';
import { nowIso } from '../../../utils/format-time.js';
import type { Config } from '../../schemas/config.js';
import type { CliReadinessResult } from '../../schemas/readiness.js';
import type { ReadinessReport, ReadinessSection } from '../types.js';
import type { RunnerAvailabilityFact } from './availability.js';
import type { ConfigReadinessInput } from './config.js';
import type { PackageScriptsReadinessInput } from './validation.js';
import type { RepoReadinessInput } from './repo.js';

export interface BuildReadinessReportInput {
  projectDir: string;
  config?: Config | undefined;
  configLoad: ConfigReadinessInput;
  packageScripts: PackageScriptsReadinessInput;
  repo: RepoReadinessInput;
  cliReadiness?: readonly CliReadinessResult[] | undefined;
  availability?: readonly RunnerAvailabilityFact[] | undefined;
}

export function buildReadinessReport(input: BuildReadinessReportInput): ReadinessReport {
  const sections = buildSections(input);
  const checks = flattenReadinessChecks(sections);
  const counts = countReadinessChecks(checks);
  const status = aggregateReadinessStatus(counts);
  const nextAction = selectNextAction(checks, status);
  const mode = input.config ? resolveMode({ config: input.config }) : undefined;
  const approve =
    input.config && mode
      ? resolveApproveLevel({ mode, configApprove: input.config.workflow.approve })
      : undefined;

  return {
    generatedAt: nowIso(),
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
      checks: buildRunnerChecks(input.config, input.cliReadiness, input.availability),
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
