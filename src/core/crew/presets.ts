import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import type { CliToolId } from '../runners/cli-tool-catalog.js';
import { detectedSeatReady, type CrewDetection } from './default.js';
import type { Config } from '../schemas/config.js';
import type { ImplementerCliToolId, PlannerCliToolId } from '../schemas/enums.js';
import type { ImplementerConfig } from '../schemas/implementer-config.js';
import type { PlannerConfig } from '../schemas/planner-config.js';
import type { ReviewerConfig } from '../schemas/reviewer-config.js';

export type CrewPresetSeats = Readonly<{
  planner: PlannerConfig;
  implementer: ImplementerConfig;
  reviewer?: ReviewerConfig;
}>;

export type CrewPreset = Readonly<{
  id: string;
  label: string;
  description: string;
  seats: CrewPresetSeats;
  /** The preset's tools whose seat is not ready (not installed, or not signed in for its route), in seat order. */
  notReady: readonly CliToolId[];
}>;

type CrewPresetDeclaration = Readonly<{
  id: string;
  label: string;
  description: string;
  plan: PlannerCliToolId;
  build: ImplementerCliToolId;
  review: PlannerCliToolId;
}>;

const CREW_PRESET_DECLARATIONS: readonly CrewPresetDeclaration[] = Object.freeze([
  {
    id: 'claude-crew-codex-review',
    label: 'Claude crew, Codex review',
    description: 'Claude Code plans and builds; Codex reviews the diff from another lab.',
    plan: 'claude-code',
    build: 'claude-code',
    review: 'codex',
  },
  {
    id: 'codex-crew-claude-review',
    label: 'Codex crew, Claude review',
    description: 'Codex plans and builds; Claude Code reviews the diff from another lab.',
    plan: 'codex',
    build: 'codex',
    review: 'claude-code',
  },
  {
    id: 'claude-plan-opencode-build',
    label: 'Claude plan, OpenCode build',
    description: 'Claude Code plans and reviews; OpenCode executes the briefs.',
    plan: 'claude-code',
    build: 'opencode',
    review: 'claude-code',
  },
]);

/**
 * The configured seat when it already runs the preset's tool (`kept`), else a seat the preset makes
 * for that tool. An inherited review seat is the plan seat.
 */
function presetSeats(
  config: Config,
  preset: CrewPresetDeclaration,
): Readonly<{
  seats: CrewPresetSeats;
  kept: Readonly<Record<'plan' | 'build' | 'review', boolean>>;
}> {
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const reviewer = preset.review === preset.plan ? undefined : resolveReviewerRunner(config).runner;
  const keepsPlan = config.planner.kind === 'cli' && config.planner.tool === preset.plan;
  const keepsBuild = implementer.kind === 'cli' && implementer.tool === preset.build;
  const keepsReview = reviewer?.kind === 'cli' && reviewer.tool === preset.review;
  return {
    seats: {
      planner: keepsPlan ? config.planner : { kind: 'cli', tool: preset.plan },
      implementer: keepsBuild ? implementer : { kind: 'cli', tool: preset.build },
      ...(reviewer === undefined
        ? {}
        : { reviewer: keepsReview ? reviewer : { kind: 'cli', tool: preset.review } }),
    },
    kept: {
      plan: keepsPlan,
      build: keepsBuild,
      review: reviewer === undefined ? keepsPlan : keepsReview,
    },
  };
}

export function computeCrewPresets(
  input: Readonly<{ config: Config; detection: CrewDetection }>,
): readonly CrewPreset[] {
  // A seat the preset makes names no model, and a tool that stores no credential is safe only on a
  // route its model list serves, so only a ready tool fills it.
  const toolReady = (tool: CliToolId) =>
    input.detection.cliTools.some(
      (detection) => detection.tool === tool && detection.diagnostic.state === 'ready',
    );
  return CREW_PRESET_DECLARATIONS.map((preset) => {
    const { seats, kept } = presetSeats(input.config, preset);
    const runners = [
      [preset.plan, seats.planner, kept.plan],
      [preset.build, seats.implementer, kept.build],
      [preset.review, seats.reviewer ?? seats.planner, kept.review],
    ] as const;
    return {
      id: preset.id,
      label: preset.label,
      description: preset.description,
      seats,
      notReady: [
        ...new Set(
          runners
            .filter(([tool, runner, isKept]) =>
              isKept ? !detectedSeatReady(runner, input.detection) : !toolReady(tool),
            )
            .map(([tool]) => tool),
        ),
      ],
    };
  });
}
