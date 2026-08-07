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
  'stats',
  'export',
  'explain',
  'resume',
  'handoff',
  'snapshot',
  'approval',
  'mcp',
  'worktree',
  'attach',
  'detach',
  'ps',
  'continue',
  'last',
];

const ESCAPE = String.fromCharCode(27);

function captureThrown(argv: string[]): unknown {
  try {
    assertNotMistypedCommand(argv, COMMANDS);
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
    { argv: ['wroktree'], suggestion: 'worktree' },
    { argv: ['doctro', '--json'], suggestion: 'doctor' },
    { argv: ['spce', '--mode', 'quick'], suggestion: 'spec' },
  ])('rejects $argv suggesting $suggestion', ({ argv, suggestion }) => {
    const captured = captureThrown(argv);

    expect(isCliError(captured)).toBe(true);
    expect(messageOf(captured)).toContain(`did you mean '${suggestion}'?`);
  });

  it('breaks a tie by help order: statsu is one edit from both status and stats', () => {
    const captured = captureThrown(['statsu']);

    expect(isCliError(captured)).toBe(true);
    expect(messageOf(captured)).toContain("did you mean 'status'?");
  });

  it('strips terminal control bytes out of the token it echoes back', () => {
    const captured = captureThrown([`docto${ESCAPE}`]);

    expect(isCliError(captured)).toBe(true);
    expect(messageOf(captured)).toContain("did you mean 'doctor'?");
    expect(messageOf(captured)).not.toContain(ESCAPE);
  });
});

describe('assertNotMistypedCommand leaves real invocations alone', () => {
  it.each([
    { label: 'no arguments', argv: [] },
    { label: 'a registered command', argv: ['doctor'] },
    { label: 'a registered command with flags', argv: ['ps', '--prune'] },
    { label: 'a leading flag', argv: ['--help'] },
    { label: 'a quoted multi-word feature', argv: ['fix the typo'] },
    { label: 'an unquoted multi-word feature', argv: ['fix', 'the', 'typo'] },
    { label: 'a feature plus file operands', argv: ['add caching', 'src/cache.ts'] },
    { label: 'a one-word feature far from every command', argv: ['refactor'] },
    { label: 'a one-word feature two edits from a short command', argv: ['test'] },
    { label: 'the explicit start escape hatch', argv: ['start', 'doctro'] },
  ])('admits $label', ({ argv }) => {
    expect(() => assertNotMistypedCommand(argv, COMMANDS)).not.toThrow();
  });
});
