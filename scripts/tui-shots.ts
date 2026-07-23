import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import { getDiptychVersion } from '../src/core/paths-io.js';
import { getCurrentCommitSha } from '../src/lib/git/refs.js';
import { listVisualScenarios, VISUAL_CATALOG_VERSION } from '../testing/visual/catalog.js';
import { formatViewport } from '../testing/visual/contracts/geometry.js';
import type { CaptureSelection } from '../testing/visual/contracts/selection.js';
import { DEFAULT_VISUAL_OUTPUT_ROOT } from '../testing/visual/artifacts/layout.js';
import { captureGallery } from '../testing/visual/gallery/capture.js';
import { resolveOutputRoot } from './tui-shots/output-root.js';
import { createCaptureRequest } from './tui-shots/selection.js';

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
    const request = await createCaptureRequest(options, (value) =>
      resolveOutputRoot({ cwd, value }),
    );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  process.exitCode = await runTuiShots();
}
