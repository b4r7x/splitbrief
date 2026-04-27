import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { HandoffTarget } from './types.js';
// target is widened to string to support custom renderers alongside built-in HandoffTarget values
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

export type WriteHandoffOptions = {
  projectDir: string;
  sessionId: string;
  target: HandoffTarget | string;
  outDir: string;
  selectedTaskIds?: string[];
  mode: 'default' | 'append' | 'overwrite';
};

export type WriteHandoffResult = {
  outputDir: string;
  files: string[];
};

export async function writeHandoffPack(options: WriteHandoffOptions): Promise<WriteHandoffResult> {
  const { projectDir, sessionId, target, outDir, selectedTaskIds, mode } = options;

  const state = loadState(projectDir, sessionId);
  if (!state) {
    throw new Error(`no state found for session: ${sessionId}`);
  }

  const specContent = readSpecFile(projectDir, sessionId, SPEC_FILE) ?? undefined;
  const planContent = readSpecFile(projectDir, sessionId, PLAN_FILE) ?? undefined;

  let validation: { typecheck?: string; lint?: string; test?: string } = {};
  let configMode: WorkflowMode | undefined;
  try {
    const { config } = loadConfig(projectDir);
    if (config.validation.test && config.validation.testCommand) {
      validation = { ...validation, test: config.validation.testCommand };
    }
    configMode = config.workflow.mode;
  } catch {
    // config absent or invalid — use empty validation
  }

  let summaryMode: WorkflowMode | undefined;
  try {
    const summaryPath = join(sessionDir(projectDir, sessionId), 'summary.json');
    if (existsSync(summaryPath)) {
      const raw = readFileSync(summaryPath, 'utf-8');
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
    ? readFileSync(constitutionPath, 'utf-8')
    : undefined;

  const brandedTaskIds = selectedTaskIds?.map(taskId);
  const filteredTasks = brandedTaskIds
    ? brandedTaskIds.map(id => {
        const task = state.tasks.find(t => t.id === id);
        if (!task) throw new Error(`unknown task id: ${id}`);
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
    throw new Error(
      `output directory already exists: ${outDir}. Use --mode append or --mode overwrite.`,
    );
  }

  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const writtenFiles: string[] = [];

  for (const file of pack.files) {
    const filePath = join(outDir, file.path);
    const fileDir = join(filePath, '..');
    mkdirSync(fileDir, { recursive: true, mode: 0o700 });

    if (mode === 'append' && existsSync(filePath)) {
      continue;
    }

    const content = file.path.startsWith('tasks/')
      ? file.content.replace('<placeholder>', briefHash)
      : file.content;

    writeFileSync(filePath, content, { mode: 0o600 });
    writtenFiles.push(relative(outDir, filePath));
  }

  const sourceCommit = tryReadGitHead(projectDir);
  const manifest = buildManifest({
    sessionId,
    diptychVersion: getDiptychVersion(),
    target,
    mode: resolvedMode,
    tasks: filteredTasks,
    packFiles: writtenFiles,
    spec: specContent ?? null,
    plan: planContent ?? null,
    constitution: constitutionContent ?? null,
    validation,
    ...(sourceCommit !== undefined && { sourceCommit }),
  });
  writeManifest(outDir, manifest);

  return { outputDir: outDir, files: writtenFiles };
}

function tryReadGitHead(projectDir: string): string | undefined {
  try {
    const headPath = join(projectDir, '.git', 'HEAD');
    const head = readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice('ref: '.length);
      const refPath = join(projectDir, '.git', ref);
      return readFileSync(refPath, 'utf-8').trim();
    }
    return head;
  } catch {
    return undefined;
  }
}
