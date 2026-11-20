import { feedbackStore } from '../../../stores/ui/feedback.js';
import { spawn } from 'node:child_process';
import { withUserNodeEnv } from '../../../lib/process/spawn/child-env.js';
import { cursorUpSequence, terminalSequences } from '../../../lib/terminal/control.js';
import {
  suspendTerminalForEditor,
  resumeTerminalAfterEditor,
} from '../../../lib/terminal/editor-handover.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import {
  type ViewerArgv,
  editorWaitingMessage,
  isGuiEditor,
  viewerRestoresScreen,
} from './command.js';

// Ink paints at most every ~33ms (maxFps 30), so the "Opening …" byline needs one frame
// on screen before the terminal handover freezes the TUI.
export const OPENING_SIGNAL_PAINT_MS = 60;

export interface EditorExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface EditorProcess {
  once(event: 'error', listener: (err: Error) => void): void;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
}

export type SpawnEditor = (
  command: string,
  args: string[],
  stdio?: 'inherit' | 'ignore',
) => EditorProcess;

export const spawnEditorProcess: SpawnEditor = (command, args, stdio = 'inherit') =>
  spawn(command, args, { stdio, env: withUserNodeEnv(process.env) });

interface RunEditorOptions extends ViewerArgv {
  filePath: string;
  purpose: 'edit' | 'view';
  spawnEditor: SpawnEditor;
}

export function runEditor({
  command,
  args,
  kind,
  filePath,
  purpose,
  spawnEditor,
}: RunEditorOptions): Promise<EditorExit> {
  const terminal = kind === 'pager' || !isGuiEditor(command);
  if (terminal) suspendTerminalForEditor();
  const message = editorWaitingMessage(
    { command, args, kind },
    filePath,
    terminal ? 'return' : purpose === 'edit' ? 'apply changes' : 'finish viewing',
  );
  const messageRows = Math.max(
    1,
    Math.ceil(getTerminalCellWidth(message) / process.stdout.columns),
  );
  return new Promise<EditorExit>((resolve, reject) => {
    if (terminal) process.stdout.write(`\r\n${message}\n`);
    else feedbackStore.setMessage(message);
    const child = terminal
      ? spawnEditor(command, [...args, filePath])
      : spawnEditor(command, [...args, filePath], 'ignore');
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    if (!terminal) {
      if (feedbackStore.get().message === message) feedbackStore.setMessage(null);
      return;
    }
    // A viewer that restores the screen leaves the cursor below the waiting line, so this erases
    // the blank row and the wrapped message rows above it. Any other viewer wrote below the line.
    if (viewerRestoresScreen({ command, args, kind })) {
      process.stdout.write(`${cursorUpSequence(messageRows + 1)}\r${terminalSequences.eraseDown}`);
    }
    resumeTerminalAfterEditor();
  });
}
