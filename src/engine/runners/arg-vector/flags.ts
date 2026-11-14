import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import { assertNever } from '../../../utils/type-guards.js';
import { lookupCliImplementerAdapter, lookupCliPlannerAdapter } from '../cli-tools/registry.js';
import type { CliArgumentValidation } from '../cli-tools/validate-args.js';

const LONG_FLAG_PATTERN = /--[a-z0-9][a-z0-9-]*/gi;
const SHORT_FLAG_PATTERN = /(?<![\w-])-[a-z](?![\w-])/gi;
const EMITTED_LONG_FLAG_PATTERN = /^--[a-z0-9][a-z0-9-]*/i;
const EMITTED_SHORT_FLAG_PATTERN = /^-[a-z]$/i;
export const OPTION_ENTRY_PATTERN = /^\s*--?[a-z0-9]/i;
export const OPTION_TOKEN_PATTERN = /^[-<[]/;
export const SUBCOMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PREFLIGHT_SESSION_ID = '00000000-0000-4000-8000-000000000000';

export type FlagFamily = Readonly<{
  emitted: RegExp;
  advertised: RegExp;
  foldCase: boolean;
  bareToken: boolean;
}>;

/**
 * Long flags are lowercase by convention and a help text may spell one in any
 * case, so that family folds case. Short-flag case is load-bearing — codex
 * advertises `-c, --config` and `-C, --cd` as two different flags — so that
 * family is compared verbatim. Neither family reads a bare `-<digit>`: that is
 * a configured value (`--max-turns -1`), not a flag.
 *
 * A short flag is a bare token: the same two characters read as prose inside a
 * description — codex's own `--enable` entry says "Equivalent to `-c
 * features.<name>=true`" — and as a configured value (`--title -x`). That
 * family therefore takes its advertised set from option-entry lines only and
 * skips an argv element whose predecessor is itself a flag. A `--long` token
 * names itself in both positions, so that family reads the whole help text and
 * every argv element.
 *
 * That skip cannot tell a value from a short flag that follows a boolean one, and
 * it under-checks rather than fabricating a blocker on a vector the binary accepts:
 * an adapter whose short flag must be compared places it at the head of its vector
 * or after a flag's value, never directly after another flag.
 */
export const FLAG_FAMILIES: readonly FlagFamily[] = Object.freeze([
  {
    emitted: EMITTED_LONG_FLAG_PATTERN,
    advertised: LONG_FLAG_PATTERN,
    foldCase: true,
    bareToken: false,
  },
  {
    emitted: EMITTED_SHORT_FLAG_PATTERN,
    advertised: SHORT_FLAG_PATTERN,
    foldCase: false,
    bareToken: true,
  },
]);

/** A flag the adapter emits: a leading long flag, or a lone short one carrying its value next. */
export function emittedFlags(argv: readonly string[], family: FlagFamily): string[] {
  const flags: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    const previous = argv[index - 1];
    if (family.bareToken && previous?.startsWith('-')) continue;
    const match = family.emitted.exec(arg);
    if (match !== null) flags.push(normalizeFlag(match[0], family));
  }
  return flags;
}

export function normalizeFlag(flag: string, family: FlagFamily): string {
  return family.foldCase ? flag.toLowerCase() : flag;
}

export type PreflightRunner = Readonly<{
  tool: CliToolId;
  role: ActiveRunnerRole;
  /** The seat word the report names this runner by. */
  seat: string;
  model: string | undefined;
  args: readonly string[] | undefined;
  effort: EffortLevel | undefined;
  variant: string | undefined;
  installedVersion: string | undefined;
}>;

/**
 * One arg vector per branch the adapter can take for this role, so a flag that
 * only appears on resume or on a fresh planner call is compared too. The
 * planner's `effort` is configuration rather than a branch, so it rides on every
 * variant whenever the adapter supports it. The review seat takes exactly one
 * branch — a fresh read-only call — so resume argv is not its to compare.
 */
type PreflightVector = Readonly<{ argv: readonly string[]; validation: CliArgumentValidation }>;

function checkedVector<Input>(
  adapter: Readonly<{
    buildArgs: (input: Input) => readonly string[];
    baseArgs: (input: Input) => readonly string[];
    validateArgs: (input: {
      invocationArgs: readonly string[];
      baseArgs: readonly string[];
    }) => CliArgumentValidation;
  }>,
  input: Input,
): PreflightVector {
  const argv = adapter.buildArgs(input);
  return {
    argv,
    validation: adapter.validateArgs({ invocationArgs: argv, baseArgs: adapter.baseArgs(input) }),
  };
}

export function emittedArgVectors(
  runner: PreflightRunner,
  projectDir: string,
): readonly PreflightVector[] {
  switch (runner.role) {
    case 'implementer':
      return [
        checkedVector(lookupCliImplementerAdapter(runner.tool), {
          model: runner.model,
          projectDir,
          configuredArgs: runner.args ?? [],
          effort: runner.effort,
          variant: runner.variant,
          installedVersion: runner.installedVersion,
        }),
      ];
    case 'reviewer': {
      const adapter = lookupCliPlannerAdapter(runner.tool);
      return [
        checkedVector(adapter, {
          ...plannerCommonArgs(runner, adapter, projectDir),
          sessionId: null,
        }),
      ];
    }
    case 'planner': {
      const adapter = lookupCliPlannerAdapter(runner.tool);
      const common = plannerCommonArgs(runner, adapter, projectDir);
      const variants = [checkedVector(adapter, { ...common, sessionId: null })];
      if (adapter.supportsSessionResume) {
        variants.push(checkedVector(adapter, { ...common, sessionId: PREFLIGHT_SESSION_ID }));
      }
      const seen = new Set<string>();
      return variants.filter(({ argv }) => {
        const key = argv.join(' ');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    default:
      return assertNever(runner.role);
  }
}

function plannerCommonArgs(
  runner: PreflightRunner,
  adapter: Readonly<{ supportsEffort: boolean }>,
  projectDir: string,
) {
  return {
    model: runner.model,
    projectDir,
    configuredArgs: runner.args ?? [],
    effort: adapter.supportsEffort ? runner.effort : undefined,
    variant: runner.variant,
    installedVersion: runner.installedVersion,
  };
}
