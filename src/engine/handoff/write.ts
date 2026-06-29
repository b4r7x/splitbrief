import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { confinedExists, confinedReadFileAsync } from '../../lib/confined-fs.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { Config } from '../../core/schemas/config.js';
import { taskId } from '../../core/schemas/task.js';
import { parsePersistedSession } from '../../core/sessions/summary-parser.js';
import { HandoffManifestSchema } from '../../core/schemas/handoff-manifest.js';
import { renderHandoffWithCustom } from './render.js';
import { buildManifest, writeManifest } from './manifest.js';
import { loadState } from '../../core/state/persistence.js';
import { readSpecFile, getDiptychVersion } from '../../core/paths-io.js';
import { loadConfig } from '../../core/config/load/io.js';
import { hashTaskBrief } from '../brief-hash.js';
import {
  DIPTYCH_DIR,
  SESSIONS_DIR,
  SPEC_FILE,
  PLAN_FILE,
  SUMMARY_FILE,
  SPECIFY_CONSTITUTION_FILE,
} from '../../core/paths.js';
import {
  assertPathConfined,
  assertWritablePathConfined,
  isPathConfined,
  pathConfinementError,
} from '../../lib/path-confinement.js';
import { getCurrentCommitSha } from '../../lib/git.js';
import { error, matches } from '../../utils/error.js';
import { resolveValidationDisplayCommand } from '../orchestrator/validation.js';
import type { DiscoveredValidation } from '../../core/schemas/workflow.js';

const isPathEscape = matches('path-confined-escape');

export const HANDOFF_WRITE_MODES = ['default', 'append', 'overwrite'] as const;
export type HandoffWriteMode = (typeof HANDOFF_WRITE_MODES)[number];

export type WriteHandoffOptions = {
  projectDir: string;
  sessionId: string;
  // String to support custom renderers alongside the built-in targets.
  target: string;
  outDir: string;
  selectedTaskIds?: string[];
  mode: HandoffWriteMode;
  allowCustomRenderer?: boolean;
};

export type WriteHandoffResult = {
  outputDir: string;
  files: string[];
};

export const handoffWriteError = {
  stateNotFound: (sessionId: string) =>
    error('handoff-state-not-found', `no state found for session: ${sessionId}`, { sessionId }),
  unknownTaskId: (id: string) => error('handoff-unknown-task-id', `unknown task id: ${id}`, { id }),
  outputDirectoryExists: (outDir: string) =>
    error(
      'handoff-output-directory-exists',
      `output directory already exists: ${outDir}. Use --mode append or --mode overwrite.`,
      { outDir },
    ),
  unsafeOverwriteTarget: (outDir: string) =>
    error(
      'handoff-unsafe-overwrite-target',
      `refusing to overwrite "${outDir}": directory is not a recognized handoff output. ` +
        `Overwrite is only allowed for directories inside ${DIPTYCH_DIR}/ or containing a manifest.json from a previous handoff.`,
      { outDir },
    ),
  isUnsafeOverwriteTarget: matches('handoff-unsafe-overwrite-target'),
  appendBriefHashMismatch: (outDir: string, existingHash: string, currentHash: string) =>
    error(
      'handoff-append-brief-hash-mismatch',
      `refusing to append to "${outDir}": existing pack describes a different Task Brief ` +
        `(manifest briefHash ${existingHash} ≠ current ${currentHash}). ` +
        'Use --mode overwrite to replace the pack.',
      { outDir, existingHash, currentHash },
    ),
  isAppendBriefHashMismatch: matches('handoff-append-brief-hash-mismatch'),
} as const;

function isInsideDiptychDir(outDir: string, projectDir: string): boolean {
  const absDiptych = resolve(join(projectDir, DIPTYCH_DIR));
  return isPathConfined(relative(absDiptych, resolve(outDir)), absDiptych);
}

function isPreviousHandoffOutput(outDir: string): boolean {
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return typeof raw === 'object' && raw !== null && typeof raw.diptychVersion === 'string';
  } catch {
    return false;
  }
}

function assertSafeOverwriteTarget(outDir: string, projectDir: string): void {
  if (isInsideDiptychDir(outDir, projectDir)) return;
  if (isPreviousHandoffOutput(outDir)) return;
  throw handoffWriteError.unsafeOverwriteTarget(outDir);
}

function readExistingManifestBriefHash(outDir: string): string | undefined {
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const result = HandoffManifestSchema.safeParse(parsed);
    return result.success ? result.data.briefHash : undefined;
  } catch {
    return undefined;
  }
}

function resolveHandoffValidation(
  config: Config,
  discovered: DiscoveredValidation | undefined,
  projectDir: string,
): { typecheck?: string; lint?: string; test?: string } {
  const result: { typecheck?: string; lint?: string; test?: string } = {};
  if (config.validation.typecheck) {
    const cmd = resolveValidationDisplayCommand('typecheckCommand', config, discovered, projectDir);
    if (cmd) result.typecheck = cmd;
  }
  if (config.validation.lint) {
    const cmd = resolveValidationDisplayCommand('lintCommand', config, discovered, projectDir);
    if (cmd) result.lint = cmd;
  }
  if (config.validation.test) {
    const cmd = resolveValidationDisplayCommand('testCommand', config, discovered, projectDir);
    if (cmd) result.test = cmd;
  }
  return result;
}

