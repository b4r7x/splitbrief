import { toErrorMessage } from '../utils/format-errors.js';
import { sanitizeTerminalDiagnosticText } from '../utils/display-text.js';

type DiagnosticPresentation = 'feedback' | 'log-only';
type DiagnosticSink = (message: string, presentation: DiagnosticPresentation) => void;

// The last installed sink owns recoverable diagnostics; stderr owns them when none is installed.
const diagnosticOwners: { sink: DiagnosticSink }[] = [];

export function installDiagnosticSink(sink: DiagnosticSink): () => void {
  const owner = { sink };
  diagnosticOwners.push(owner);
  return () => {
    const index = diagnosticOwners.lastIndexOf(owner);
    if (index !== -1) diagnosticOwners.splice(index, 1);
  };
}

export function warnStderr(
  message: string,
  presentation: DiagnosticPresentation = 'feedback',
): void {
  const text = sanitizeTerminalDiagnosticText(message);
  const owner = diagnosticOwners.at(-1);
  if (owner) {
    owner.sink(text, presentation);
    return;
  }
  process.stderr.write(`${text}\n`);
}

export function warnError(context: string, err?: unknown): void {
  warnStderr(err === undefined ? context : `${context}: ${toErrorMessage(err)}`);
}
