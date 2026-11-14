import { toErrorMessage } from '../utils/format/errors.js';
import { sanitizeTerminalDiagnosticText } from '../utils/display-text/diagnostic.js';
import { createLogger } from './logger.js';

// A diagnostic names a presentation only when the user must act on it. `feedback` shows on the
// feedback line of the TUI. `at-exit` is a note for the user who quits: the TUI writes it to
// stderr once the terminal is restored, never to the feedback line.
type DiagnosticPresentation = 'feedback' | 'at-exit';
type DiagnosticSink = (message: string, presentation: DiagnosticPresentation) => void;

const diagnosticLog = createLogger('diagnostics');

// The last installed sink owns the diagnostics that name a presentation; stderr owns them when
// none is installed.
const diagnosticOwners: { sink: DiagnosticSink }[] = [];

export function installDiagnosticSink(sink: DiagnosticSink): () => void {
  const owner = { sink };
  diagnosticOwners.push(owner);
  return () => {
    const index = diagnosticOwners.lastIndexOf(owner);
    if (index !== -1) diagnosticOwners.splice(index, 1);
  };
}

/** Writes each diagnostic to the debug log. One with no presentation goes nowhere else. */
export function warnStderr(message: string, presentation?: DiagnosticPresentation): void {
  const text = sanitizeTerminalDiagnosticText(message);
  diagnosticLog.warn(text);
  if (presentation === undefined) return;
  const owner = diagnosticOwners.at(-1);
  if (owner) {
    owner.sink(text, presentation);
    return;
  }
  process.stderr.write(`${text}\n`);
}

export function warnError(
  context: string,
  err?: unknown,
  presentation?: DiagnosticPresentation,
): void {
  warnStderr(err === undefined ? context : `${context}: ${toErrorMessage(err)}`, presentation);
}
