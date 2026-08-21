import { typedEntries } from '../../../utils/type-guards.js';
import { CLI_PROMPT_SENTINEL } from './candidate-contract.js';

export type CliArgumentValidation =
  | Readonly<{ valid: true }>
  | Readonly<{ valid: false; conflicts: readonly string[] }>;

/**
 * REQ-018 authority categories: role, permissions, sandbox/containment, cwd
 * or added roots, configuration sources, tools, hooks/plugins/MCP, session
 * selection, prompt transport, output parser/format, terminal protocol,
 * final-output path, updates, and approval behavior. Each category is
 * adapter-owned; user arguments cannot override it.
 */
export type CliAuthorityCategory =
  | 'role'
  | 'permission'
  | 'sandbox'
  | 'cwd-root'
  | 'config'
  | 'tools'
  | 'hooks-mcp'
  | 'session'
  | 'prompt'
  | 'output'
  | 'update'
  | 'approval';

export type CliParsedSemanticArg = Readonly<{
  /** The flag as written with any `=value` removed; the full token when no `=`. */
  token: string;
  category: CliAuthorityCategory | null;
}>;

/**
 * The authority stems by category. The stem union mirrors the REQ-018 map in
 * `src/engine/runners/arg-vector-preflight.ts` (T-040): readiness rejects the
 * same authority flags over all configured args, dispatch rejects them in the
 * configured tail. A name equals a stem or carries it as a dash-delimited
 * segment.
 */
const AUTHORITY_STEMS_BY_CATEGORY: Readonly<Record<CliAuthorityCategory, readonly string[]>> =
  Object.freeze({
    role: Object.freeze(['role', 'agent', 'persona', 'subagent']),
    permission: Object.freeze(['permission', 'dangerously', 'bypass', 'permissions']),
    sandbox: Object.freeze(['sandbox']),
    'cwd-root': Object.freeze(['cwd', 'cd', 'dir', 'root']),
    config: Object.freeze(['config', 'settings', 'profile', 'rc']),
    tools: Object.freeze(['tool', 'toolset', 'tools']),
    'hooks-mcp': Object.freeze(['hook', 'plugin', 'mcp', 'hooks', 'plugins']),
    session: Object.freeze(['session', 'resume', 'continue', 'fork']),
    prompt: Object.freeze(['transport', 'stdin', 'pipe']),
    output: Object.freeze([
      'print',
      'format',
      'parser',
      'json',
      'terminal',
      'tty',
      'pty',
      'output',
      'out-file',
      'artifact',
      'log-file',
    ]),
    update: Object.freeze(['update', 'upgrade']),
    approval: Object.freeze(['approval', 'allow', 'yes', 'accept', 'ask', 'approvals', 'approve']),
  });

/**
 * Authority short flags with the dominant family reading (`-c` config,
 * `-p` print, `-r` resume, `-y` yes). The dispatch scan rejects every one of
 * them regardless of reading; the category only feeds the role allowlist.
 */
const AUTHORITY_SHORT_CATEGORIES: Readonly<Record<string, CliAuthorityCategory>> = Object.freeze({
  '-c': 'config',
  '-p': 'output',
  '-r': 'session',
  '-y': 'approval',
});

function authorityCategoryOf(name: string): CliAuthorityCategory | null {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  let best: CliAuthorityCategory | null = null;
  let bestRank = 0;
  for (const [category, stems] of typedEntries(AUTHORITY_STEMS_BY_CATEGORY)) {
    for (const stem of stems) {
      const rank =
        normalized === stem
          ? 3
          : normalized.startsWith(`${stem}-`)
            ? 2
            : normalized.endsWith(`-${stem}`)
              ? 1
              : 0;
      if (rank > bestRank) {
        best = category;
        bestRank = rank;
      }
    }
  }
  return best;
}

/**
 * Tokenizes every argument form — long split, `--flag=value`, short,
 * attached-short, and single-dash long — into its authority category. A
 * positional separator (`--`) does not hide a following flag from the scan.
 */
