import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import type { HandoffTarget } from '../../core/handoff/targets.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { taskId } from '../../core/schemas/task.js';
import { SessionSchema } from '../../core/schemas/session.js';
import { renderHandoffWithCustom } from './render.js';
import { buildManifest, writeManifest } from './manifest.js';
import { loadState } from '../../core/state/persistence.js';
import { readSpecFile, getDiptychVersion } from '../../core/paths-io.js';
import { loadConfig } from '../../core/config/load/load.js';
import { hashTaskBrief } from '../../core/brief-hash.js';
import { SPEC_FILE, PLAN_FILE, sessionDir } from '../../core/paths.js';
import { assertPathConfined } from '../../lib/path-confinement.js';
import { error } from '../../utils/error.js';

export type WriteHandoffOptions = {
  projectDir: string;
  sessionId: string;
  // Widened to string to support custom renderers alongside built-in HandoffTarget values
  target: HandoffTarget | string;
  outDir: string;
  selectedTaskIds?: string[];
  mode: 'default' | 'append' | 'overwrite';
};

export type WriteHandoffResult = {
  outputDir: string;
  files: string[];
};

export const handoffWriteError = {
  stateNotFound: (sessionId: string) => error('handoff-state-not-found', `no state found for session: ${sessionId}`, { sessionId }),
  unknownTaskId: (id: string) => error('handoff-unknown-task-id', `unknown task id: ${id}`, { id }),
  outputDirectoryExists: (outDir: string) =>
    error(
      'handoff-output-directory-exists',
      `output directory already exists: ${outDir}. Use --mode append or --mode overwrite.`,
      { outDir },
    ),
} as const;

function resolveValidationCommands(projectDir: string): {
  validation: { typecheck?: string; lint?: string; test?: string };
  configMode?: WorkflowMode;
} {
  const { config } = loadConfig(projectDir);
  return {
    validation: {
      ...(config.validation.typecheck ? { typecheck: 'npm run typecheck' } : {}),
      ...(config.validation.lint ? { lint: 'npm run lint' } : {}),
      ...(config.validation.test ? { test: config.validation.testCommand ?? 'npm test' } : {}),
    },
    ...(config.workflow.mode !== undefined ? { configMode: config.workflow.mode } : {}),
  };
}

export async function writeHandoffPack(options: WriteHandoffOptions): Promise<WriteHandoffResult> {
  const { projectDir, sessionId, target, outDir, selectedTaskIds, mode } = options;

  const state = loadState(projectDir, sessionId);
  if (!state) {
    throw handoffWriteError.stateNotFound(sessionId);
  }

  const specContent = readSpecFile(projectDir, sessionId, SPEC_FILE) ?? undefined;
  const planContent = readSpecFile(projectDir, sessionId, PLAN_FILE) ?? undefined;

  let validation: { typecheck?: string; lint?: string; test?: string } = {};
  let configMode: WorkflowMode | undefined;
  try {
    const resolved = resolveValidationCommands(projectDir);
    validation = resolved.validation;
    configMode = resolved.configMode;
  } catch {
    // config absent or invalid — use empty validation
  }

  let summaryMode: WorkflowMode | undefined;
  try {
    const summaryPath = join(sessionDir(projectDir, sessionId), 'summary.json');
    if (existsSync(summaryPath)) {
      const raw = await readFile(summaryPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      const result = SessionSchema.safeParse(parsed);
      if (result.success) {
        summaryMode = result.data.summary?.mode;
      }
    }
  } catch {
    // malformed or missing summary.json — fall through to config/default
  }

  const resolvedMode: WorkflowMode = summaryMode ?? configMode ?? 'standard';

  const constitutionPath = join(projectDir, 'constitution.md');
  const constitutionContent = existsSync(constitutionPath)
    ? await readFile(constitutionPath, 'utf-8')
    : undefined;

  const brandedTaskIds = selectedTaskIds?.map(taskId);
  const filteredTasks = brandedTaskIds
    ? brandedTaskIds.map(id => {
        const task = state.tasks.find(t => t.id === id);
        if (!task) throw handoffWriteError.unknownTaskId(id);
        return task;
      })
    : state.tasks;

  const briefHash = hashTaskBrief(filteredTasks);

  const pack = await renderHandoffWithCustom({
    target,
    sessionId,
    feature: state.feature,
    mode: resolvedMode,
    tasks: filteredTasks,
    ...(specContent !== undefined && { spec: specContent }),
    ...(planContent !== undefined && { plan: planContent }),
    ...(constitutionContent !== undefined && { constitution: constitutionContent }),
    validation,
  }, projectDir);

  if (mode === 'default' && existsSync(outDir)) {
    throw handoffWriteError.outputDirectoryExists(outDir);
  }

  if (mode === 'overwrite' && existsSync(outDir)) {
    // Remove stale files from previous pack before writing the new one.
    // Deletion is confined to outDir itself (caller-controlled, not renderer-provided).
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

    await writeFile(filePath, content, { mode: SECURE_FILE_MODE });
    writtenFiles.push(relative(outDir, filePath));
  }

  const manifestPackFiles = pack.files
    .map(file => file.path)
    .filter(path => existsSync(join(outDir, path)));

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
    const headPath = join(projectDir, '.git', 'HEAD');
    const head = (await readFile(headPath, 'utf-8')).trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice('ref: '.length);
      const refPath = join(projectDir, '.git', ref);
      return (await readFile(refPath, 'utf-8')).trim();
    }
    return head;
  } catch {
    return undefined;
  }
}
