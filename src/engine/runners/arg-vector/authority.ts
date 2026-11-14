/**
 * Authority-bearing long-flag stems (REQ-018): role, permissions,
 * sandbox/containment, cwd or added roots, configuration sources, tools,
 * hooks/plugins/MCP, session selection, prompt transport, output
 * parser/format, terminal protocol, final-output path, updates, and approval
 * behavior. A flag whose normalized name equals a stem or carries it as a
 * dash-delimited segment is a candidate override; SPLITBRIEF owns these fields
 * and user arguments cannot.
 */
const AUTHORITY_LONG_ARGUMENT_STEMS = Object.freeze([
  'role',
  'agent',
  'persona',
  'subagent',
  'permission',
  'dangerously',
  'bypass',
  'sandbox',
  'cwd',
  'cd',
  'dir',
  'root',
  'config',
  'settings',
  'profile',
  'rc',
  'tool',
  'toolset',
  'hook',
  'plugin',
  'mcp',
  'session',
  'resume',
  'continue',
  'fork',
  'transport',
  'stdin',
  'pipe',
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
  'update',
  'upgrade',
  'approval',
  'allow',
  'yes',
  'accept',
  'ask',
] as const);

/** Authority-bearing short flags shared by the admitted CLI families. */
const AUTHORITY_SHORT_ARGUMENTS = new Set(['-c', '-p', '-r', '-y']);

function longFlagName(argument: string): string | null {
  if (!argument.startsWith('--') || argument.length === 2) return null;
  return argument.slice(2).split('=', 1)[0]?.toLowerCase() ?? null;
}

function isAuthorityLongFlag(name: string): boolean {
  return AUTHORITY_LONG_ARGUMENT_STEMS.some(
    (stem) => name === stem || name.startsWith(`${stem}-`) || name.endsWith(`-${stem}`),
  );
}

/**
 * Semantic override rejection over user-configured arguments (REQ-018): a
 * configured flag that can override role, permissions, sandbox, cwd or added
 * roots, configuration sources, tools, hooks/plugins/MCP, session selection,
 * prompt transport, output parser/format, terminal protocol, final-output
 * path, updates, or approval behavior is reported before any process spawns.
 * Long forms, `--flag=value` attached forms, short forms, and attached short
 * forms are all scanned; a positional separator (`--`) does not hide a flag
 * from the scan. The adapter's own emitted vector is adapter-owned and never
 * reaches this check.
 */
export function semanticConfiguredArgViolations(args: readonly string[]): readonly string[] {
  const violations: string[] = [];
  for (const argument of args) {
    const name = longFlagName(argument);
    if (name !== null) {
      if (isAuthorityLongFlag(name)) violations.push(argument.split('=', 1)[0] ?? argument);
      continue;
    }
    if (argument.startsWith('-') && argument !== '-' && !argument.startsWith('--')) {
      const short = argument.slice(0, 2).toLowerCase();
      if (AUTHORITY_SHORT_ARGUMENTS.has(short)) violations.push(short);
    }
  }
  return violations;
}
