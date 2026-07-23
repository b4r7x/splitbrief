import { listVisualScenarios, REQUIRED_VIEWPORTS } from '../../testing/visual/catalog.js';
import {
  formatViewport,
  parseViewport,
  type Viewport,
} from '../../testing/visual/contracts/geometry.js';
import {
  CaptureSelectionSchema,
  type CaptureSelection,
} from '../../testing/visual/contracts/selection.js';

export interface CaptureRequest {
  readonly outputRoot: string;
  readonly selection: CaptureSelection;
}

export interface CaptureCliOptions {
  readonly scenario: readonly string[];
  readonly viewport: readonly string[];
  readonly element: readonly string[];
  readonly output: string;
}

export async function createCaptureRequest(
  options: CaptureCliOptions,
  resolveOutput: (value: string) => Promise<string>,
): Promise<CaptureRequest> {
  const scenarios = selectScenarios(options.scenario);
  const viewports = selectViewports(options.viewport);
  validateSupportedViewports(scenarios, viewports);
  validateElements(scenarios, options.element);
  const outputRoot = await resolveOutput(options.output);

  const entries = scenarios.flatMap((scenario) =>
    scenario.checkpoints.flatMap((checkpoint) =>
      viewports.map((viewport) => ({
        provenance: {
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          fixtureVersion: scenario.fixtureVersion,
          checkpointId: checkpoint.id,
          viewport,
        },
        elementIds: scenario.elements
          .filter((element) => options.element.length === 0 || options.element.includes(element.id))
          .map((element) => element.id),
      })),
    ),
  );
  const selection = CaptureSelectionSchema.parse({ requests: entries, targets: entries });
  return { outputRoot, selection };
}

function selectScenarios(requested: readonly string[]) {
  const unique = new Set(requested);
  const catalog = listVisualScenarios();
  for (const id of unique) {
    if (!catalog.some((scenario) => scenario.id === id)) {
      throw new Error(`Unknown scenario "${id}". Run with --list to see available IDs.`);
    }
  }
  return requested.length === 0 ? catalog : catalog.filter((scenario) => unique.has(scenario.id));
}

function selectViewports(requested: readonly string[]): readonly Viewport[] {
  if (requested.length === 0) return REQUIRED_VIEWPORTS;
  const parsed = new Map<string, Viewport>();
  for (const value of requested) {
    let viewport: Viewport;
    try {
      viewport = parseViewport(value);
    } catch {
      throw new Error(`Invalid viewport "${value}". Expected COLSxROWS, for example 80x24.`);
    }
    if (
      !REQUIRED_VIEWPORTS.some(
        (candidate) => formatViewport(candidate) === formatViewport(viewport),
      )
    ) {
      throw new Error(
        `Unsupported viewport "${value}". Available viewports: ${REQUIRED_VIEWPORTS.map(formatViewport).join(', ')}.`,
      );
    }
    parsed.set(formatViewport(viewport), viewport);
  }
  return REQUIRED_VIEWPORTS.filter((viewport) => parsed.has(formatViewport(viewport)));
}

function validateSupportedViewports(
  scenarios: ReturnType<typeof listVisualScenarios>,
  viewports: readonly Viewport[],
): void {
  for (const scenario of scenarios) {
    for (const viewport of viewports) {
      const supported = scenario.viewports.some(
        (candidate) => candidate.cols === viewport.cols && candidate.rows === viewport.rows,
      );
      if (!supported) {
        throw new Error(
          `Scenario ${scenario.id} does not support viewport ${formatViewport(viewport)}.`,
        );
      }
    }
  }
}

function validateElements(
  scenarios: ReturnType<typeof listVisualScenarios>,
  requested: readonly string[],
): void {
  for (const id of new Set(requested)) {
    const missingFrom = scenarios.find(
      (scenario) => !scenario.elements.some((element) => element.id === id),
    );
    if (missingFrom !== undefined) {
      throw new Error(`Element "${id}" is not declared by scenario ${missingFrom.id}.`);
    }
  }
}
