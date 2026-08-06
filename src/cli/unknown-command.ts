import { cliError } from './errors.js';
import { stripTerminalControls } from '../utils/display-text.js';
import { SPLITBRIEF_IDENTITY } from '../core/identity.js';

/**
 * `start` is the default command, so any bare token becomes a feature
 * description and a mistyped subcommand silently buys a planner call. The
 * guard fires only on the unambiguous shape — one operand, no whitespace,
 * close enough to a registered command that nothing else explains it — so the
 * documented `splitbrief "fix the typo"` shorthand keeps working.
 */
export function assertNotMistypedCommand(
  argv: readonly string[],
  commandNames: readonly string[],
): void {
  const token = soleLeadingOperand(argv);
  if (token === undefined || commandNames.includes(token)) return;

  const suggestion = nearestCommand(token, commandNames);
  if (suggestion === undefined) return;

  const shown = stripTerminalControls(token);
  throw cliError(
    `unknown command '${shown}' — did you mean '${suggestion}'?\n` +
      `If '${shown}' is the feature you meant, run: ${SPLITBRIEF_IDENTITY.executable} start "${shown}"`,
    1,
  );
}

function soleLeadingOperand(argv: readonly string[]): string | undefined {
  const operands: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) break;
    operands.push(arg);
  }
  if (operands.length !== 1) return undefined;
  const only = operands[0];
  if (only === undefined || /\s/.test(only)) return undefined;
  return only;
}

function nearestCommand(token: string, commandNames: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of commandNames) {
    // Short names accept only a single edit: at distance 2 almost any English
    // word is "near" `ps` or `last`, which would eat real one-word features.
    const budget = name.length <= 4 ? 1 : 2;
    const distance = editDistance(token, name);
    if (distance <= budget && distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Optimal string alignment distance — Levenshtein plus adjacent transposition
 * as a single edit, so the commonest typo of all (`doctro` for `doctor`) lands
 * at distance 1 rather than 2.
 */
function editDistance(a: string, b: string): number {
  let twoAgo: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + substitution,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (twoAgo[j - 2] ?? 0) + 1);
      }
      current.push(best);
    }
    twoAgo = previous;
    previous = current;
  }

  return previous[b.length] ?? 0;
}
