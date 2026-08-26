import { SIDEBAR_BREAKPOINT_COLS } from '../../src/features/workflow/layout/rect.js';
import { BRIEF_RECOVERY_VIEWPORTS, findVisualScenario, listVisualScenarios } from './catalog.js';
import type { CheckpointDefinition, ScenarioDefinition } from './contracts/catalog.js';
import { FrameArtifactIdentitySchema, frameArtifactKey } from './contracts/artifact-identity.js';
import type { CellGrid } from './contracts/cells.js';
import type { CellRect, Viewport } from './contracts/geometry.js';
import type { TerminalProfile } from './contracts/manifest-fields.js';
import { ArtifactProvenanceSchema } from './contracts/selection.js';
import { tryResolveElementLocator } from './locators/resolve.js';
import type { ResolvedElementLocator } from './locators/types.js';
import { parseTerminalFrame } from './terminal/parse.js';

export const RECOVERY_SCENARIO_IDS: readonly string[] = listVisualScenarios()
  .filter((scenario) => scenario.id.startsWith('workflow-brief-recovery-'))
  .map((scenario) => scenario.id);

if (RECOVERY_SCENARIO_IDS.length === 0) {
  throw new Error('No workflow-brief-recovery scenarios in the visual catalog');
}

export const RECOVERY_BOUNDARY_VIEWPORTS: readonly Viewport[] = BRIEF_RECOVERY_VIEWPORTS.filter(
  (candidate) => Math.abs(candidate.cols - SIDEBAR_BREAKPOINT_COLS) <= 1,
);

if (RECOVERY_BOUNDARY_VIEWPORTS.length === 0) {
  throw new Error(
    `No recovery viewport straddles SIDEBAR_BREAKPOINT_COLS (${SIDEBAR_BREAKPOINT_COLS})`,
  );
}

const RECOVERY_PROFILE_BY_COLS: ReadonlyMap<number, TerminalProfile> = new Map([
  [121, 'unicode-color'],
  [120, 'unicode-mono'],
  [119, 'ascii-mono'],
  [80, 'unicode-color'],
  [50, 'unicode-mono'],
  [40, 'ascii-mono'],
]);

const RECOVERY_ROLE_ELEMENTS = [
  ['public-status', 'recovery-public-status'],
  ['status', 'recovery-status'],
  ['evidence', 'recovery-evidence'],
  ['cause', 'recovery-cause'],
  ['actions', 'recovery-actions'],
  ['input', 'recovery-composer'],
  ['body', 'recovery-body'],
  ['sidebar', 'recovery-sidebar'],
] as const satisfies readonly (readonly [string, string])[];

export type RecoveryLocatorRole = (typeof RECOVERY_ROLE_ELEMENTS)[number][0];

type RecoveryElement = ScenarioDefinition['elements'][number];

export function recoveryProfileForColumns(columns: number): TerminalProfile {
  const profile = RECOVERY_PROFILE_BY_COLS.get(columns);
  if (profile === undefined) throw new Error(`Missing recovery profile for ${columns} columns`);
  return profile;
}

export function requireScenario(id: string): ScenarioDefinition {
  const scenario = findVisualScenario(id);
  if (scenario === undefined) throw new Error(`Missing visual scenario ${id}`);
  return scenario;
}

export function requireCheckpoint(scenario: ScenarioDefinition): CheckpointDefinition {
  const checkpoint = scenario.checkpoints[0];
  if (checkpoint === undefined) throw new Error(`Missing checkpoint for ${scenario.id}`);
  return checkpoint;
}

export function recoveryRoleElements(
  scenario: ScenarioDefinition,
): ReadonlyMap<RecoveryLocatorRole, RecoveryElement> {
  const roles = new Map<RecoveryLocatorRole, RecoveryElement>();
  for (const [role, elementId] of RECOVERY_ROLE_ELEMENTS) {
    const element = scenario.elements.find((candidate) => candidate.id === elementId);
    if (element === undefined) {
      throw new Error(`Missing ${role} element ${elementId} in ${scenario.id}`);
    }
    roles.set(role, element);
  }
  return roles;
}

export function roleElement(
  roles: ReadonlyMap<RecoveryLocatorRole, RecoveryElement>,
  role: RecoveryLocatorRole,
): RecoveryElement {
  const element = roles.get(role);
  if (element === undefined) throw new Error(`Missing ${role} recovery element`);
  return element;
}

export function resolveRole(options: {
  readonly scenario: ScenarioDefinition;
  readonly checkpoint: CheckpointDefinition;
  readonly grid: CellGrid;
  readonly element: RecoveryElement;
}): ResolvedElementLocator {
  const result = tryResolveElementLocator({
    scenario: options.scenario,
    checkpoint: options.checkpoint,
    grid: options.grid,
    elementId: options.element.id,
  });
  if (!result.ok) {
    throw new Error(`${options.scenario.id}/${options.element.id}: ${result.failure.message}`);
  }
  return result.locator;
}

export function roleLocator(
  locators: ReadonlyMap<RecoveryLocatorRole, ResolvedElementLocator>,
  role: RecoveryLocatorRole,
): ResolvedElementLocator {
  const locator = locators.get(role);
  if (locator === undefined) throw new Error(`Missing resolved ${role} locator`);
  return locator;
}

export function textInRect(grid: CellGrid, rect: CellRect): string {
  return grid.cells
    .slice(rect.y, rect.y + rect.height)
    .map((row) =>
      row
        .slice(rect.x, rect.x + rect.width)
        .map((cell) => cell.grapheme)
        .join(''),
    )
    .join('\n');
}

export async function createFrameGrid(
  scenario: ScenarioDefinition,
  frameViewport: Viewport,
  ansi: string,
): Promise<CellGrid> {
  const checkpoint = requireCheckpoint(scenario);
  const provenance = ArtifactProvenanceSchema.parse({
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    fixtureVersion: scenario.fixtureVersion,
    checkpointId: checkpoint.id,
    viewport: frameViewport,
  });
  const identity = FrameArtifactIdentitySchema.parse({
    kind: 'frame',
    key: frameArtifactKey(provenance),
    provenance,
    elementId: null,
    parentFrameKey: null,
  });
  return parseTerminalFrame({ ansi, identity, projectRoot: process.cwd() });
}