export async function writeHandoffPack(options: WriteHandoffOptions): Promise<WriteHandoffResult> {
  const { projectDir, sessionId, target, outDir, selectedTaskIds, mode } = options;

  const state = loadState({ projectDir, sessionId });
  if (!state) {
    throw handoffWriteError.stateNotFound(sessionId);
  }

  const specContent = readSpecFile({ projectDir, sessionId }, SPEC_FILE) ?? undefined;
  const planContent = readSpecFile({ projectDir, sessionId }, PLAN_FILE) ?? undefined;

  let loadedConfig: Config | undefined;
  try {
    loadedConfig = loadConfig(projectDir).config;
  } catch {
    // config absent or invalid — use empty validation and untrusted renderers
  }

  const validation = loadedConfig
    ? resolveHandoffValidation(loadedConfig, state.discoveredValidation, projectDir)
    : {};
  const configMode: WorkflowMode | undefined = loadedConfig?.workflow.mode;

  let summaryMode: WorkflowMode | undefined;
  try {
    const summaryRelativePath = join(DIPTYCH_DIR, SESSIONS_DIR, sessionId, SUMMARY_FILE);
    if (confinedExists(projectDir, summaryRelativePath)) {
      const raw = await confinedReadFileAsync(projectDir, summaryRelativePath);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        const result = parsePersistedSession(parsed);
        if (result.status === 'ok') {
          summaryMode = result.session.summary?.mode;
        }
      }
    }
  } catch {
    // malformed or missing summary.json — fall through to config/default
  }

  const resolvedMode: WorkflowMode = summaryMode ?? configMode ?? 'standard';

  let constitutionContent: string | undefined;
  if (confinedExists(projectDir, SPECIFY_CONSTITUTION_FILE)) {
    try {
      constitutionContent =
        (await confinedReadFileAsync(projectDir, SPECIFY_CONSTITUTION_FILE)) ?? undefined;
    } catch (err) {
      if (!pathConfinementError.isSymlinkRead(err) && !isPathEscape(err)) throw err;
    }
  }

  const brandedTaskIds = selectedTaskIds?.map(taskId);
  const filteredTasks = brandedTaskIds
    ? brandedTaskIds.map((id) => {
        const task = state.tasks.find((t) => t.id === id);
        if (!task) throw handoffWriteError.unknownTaskId(id);
        return task;
      })
    : state.tasks;

  const briefHash = hashTaskBrief(filteredTasks);

  let trustCustomRenderers = options.allowCustomRenderer ?? false;
  if (!trustCustomRenderers) {
    trustCustomRenderers = loadedConfig?.trust?.customRenderers ?? false;
  }

  const pack = await renderHandoffWithCustom(
    {
      target,
      sessionId,
      feature: state.feature,
      mode: resolvedMode,
      tasks: filteredTasks,
      ...(specContent !== undefined && { spec: specContent }),
      ...(planContent !== undefined && { plan: planContent }),
      ...(constitutionContent !== undefined && { constitution: constitutionContent }),
      validation,
    },
    projectDir,
    { trustCustomRenderers },
  );

  if (mode === 'default' && existsSync(outDir)) {
    throw handoffWriteError.outputDirectoryExists(outDir);
  }

  if (mode === 'append' && existsSync(outDir)) {
    const existingHash = readExistingManifestBriefHash(outDir);
    if (existingHash !== undefined && existingHash !== briefHash) {
      throw handoffWriteError.appendBriefHashMismatch(outDir, existingHash, briefHash);
    }
  }

  if (mode === 'overwrite' && existsSync(outDir)) {
    assertSafeOverwriteTarget(outDir, projectDir);
    const resolvedOut = realpathSync(outDir);
    const resolvedProject = realpathSync(projectDir);
    if (!resolvedOut.startsWith(resolvedProject + '/') && resolvedOut !== resolvedProject) {
      throw pathConfinementError.escapesRoot(relative(projectDir, outDir));
    }
    await rm(outDir, { recursive: true, force: true });
  }

  await mkdir(outDir, { recursive: true, mode: 0o700 });

  const writtenFiles: string[] = [];

  for (const file of pack.files) {
    assertPathConfined(file.path, outDir);

    const filePath = join(outDir, file.path);
    const fileDir = join(filePath, '..');
    await mkdir(fileDir, { recursive: true, mode: 0o700 });

    if (mode === 'append' && existsSync(filePath)) {
      continue;
    }

    const content = file.path.startsWith('tasks/')
      ? file.content.replace('<placeholder>', briefHash)
      : file.content;

    // Realpath-aware confinement: a renderer-supplied path whose parent resolves
    // through a symlink must not let the write escape the output directory.
    assertWritablePathConfined(file.path, outDir);
    await writeFile(filePath, content, { mode: SECURE_FILE_MODE });
    writtenFiles.push(relative(outDir, filePath));
  }

  const manifestPackFiles = pack.files
    .map((file) => file.path)
    .filter((path) => existsSync(join(outDir, path)));

  const sourceCommit = await tryReadGitHead(projectDir);
  const manifest = buildManifest({
    sessionId,
    diptychVersion: getDiptychVersion(),
    target,
    mode: resolvedMode,
    tasks: filteredTasks,
    packFiles: manifestPackFiles,
    spec: specContent ?? null,
    plan: planContent ?? null,
    constitution: constitutionContent ?? null,
    validation,
    ...(sourceCommit !== undefined && { sourceCommit }),
  });
  writeManifest(outDir, manifest);

  return { outputDir: outDir, files: writtenFiles };
}

async function tryReadGitHead(projectDir: string): Promise<string | undefined> {
  try {
    return await getCurrentCommitSha(projectDir);
  } catch {
    return undefined;
  }
}
