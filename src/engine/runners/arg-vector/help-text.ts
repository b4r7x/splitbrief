import {
  type FlagFamily,
  normalizeFlag,
  OPTION_ENTRY_PATTERN,
  OPTION_TOKEN_PATTERN,
  SUBCOMMAND_NAME_PATTERN,
} from './flags.js';

export function advertisedFlags(helpText: string, family: FlagFamily): Set<string> {
  const scanned = family.bareToken ? optionEntryLines(helpText) : helpText;
  const flags = new Set<string>();
  for (const match of scanned.matchAll(family.advertised)) {
    flags.add(normalizeFlag(match[0], family));
  }
  return flags;
}

function optionEntryLines(helpText: string): string {
  return helpText
    .split(/\r?\n/)
    .filter((line) => OPTION_ENTRY_PATTERN.test(line))
    .join('\n');
}

/**
 * A flag counts as deprecated only when the marker sits inside that flag's own
 * option entry: the entry starts on the line that declares the flag and ends at
 * the next line that opens another option or another help section. A marker on
 * a neighbouring entry, or the flag's name quoted inside someone else's
 * description, is not evidence about this flag.
 */
export function deprecatedFlags(
  helpText: string,
  flags: readonly string[],
  family: FlagFamily,
): string[] {
  const lines = helpText.split(/\r?\n/);
  return flags.filter((flag) =>
    lines.some(
      (line, index) => declaresFlag({ line, flag, family }) && entryIsDeprecated(lines, index),
    ),
  );
}

function declaresFlag(
  input: Readonly<{ line: string; flag: string; family: FlagFamily }>,
): boolean {
  const { line, flag, family } = input;
  if (!OPTION_ENTRY_PATTERN.test(line)) return false;
  for (const token of line.trim().split(/\s+/)) {
    if (!OPTION_TOKEN_PATTERN.test(token)) return false;
    if (normalizeFlag(token.replace(/[,=].*$/, ''), family) === flag) return true;
  }
  return false;
}

function entryIsDeprecated(lines: readonly string[], start: number): boolean {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) return false;
    if (index > start && opensNewEntry(line)) return false;
    if (/deprecated/i.test(line)) return true;
  }
  return false;
}

function opensNewEntry(line: string): boolean {
  return OPTION_ENTRY_PATTERN.test(line) || /^\S/.test(line);
}

export function subcommandCandidate(
  input: Readonly<{ argv: readonly string[]; topLevelHelp: string; command: string }>,
): string | null {
  const { argv, topLevelHelp, command } = input;
  const commands = commandNames({ helpText: topLevelHelp, command });
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token.startsWith('-')) continue;
    const previous = argv[index - 1];
    if (previous?.startsWith('-')) continue;
    if (commands.has(token.toLowerCase())) return token;
  }
  return null;
}

/**
 * clap prints `  exec  Run Codex non-interactively`, yargs prints
 * `  opencode run [message..]  run opencode with a message`, and opencode 2
 * heads its bare names `SUBCOMMANDS`. A leading token that repeats the tool's
 * own command name is the binary, not the subcommand, so the name is the token
 * after it — and only when that token is a plain word rather than a
 * `[positional]` placeholder.
 */
function commandNames(input: Readonly<{ helpText: string; command: string }>): Set<string> {
  const { helpText, command } = input;
  const names = new Set<string>();
  let inCommands = false;
  for (const line of helpText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:sub)?commands?:?$/i.test(trimmed)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (!/^\s{2,}\S/.test(line)) {
      if (trimmed.length > 0) inCommands = false;
      continue;
    }
    const [first, second] = trimmed.split(/\s+/);
    if (first === undefined) continue;
    const name = first.toLowerCase() === command.toLowerCase() ? second : first;
    if (name === undefined || !SUBCOMMAND_NAME_PATTERN.test(name)) continue;
    names.add(name.toLowerCase());
  }
  return names;
}