export function parseCliSemanticVector(args: readonly string[]): readonly CliParsedSemanticArg[] {
  return args.map((argument) => {
    const eqIndex = argument.indexOf('=');
    const token = eqIndex === -1 ? argument : argument.slice(0, eqIndex);
    if (token.startsWith('--') && token.length > 2) {
      return { token, category: authorityCategoryOf(token.slice(2)) };
    }
    if (token.startsWith('-') && token !== '-' && !token.startsWith('--')) {
      const short = token.slice(0, 2).toLowerCase();
      return { token: short, category: AUTHORITY_SHORT_CATEGORIES[short] ?? null };
    }
    return { token, category: null };
  });
}

const ALTERNATE_PLACEHOLDER_PATTERN = /^<[^>]+>$/;
const CURLY_PROMPT_PATTERN = /\{prompt\}/i;

function placeholderConflict(value: string): boolean {
  return (
    value.includes(CLI_PROMPT_SENTINEL) ||
    ALTERNATE_PLACEHOLDER_PATTERN.test(value) ||
    CURLY_PROMPT_PATTERN.test(value)
  );
}

function protectedFlag(input: {
  value: string;
  protectedFlags: ReadonlySet<string>;
  protectedShortValueFlags: ReadonlySet<string>;
}): string | null {
  const { value, protectedFlags, protectedShortValueFlags } = input;
  if (protectedFlags.has(value)) return value;
  if (!value.startsWith('-')) return null;
  const eqIndex = value.indexOf('=');
  const flag = eqIndex === -1 ? value : value.slice(0, eqIndex);
  if (protectedFlags.has(flag)) return flag;
  if (value.startsWith('--')) return null;
  for (const shortFlag of protectedShortValueFlags) {
    if (
      shortFlag.length === 2 &&
      shortFlag.startsWith('-') &&
      protectedFlags.has(shortFlag) &&
      value.length > shortFlag.length &&
      value.startsWith(shortFlag)
    ) {
      return shortFlag;
    }
  }
  return null;
}

export function validateCliArgs(input: {
  readonly invocationArgs: readonly string[];
  readonly baseArgs: readonly string[];
  readonly protectedFlags: ReadonlySet<string>;
  readonly protectedShortValueFlags?: ReadonlySet<string> | undefined;
  readonly promptTransport: 'argv' | 'stdin';
}): CliArgumentValidation {
  const { invocationArgs, baseArgs, protectedFlags, promptTransport } = input;
  const protectedShortValueFlags = input.protectedShortValueFlags ?? new Set<string>();
  const conflicts: string[] = [];

  const orderConflict =
    invocationArgs.length < baseArgs.length ||
    baseArgs.some((arg, index) => invocationArgs[index] !== arg);
  if (orderConflict) conflicts.push('argument-order');

  if (
    promptTransport === 'argv' &&
    invocationArgs.filter((arg) => arg === CLI_PROMPT_SENTINEL).length !== 1
  ) {
    conflicts.push('prompt-transport');
  }
  if (invocationArgs.some((arg) => arg !== CLI_PROMPT_SENTINEL && placeholderConflict(arg))) {
    conflicts.push('prompt-transport');
  }

  // The configured tail is only identifiable when the adapter-owned prefix is intact.
  if (!orderConflict) {
    const tail = invocationArgs.slice(baseArgs.length);
    for (const arg of tail) {
      const flag = protectedFlag({ value: arg, protectedFlags, protectedShortValueFlags });
      if (flag !== null) conflicts.push(flag);
    }
    for (const arg of parseCliSemanticVector(tail)) {
      if (arg.category !== null) conflicts.push(arg.token);
    }
  }

  const uniqueConflicts = [...new Set(conflicts)];
  return uniqueConflicts.length === 0
    ? { valid: true }
    : { valid: false, conflicts: uniqueConflicts };
}
