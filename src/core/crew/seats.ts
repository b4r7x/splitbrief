import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import {
  getRunnerCatalogDisplayName,
  getRunnerModelName,
  type RunnerConfig,
} from '../config/accessors/runner-config.js';
import { getApiProviderDescriptor } from '../providers/api-provider-catalog.js';
import { runnerBillingPosture, type RunnerBillingPosture } from '../runners/runner-billing.js';
import type { Config } from '../schemas/config.js';

export type CrewSeatId = 'plan' | 'build' | 'review';

export type CrewSeatRunner = Readonly<{
  runner: RunnerConfig;
  displayName: string;
  model?: string | undefined;
  posture: RunnerBillingPosture;
}>;

export type CrewEscalateEntry = Readonly<{
  label: string;
  displayName: string;
  model: string;
  posture: RunnerBillingPosture;
}>;

export type CrewSeat =
  | (CrewSeatRunner & Readonly<{ id: 'plan'; label: string }>)
  | (CrewSeatRunner &
      Readonly<{ id: 'build'; label: string; escalate?: CrewEscalateEntry | undefined }>)
  | (CrewSeatRunner & Readonly<{ id: 'review'; label: string; source: 'configured' | 'planner' }>);

function seatRunner(runner: RunnerConfig): CrewSeatRunner {
  const model = getRunnerModelName(runner);
  return {
    runner,
    displayName: getRunnerCatalogDisplayName(runner),
    ...(model !== undefined && { model }),
    posture: runnerBillingPosture(runner),
  };
}

function escalateEntry(config: Config): CrewEscalateEntry | undefined {
  const escalation = config.escalation;
  if (escalation?.enabled === false) return undefined;

  const provider = escalation?.intermediateProvider;
  const model = escalation?.intermediateModel;
  if (provider === undefined || model === undefined) return undefined;

  const descriptor = getApiProviderDescriptor(provider);
  return {
    label: 'escalate',
    displayName: descriptor?.displayName ?? provider,
    model,
    posture: descriptor?.billing ?? 'unknown',
  };
}

export function deriveCrewSeats(input: Readonly<{ config: Config }>): readonly CrewSeat[] {
  const config = input.config;
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const reviewer = resolveReviewerRunner(config);
  const escalate = escalateEntry(config);

  return [
    { id: 'plan', label: 'PLAN', ...seatRunner(config.planner) },
    {
      id: 'build',
      label: 'BUILD',
      ...seatRunner(implementer),
      ...(escalate !== undefined && { escalate }),
    },
    { id: 'review', label: 'REVIEW', source: reviewer.source, ...seatRunner(reviewer.runner) },
  ];
}
