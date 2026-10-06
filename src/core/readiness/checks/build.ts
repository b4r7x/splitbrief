import { resolveApproveLevel } from '../../config/runtime/resolve.js';
import {
  aggregateReadinessStatus,
  countReadinessChecks,
  flattenReadinessChecks,
  selectNextAction,
} from '../status.js';
import { buildConfigChecks } from './config.js';
import { buildPlanApprovalChecks } from './plan-approval.js';
import { buildRunnerChecks } from './runners.js';
import { buildContextChecks } from './context.js';
import { buildValidationChecks } from './validation.js';
import { buildRepoChecks } from './repo.js';
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
  /** How the run the report describes starts; a headless one approves its plan card unattended. */
  interaction?: 'interactive' | 'headless' | undefined;
}

export function buildReadinessReport(input: BuildReadinessReportInput): ReadinessReport {
  const sections = buildSections(input);
  const checks = flattenReadinessChecks(sections);
  const counts = countReadinessChecks(checks);
  const status = aggregateReadinessStatus(counts);
  const nextAction = selectNextAction(checks, status);
  const approve = input.config ? resolveApproveLevel(input.config) : undefined;

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
      id: 'workflow',
      title: 'Workflow',
      checks: buildPlanApprovalChecks(input.config, input.interaction),
    },
    {
      id: 'runners',
      title: 'Runners',
      checks: buildRunnerChecks(
        input.config,
        input.cliReadiness,
        input.availability,
        input.interaction,
      ),
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
  );

  return sections;
}
