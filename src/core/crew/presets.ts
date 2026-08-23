import { resolveImplementerProfiles } from '../config/accessors/implementer-profiles.js';
import { resolveReviewerRunner } from '../config/accessors/reviewer-runner.js';
import type { CliToolId } from '../runners/cli-tool-catalog.js';
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

function presetReviewerSeat(
  config: Config,
  preset: CrewPresetDeclaration,
): ReviewerConfig | undefined {
  if (preset.review === preset.plan) return undefined;
  const reviewer = resolveReviewerRunner(config).runner;
  return reviewer.kind === 'cli' && reviewer.tool === preset.review
    ? reviewer
    : { kind: 'cli', tool: preset.review };
}

function presetSeats(config: Config, preset: CrewPresetDeclaration): CrewPresetSeats {
  const implementer = resolveImplementerProfiles(config).defaultProfile.config;
  const reviewer = presetReviewerSeat(config, preset);
  return {
    planner:
      config.planner.kind === 'cli' && config.planner.tool === preset.plan
        ? config.planner
        : { kind: 'cli', tool: preset.plan },
    implementer:
      implementer.kind === 'cli' && implementer.tool === preset.build
        ? implementer
        : { kind: 'cli', tool: preset.build },
    ...(reviewer === undefined ? {} : { reviewer }),
  };
}

export function computeCrewPresets(
  input: Readonly<{ config: Config; readyTools: readonly CliToolId[] }>,
): readonly CrewPreset[] {
  const ready = new Set<CliToolId>(input.readyTools);

  return CREW_PRESET_DECLARATIONS.filter(
    (preset) => ready.has(preset.plan) && ready.has(preset.build) && ready.has(preset.review),
  ).map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    seats: presetSeats(input.config, preset),
  }));
}
