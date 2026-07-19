import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import { getDiptychVersion } from '../src/core/paths-io.js';
import { getCurrentCommitSha } from '../src/lib/git.js';
import {
  listVisualScenarios,
  REQUIRED_VIEWPORTS,
  VISUAL_CATALOG_VERSION,
} from '../testing/visual/catalog.js';
import {
  formatViewport,
  parseViewport,
  type Viewport,
} from '../testing/visual/contracts/geometry.js';
import {
  CaptureSelectionSchema,
  type CaptureSelection,
} from '../testing/visual/contracts/selection.js';
import { DEFAULT_VISUAL_OUTPUT_ROOT } from '../testing/visual/artifacts/paths.js';
import { captureGallery } from '../testing/visual/gallery/capture.js';

const CliOptionsSchema = z
  .object({
    scenario: z.array(z.string()),
    viewport: z.array(z.string()),
    element: z.array(z.string()),
    output: z.string().min(1),
    list: z.boolean(),
  })
  .strict();

interface CliOptions extends z.infer<typeof CliOptionsSchema> {}

export interface TuiShotsIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface TuiShotsCaptureOptions {
  readonly outputRoot: string;
  readonly projectRoot: string;
  readonly toolVersion: string;
  readonly gitRevision: string | null;
  readonly selection: CaptureSelection;
}

export interface TuiShotsCaptureResult {
  readonly runRoot: string;
  readonly manifestPath: string;
  readonly artifactCount: number;
  readonly warningCount: number;
  readonly failureCount: number;
}

export interface TuiShotsDependencies {
  readonly cwd?: string | undefined;
  readonly io?: TuiShotsIo | undefined;
  readonly capture?:
    | ((options: TuiShotsCaptureOptions) => Promise<TuiShotsCaptureResult>)
    | undefined;
  readonly toolVersion?: string | undefined;
  readonly gitRevision?: (() => Promise<string | null>) | undefined;
}

interface CaptureRequest {
  readonly outputRoot: string;
  readonly selection: CaptureSelection;
}

