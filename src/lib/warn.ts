import { toErrorMessage } from '../utils/format-errors.js';
import { sanitizeTerminalDiagnosticText } from '../utils/display-text.js';
import { countNoun } from '../utils/pluralize.js';

// `at-exit` is a note for the user who quits: the TUI writes it to stderr once the terminal is
// restored, never to the feedback line.
type DiagnosticPresentation = 'feedback' | 'log-only' | 'at-exit';
type DiagnosticSink = (message: string, presentation: DiagnosticPresentation) => void;

type Diagnostic = Readonly<{ text: string; presentation: DiagnosticPresentation }>;

// The last installed sink owns recoverable diagnostics; stderr owns them when none is installed.
const diagnosticOwners: { sink: DiagnosticSink }[] = [];

// A TUI process holds what it raises before its screen mounts: written to stderr then, the
// diagnostics would sit behind the fullscreen frame until exit.
let held: Diagnostic[] | null = null;

/** Holds diagnostics until a sink is installed; what is left goes to stderr once `run` settles. */
export async function withHeldDiagnostics<T>(run: () => Promise<T>): Promise<T> {
  held = [];
  try {
    return await run();
  } finally {
    const rest = held ?? [];
    held = null;
    for (const { text } of rest) process.stderr.write(`${text}\n`);
  }
}

export function installDiagnosticSink(sink: DiagnosticSink): () => void {
  const owner = { sink };
  diagnosticOwners.push(owner);
  let replayed: readonly Diagnostic[] = [];
  if (held !== null) {
    replayed = held;
    held = null;
    for (const { text } of replayed.filter((d) => d.presentation === 'log-only')) {
      sink(text, 'log-only');
    }
    // The feedback line shows one message at a time: the first held warning, led by the count, so
    // a line cut at its end still says how many there are and where they all show.
    const [first, ...rest] = replayed.filter((d) => d.presentation === 'feedback');
    if (first !== undefined) {
      const count = `${countNoun(rest.length + 1, 'warning')}, all shown when you quit`;
      sink(rest.length === 0 ? first.text : `${count} · ${first.text}`, 'feedback');
    }
  }
  return () => {
    const index = diagnosticOwners.lastIndexOf(owner);
    if (index !== -1) diagnosticOwners.splice(index, 1);
    // A screen clears its feedback line as it moves on, so the held diagnostics also stay on the
    // terminal once it is restored.
    for (const { text } of replayed) process.stderr.write(`${text}\n`);
    replayed = [];
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
  if (held !== null) {
    held.push({ text, presentation });
    return;
  }
  process.stderr.write(`${text}\n`);
}

export function warnError(context: string, err?: unknown): void {
  warnStderr(err === undefined ? context : `${context}: ${toErrorMessage(err)}`);
}
