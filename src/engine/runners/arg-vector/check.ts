import { advertisedFlags, deprecatedFlags } from './help-text.js';
import { FLAG_FAMILIES, type FlagFamily, emittedFlags } from './flags.js';

export type ArgVectorPreflightOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; unsupported: string[]; deprecated: string[] }>;

/**
 * Compares the arg vector SPLITBRIEF would emit for a runner against the
 * flags the installed binary's own help text advertises. A flag the help does
 * not mention at all is reported as unsupported; a flag whose help entry is
 * marked deprecated is reported separately and does not block.
 *
 * Short flags are compared alongside long ones: codex delivers the seat's
 * reasoning effort as `-c model_reasoning_effort=<level>`, so a long-flag-only
 * comparison would leave that tool's whole effort channel unchecked. The
 * `key=value` payload is not compared — no admitted tool's help enumerates the
 * config keys it accepts, and codex parses the value as TOML at run time.
 *
 * The comparison is conservative on purpose, per family: a help text that
 * carries no recognisable flag of one shape (terse or unparsable output)
 * reports ok for that shape rather than fabricating blockers from missing
 * negative evidence.
 */
export function checkRunnerArgVector(input: {
  argv: readonly string[];
  helpText: string;
}): ArgVectorPreflightOutcome {
  const families = FLAG_FAMILIES.map((family) => compareFlagFamily(input, family));
  const unsupported = families.flatMap((family) => family.unsupported);
  const deprecated = families.flatMap((family) => family.deprecated);
  if (unsupported.length === 0 && deprecated.length === 0) return { ok: true };
  return { ok: false, unsupported, deprecated };
}

function compareFlagFamily(
  input: Readonly<{ argv: readonly string[]; helpText: string }>,
  family: FlagFamily,
): { unsupported: string[]; deprecated: string[] } {
  const emitted = emittedFlags(input.argv, family);
  const advertised = advertisedFlags(input.helpText, family);
  if (emitted.length === 0 || advertised.size === 0) return { unsupported: [], deprecated: [] };
  return {
    unsupported: emitted.filter((flag) => !advertised.has(flag)),
    deprecated: deprecatedFlags(
      input.helpText,
      emitted.filter((flag) => advertised.has(flag)),
      family,
    ),
  };
}
