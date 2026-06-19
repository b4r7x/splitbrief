import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { formatTasks } from '../../../engine/spec/formatter.js';
import type { Task } from '../../../core/schemas/task.js';
import { writeSecureFileAsync } from '../../../lib/fs.js';
import type { TaskBriefSection } from '../../../stores/workflow/plan-editor-sections.js';
import {
  getTaskBriefSectionLabel,
  getTaskBriefSectionText,
} from '../../../stores/workflow/plan-editor-sections.js';

export interface CopySelectionResult {
  path: string;
  clipboard: boolean;
  message: string;
}

export type ClipboardRunner = (command: string, args: string[], input: string) => Promise<boolean>;

export function formatTaskCopyText(task: Task): string {
  return formatTasks([task]);
}

export function formatTaskSectionCopyText(task: Task, section: TaskBriefSection): string {
  return getTaskBriefSectionText(task, section);
}

export async function copyPlanEditorSelection(opts: {
  sessionDirPath: string;
  task: Task;
  section?: TaskBriefSection | undefined;
  platform?: NodeJS.Platform | undefined;
  runClipboardCommand?: ClipboardRunner | undefined;
}): Promise<CopySelectionResult> {
  const text = opts.section
    ? formatTaskSectionCopyText(opts.task, opts.section)
    : formatTaskCopyText(opts.task);
  const path = selectionPath(opts.sessionDirPath);
  await writeSecureFileAsync(path, text);

  const clipboard = await tryClipboard({
    text,
    platform: opts.platform ?? process.platform,
    run: opts.runClipboardCommand ?? runClipboardCommand,
  });
  const label = opts.section ? getTaskBriefSectionLabel(opts.section) : opts.task.id;
  return {
    path,
    clipboard,
    message: clipboard ? `copied ${label}; fallback ${path}` : `copied ${label} to ${path}`,
  };
}

function selectionPath(sessionDirPath: string): string {
  const sessionDir = resolve(sessionDirPath);
  const path = resolve(sessionDir, 'selection.txt');
  const rel = relative(sessionDir, path);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('selection path escaped session directory');
  }
  return path;
}

async function tryClipboard(opts: {
  text: string;
  platform: NodeJS.Platform;
  run: ClipboardRunner;
}): Promise<boolean> {
  for (const command of clipboardCommands(opts.platform)) {
    if (await opts.run(command.command, command.args, opts.text)) return true;
  }
  return false;
}

function clipboardCommands(platform: NodeJS.Platform): Array<{ command: string; args: string[] }> {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip.exe', args: [] }];
  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
  ];
}

export function runClipboardCommand(
  command: string,
  args: string[],
  input: string,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => settle(false));
    child.stdin.once('error', () => settle(false));
    child.once('close', (code) => settle(code === 0));
    child.stdin.end(input);
  });
}
