import { accessSync, constants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { parseShellCommand } from '../../utils/parse-shell-command.js';

interface EditorArgv {
  command: string;
  args: string[];
}

interface ResolveEditorArgvOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  commandExists?: (command: string, env: NodeJS.ProcessEnv) => boolean;
}

const guiEditorCandidates: readonly EditorArgv[] = [
  { command: 'cursor', args: ['--wait'] },
  { command: 'code', args: ['--wait'] },
  { command: 'zed', args: ['--wait'] },
  { command: 'subl', args: ['--wait'] },
  { command: 'mate', args: ['--wait'] },
  { command: 'bbedit', args: ['--wait'] },
];

const terminalEditors = new Set([
  'ed',
  'emacs',
  'hx',
  'joe',
  'kak',
  'micro',
  'nano',
  'nvim',
  'pico',
  'vi',
  'vim',
]);

const windowsExecutableExtensions = ['.exe', '.cmd', '.bat'] as const;

function parseEditor(raw: string | undefined): EditorArgv | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const tokens = parseShellCommand(trimmed);
  if (tokens.length === 0) return undefined;
  const [command, ...args] = tokens;
  if (!command) return undefined;
  return { command, args };
}

export function editorDisplayLabel(command: string): string {
  return basename(command).replace(/\.(cmd|exe|bat)$/i, '');
}

function editorName(command: string): string {
  return editorDisplayLabel(command).toLowerCase();
}

function isTerminalEditor(command: string): boolean {
  return terminalEditors.has(editorName(command));
}

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && isAbsolute(segment);
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): readonly string[] {
  const pathext = env.PATHEXT?.split(';').filter((ext) => ext.length > 0) ?? [];
  return [...pathext, ...windowsExecutableExtensions];
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableInAbsolutePathSegment(
  command: string,
  segment: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const base = join(segment, command);
  if (isExecutableFile(base)) return base;
  if (platform !== 'win32') return undefined;
  for (const extension of windowsPathExtensions(env)) {
    const candidate = `${base}${extension}`;
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function resolveExecutableInPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command) ? command : undefined;
  }
  const path = env.PATH;
  if (!path) return undefined;
  for (const segment of path.split(delimiter)) {
    if (!isSafePathSegment(segment)) continue;
    const resolved = resolveExecutableInAbsolutePathSegment(command, segment, platform, env);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function detectGuiEditor(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): EditorArgv | undefined {
  for (const candidate of guiEditorCandidates) {
    const resolved = resolveExecutableInPath(candidate.command, env, platform);
    if (resolved !== undefined) {
      return { command: resolved, args: [...candidate.args] };
    }
  }
  if (platform === 'darwin') {
    const openPath = resolveExecutableInPath('open', env, platform);
    if (openPath !== undefined) return { command: openPath, args: ['-W', '-t'] };
  }
  return undefined;
}

export function resolveEditorArgv(options: ResolveEditorArgvOptions = {}): EditorArgv {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const visual = parseEditor(env.VISUAL);
  if (visual) return visual;

  const editor = parseEditor(env.EDITOR);
  if (editor && !isTerminalEditor(editor.command)) return editor;

  if (options.commandExists !== undefined) {
    for (const candidate of guiEditorCandidates) {
      if (options.commandExists(candidate.command, env)) {
        return { command: candidate.command, args: [...candidate.args] };
      }
    }
    if (platform === 'darwin' && options.commandExists('open', env)) {
      return { command: 'open', args: ['-W', '-t'] };
    }
  } else {
    const guiEditor = detectGuiEditor(env, platform);
    if (guiEditor) return guiEditor;
  }

  if (editor) return editor;
  return { command: 'vi', args: [] };
}