const processIo: TuiShotsIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runTuiShots(
  args: readonly string[] = process.argv.slice(2),
  dependencies: TuiShotsDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? processIo;
  try {
    const options = parseArguments(args, io);
    if (options === null) return 0;
    if (options.list) {
      printCatalog(io);
      return 0;
    }

    const cwd = resolve(dependencies.cwd ?? process.cwd());
    const request = await createCaptureRequest(options, cwd);
    const capture = dependencies.capture ?? captureWithGallery;
    const result = await capture({
      outputRoot: request.outputRoot,
      projectRoot: cwd,
      toolVersion: dependencies.toolVersion ?? getDiptychVersion(),
      gitRevision: await (dependencies.gitRevision ?? (() => readGitRevision(cwd)))(),
      selection: request.selection,
    });
    printSummary({ io, cwd, selection: request.selection, result });
    return result.failureCount === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    io.stderr(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

function parseArguments(args: readonly string[], io: TuiShotsIo): CliOptions | null {
  const collect = (value: string, previous: string[]): string[] => [...previous, value];
  const program = new Command()
    .name('tui-shots')
    .description('Capture deterministic visual artifacts from the production diptych TUI')
    .option('-s, --scenario <id>', 'scenario ID to capture (repeatable)', collect, [])
    .option(
      '-v, --viewport <cols>x<rows>',
      'terminal viewport to capture (repeatable)',
      collect,
      [],
    )
    .option('-e, --element <id>', 'named semantic crop to include (repeatable)', collect, [])
    .option(
      '-o, --output <path>',
      'artifact root beneath .test-artifacts/ui',
      DEFAULT_VISUAL_OUTPUT_ROOT,
    )
    .option('--list', 'list catalog scenarios without mounting the TUI', false)
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  npm run tui-shots -- --list',
        '  npm run tui-shots -- --scenario home-empty --viewport 80x24 --element header',
        '  npm run tui-shots -- --scenario home-empty --output .test-artifacts/ui/home',
      ].join('\n'),
    )
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  try {
    program.parse([...args], { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError && error.code === 'commander.helpDisplayed') return null;
    throw error;
  }
  return CliOptionsSchema.parse(program.opts());
}

async function createCaptureRequest(options: CliOptions, cwd: string): Promise<CaptureRequest> {
  const scenarios = selectScenarios(options.scenario);
  const viewports = selectViewports(options.viewport);
  validateSupportedViewports(scenarios, viewports);
  validateElements(scenarios, options.element);
  const outputRoot = await resolveOutputRoot({ cwd, value: options.output });

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

async function resolveOutputRoot(options: {
  readonly cwd: string;
  readonly value: string;
}): Promise<string> {
  if (options.value.trim().length === 0 || options.value.includes('\0')) {
    throw new Error('Output root must be a non-empty path beneath .test-artifacts/ui.');
  }
  const allowedRoot = resolve(options.cwd, DEFAULT_VISUAL_OUTPUT_ROOT);
  const outputRoot = resolve(options.cwd, options.value);
  const fromAllowedRoot = relative(allowedRoot, outputRoot);
  if (
    fromAllowedRoot.startsWith(`..${sep}`) ||
    fromAllowedRoot === '..' ||
    isAbsolute(fromAllowedRoot)
  ) {
    throw new Error('Output root must remain beneath .test-artifacts/ui.');
  }
  await assertNoSymlinkComponents({ cwd: options.cwd, outputRoot });
  return outputRoot;
}

async function assertNoSymlinkComponents(options: {
  readonly cwd: string;
  readonly outputRoot: string;
}): Promise<void> {
  const pathFromCwd = relative(options.cwd, options.outputRoot);
  let current = options.cwd;
  for (const segment of pathFromCwd.split(sep)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error('Output root cannot contain symbolic links.');
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

function printCatalog(io: TuiShotsIo): void {
  io.stdout(`visual catalog v${VISUAL_CATALOG_VERSION}\n`);
  for (const scenario of listVisualScenarios()) {
    io.stdout(
      `${scenario.id}\t${scenario.title}\tviewports=${scenario.viewports.map(formatViewport).join(',')}\telements=${scenario.elements.map((element) => element.id).join(',')}\n`,
    );
  }
}

function printSummary(options: {
  readonly io: TuiShotsIo;
  readonly cwd: string;
  readonly selection: CaptureSelection;
  readonly result: TuiShotsCaptureResult;
}): void {
  const requestedArtifacts = options.selection.targets.reduce(
    (count, target) => count + 1 + target.elementIds.length,
    0,
  );
  options.io.stdout(
    [
      options.result.failureCount === 0 ? 'tui-shots: complete' : 'tui-shots: failed',
      `output: ${displayPath(options.cwd, options.result.runRoot)}`,
      `manifest: ${displayPath(options.cwd, options.result.manifestPath)}`,
      `captures: ${options.selection.targets.length}`,
      `artifacts: ${options.result.artifactCount}/${requestedArtifacts}`,
      `warnings: ${options.result.warningCount}`,
      `failures: ${options.result.failureCount}`,
      '',
    ].join('\n'),
  );
}

async function captureWithGallery(options: TuiShotsCaptureOptions): Promise<TuiShotsCaptureResult> {
  const publication = await captureGallery(options);
  return {
    runRoot: publication.runRoot,
    manifestPath: publication.manifestPath,
    artifactCount: publication.manifest.artifacts.length,
    warningCount: publication.manifest.warnings.length,
    failureCount: publication.manifest.failures.length,
  };
}

async function readGitRevision(cwd: string): Promise<string | null> {
  try {
    return await getCurrentCommitSha(cwd);
  } catch {
    return null;
  }
}

function displayPath(cwd: string, path: string): string {
  const value = relative(cwd, path);
  return value.length === 0 ? '.' : value.split(sep).join('/');
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  process.exitCode = await runTuiShots();
}
