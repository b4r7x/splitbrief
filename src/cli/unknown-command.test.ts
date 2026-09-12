import { describe, expect, it } from 'vitest';
import { assertNotMistypedCommand } from './unknown-command.js';
import { isCliError } from './errors.js';

// Mirrors the registration order in src/cli.ts; the guard itself is fed the
// live `program.commands` list, so this is a sample, not a second registry.
const COMMANDS = [
  'start',
  'doctor',
  'spec',
  'init',
  'status',
  'resume',
  'review',
  'approval',
  'continue',
];

// A sample of the value-taking flags `valueTakingFlags(program)` reads off the
// live registrations in src/cli/options.ts; the boolean flags are absent on
// purpose, because that is the distinction the operand scan turns on.
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--approve',
  '--model',
  '--mode',
  '--project',
  '--planner',
  '--implementer',
  '--reviewer',
  '--budget',
]);

const ESCAPE = String.fromCharCode(27);

function captureThrown(argv: string[]): unknown {
  try {
    assertNotMistypedCommand(argv, COMMANDS, VALUE_FLAGS);
    return null;
  } catch (err) {
    return err;
  }
}

function messageOf(captured: unknown): string {
  return (captured as Error).message;
}

describe('assertNotMistypedCommand rejects a near-miss subcommand', () => {
  it('names the typo and the suggestion, and exits 1 instead of starting a workflow', () => {
    const captured = captureThrown(['doctro']);

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    expect(messageOf(captured)).toContain("unknown command 'doctro'");
    expect(messageOf(captured)).toContain("did you mean 'doctor'?");
  });

  it('offers the explicit escape hatch for a token the user really meant as a feature', () => {
    const captured = captureThrown(['doctro']);

    expect(messageOf(captured)).toContain('splitbrief start "doctro"');
  });

  it.each([
    { argv: ['spce'], suggestion: 'spec' },
    { argv: ['docter'], suggestion: 'doctor' },
    { argv: ['doctro', '--json'], suggestion: 'doctor' },
    { argv: ['spce', '--mode', 'quick'], suggestion: 'spec' },
  ])('rejects $argv suggesting $suggestion', ({ argv, suggestion }) => {
    const captured = captureThrown(argv);

    expect(isCliError(captured)).toBe(true);
    expect(messageOf(captured)).toContain(`did you mean '${suggestion}'?`);
  });

  it('strips terminal control bytes out of the token it echoes back', () => {
    const captured = captureThrown([`docto${ESCAPE}`]);

    expect(isCliError(captured)).toBe(true);
    expect(messageOf(captured)).toContain("did you mean 'doctor'?");
    expect(messageOf(captured)).not.toContain(ESCAPE);
  });
});

describe('assertNotMistypedCommand rejects a retired command', () => {
  it.each([
    { argv: ['attach'], hint: 'splitbrief continue <id>' },
    { argv: ['attach', '2026-09-11-ab'], hint: 'splitbrief continue <id>' },
    { argv: ['detach'], hint: 'splitbrief continue <id>' },
    { argv: ['ps'], hint: 'there is no session list' },
    { argv: ['ps', '--json'], hint: 'there is no session list' },
    { argv: ['last'], hint: 'there is no session list' },
    { argv: ['mcp', 'serve'], hint: 'MCP server was removed' },
    { argv: ['explain'], hint: '.splitbrief/sessions/<id>/' },
    { argv: ['handoff'], hint: '.splitbrief/sessions/<id>/' },
    { argv: ['export', 'html'], hint: '.splitbrief/sessions/<id>/' },
    { argv: ['export', 'the', 'ledger'], hint: '.splitbrief/sessions/<id>/' },
    { argv: ['stats'], hint: 'per-session cost is in the run summary' },
    { argv: ['snapshot', 'list'], hint: '/run accept' },
    { argv: ['worktree'], hint: 'there is no worktree command' },
  ])('rejects $argv instead of starting a workflow', ({ argv, hint }) => {
    const captured = captureThrown(argv);

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    expect(messageOf(captured)).toContain(`unknown command '${argv[0]}'`);
    expect(messageOf(captured)).toContain(hint);
  });

  it.each([
    { label: 'a boolean flag ahead of the retired name', argv: ['--json', 'attach', 'x'] },
    { label: 'a value flag ahead of the retired name', argv: ['--project', 'foo', 'attach', 'x'] },
    { label: 'a value flag spelled with =', argv: ['--project=foo', 'attach', 'x'] },
    { label: 'a boolean flag between operands', argv: ['--yolo', 'ps'] },
  ])('sees through $label', ({ argv }) => {
    const captured = captureThrown(argv);

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    expect(messageOf(captured)).toContain("unknown command '");
  });

  it('offers the start escape hatch for an unquoted feature that opens with a retired name', () => {
    const captured = captureThrown(['export', 'the', 'ledger']);

    expect(messageOf(captured)).toContain('splitbrief start "export"');
  });
});

describe('assertNotMistypedCommand leaves real invocations alone', () => {
  it.each([
    { label: 'no arguments', argv: [] },
    { label: 'a registered command', argv: ['doctor'] },
    { label: 'a registered command with flags', argv: ['status', '--json'] },
    { label: 'a leading flag', argv: ['--help'] },
    { label: 'a quoted multi-word feature', argv: ['fix the typo'] },
    { label: 'an unquoted multi-word feature', argv: ['fix', 'the', 'typo'] },
    { label: 'a feature plus file operands', argv: ['add caching', 'src/cache.ts'] },
    { label: 'a one-word feature far from every command', argv: ['refactor'] },
    { label: 'a one-word feature two edits from a short command', argv: ['test'] },
    { label: 'the explicit start escape hatch', argv: ['start', 'doctro'] },
    { label: 'a quoted feature that opens with a retired name', argv: ['attach the debugger'] },
    { label: 'the explicit start escape hatch for a retired name', argv: ['start', 'attach'] },
    { label: 'a quoted feature that opens with a newly retired name', argv: ['export the ledger'] },
    { label: 'an inherited Object.prototype key', argv: ['toString'] },
    { label: 'a retired name that is a value-flag argument', argv: ['--project', 'attach'] },
    { label: 'a near-miss that is a value-flag argument', argv: ['--mode', 'doctro'] },
  ])('admits $label', ({ argv }) => {
    expect(() => assertNotMistypedCommand(argv, COMMANDS, VALUE_FLAGS)).not.toThrow();
  });
});
