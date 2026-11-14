type ParsedArgs = {
  positionals: string[];
  flags: Set<string>;
  values: { option: string; value: string }[];
};

type ArgSpec = Readonly<{
  /** Short options that take a value, attached (`-fFILE`) or as the next word. */
  short?: string;
  /** Long options that take the next word as their value; `--name=value` needs no listing. */
  long?: readonly string[];
  /** Options end at the first operand — a wrapper's operand is the command it runs. */
  stopAtOperand?: boolean;
}>;

export function parseArgs(args: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: new Set(), values: [] };
  let index = 0;
  for (let arg = args[index]; arg !== undefined; arg = args[index]) {
    index += 1;
    if (arg === '--') {
      parsed.positionals.push(...args.slice(index));
      break;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const option = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
      parsed.flags.add(option);
      if (equals !== -1) parsed.values.push({ option, value: arg.slice(equals + 1) });
      else if (spec.long?.includes(option) === true) {
        const value = args[index];
        if (value !== undefined) parsed.values.push({ option, value });
        index += 1;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let at = 1; at < arg.length; at += 1) {
        const option = arg.charAt(at);
        parsed.flags.add(option);
        if (spec.short?.includes(option) !== true) continue;
        const attached = arg.slice(at + 1);
        const next = args[index];
        if (attached !== '') parsed.values.push({ option, value: attached });
        else if (next !== undefined) {
          parsed.values.push({ option, value: next });
          index += 1;
        }
        break;
      }
    } else {
      parsed.positionals.push(arg);
      if (spec.stopAtOperand === true) {
        parsed.positionals.push(...args.slice(index));
        break;
      }
    }
  }
  return parsed;
}

export function valuesOf(parsed: ParsedArgs, ...options: string[]): string[] {
  return parsed.values
    .filter((entry) => options.includes(entry.option))
    .map((entry) => entry.value);
}

export function hasFlag(parsed: ParsedArgs, ...flags: string[]): boolean {
  return flags.some((flag) => parsed.flags.has(flag));
}

export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
