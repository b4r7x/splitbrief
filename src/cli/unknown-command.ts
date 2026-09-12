import { cliError } from './errors.js';
import { stripTerminalControls } from '../utils/display-text.js';
import { SPLITBRIEF_IDENTITY } from '../core/identity.js';

/**
 * Commands that were removed. `start` is the default command, so without this
 * table `splitbrief attach <id>` would be parsed as a feature description and
 * buy a planner call on the first keystroke of muscle memory.
 */
const RETIRED_COMMANDS: Readonly<Record<string, string>> = {
  attach: 'sessions now run in the foreground — use `splitbrief continue <id>`',
  detach: 'sessions now run in the foreground — use `splitbrief continue <id>`',
  ps: '`splitbrief status` shows the active session; there is no session list',
  last: '`splitbrief status` shows the active session; there is no session list',
  mcp: 'the MCP server was removed',
  explain: 'read the session artifacts under .splitbrief/sessions/<id>/',
  handoff: 'read the session artifacts under .splitbrief/sessions/<id>/',
  export: 'read the session artifacts under .splitbrief/sessions/<id>/',
  stats: 'per-session cost is in the run summary',
  snapshot: 'use the `/run accept` and `/run reject` runtime commands',
  worktree: 'runs isolate themselves; there is no worktree command',
};

/**
 * `start` is the default command, so any bare token becomes a feature
 * description and a mistyped subcommand silently buys a planner call. The
 * near-miss guard fires only on the unambiguous shape — one operand, no
 * whitespace, close enough to a registered command that nothing else explains
 * it — so the documented `splitbrief "fix the typo"` shorthand keeps working.
 * A retired name is rejected on the first operand alone, leading flags and
 * trailing arguments included.
 */
export function assertNotMistypedCommand(
  argv: readonly string[],
  commandNames: readonly string[],
  valueFlags: ReadonlySet<string>,
): void {
  const operands = leadingOperands(argv, valueFlags);
  assertNotRetiredCommand(operands, commandNames);

  const token = soleOperand(operands);
  if (token === undefined || commandNames.includes(token)) return;

  const suggestion = nearestCommand(token, commandNames);
  if (suggestion === undefined) return;

  const shown = stripTerminalControls(token);
  throw cliError(
    `unknown command '${shown}' — did you mean '${suggestion}'?\n${startEscapeHatch(shown)}`,
    1,
  );
}

function startEscapeHatch(shown: string): string {
  return `If '${shown}' is the feature you meant, run: ${SPLITBRIEF_IDENTITY.executable} start "${shown}"`;
}

function assertNotRetiredCommand(
  operands: readonly string[],
  commandNames: readonly string[],
): void {
  const first = operands[0];
  if (first === undefined) return;
  if (commandNames.includes(first)) return;
  const replacement = Object.hasOwn(RETIRED_COMMANDS, first) ? RETIRED_COMMANDS[first] : undefined;
  if (replacement === undefined) return;
  const shown = stripTerminalControls(first);
  throw cliError(`unknown command '${shown}' — ${replacement}\n${startEscapeHatch(shown)}`, 1);
}

/**
 * The operands of the default `start` command, with every flag and every flag
 * argument dropped. A flag spelled with `=` carries its own value, so only a
 * separate-token value consumes the next entry.
 */
function leadingOperands(argv: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    if (!arg.includes('=') && valueFlags.has(arg)) index++;
  }
  return operands;
}

function soleOperand(operands: readonly string[]): string | undefined {
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
    // word is "near" `spec` or `init`, which would eat real one-word features.
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
