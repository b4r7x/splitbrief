import type { Config } from '../../../../core/schemas/config.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import type { DiscoveredValidation } from '../../../../core/schemas/workflow/state.js';
import type { ManifestCommands } from '../../../../core/validation/manifest-commands.js';
import type { Stack } from '../../../../core/validation/stacks/types.js';
import { resolveTestCommand } from '../../../../core/validation/stage-command.js';
import { isTestPatternSafe } from '../../../../core/validation/test-discovery.js';
import type { EventBus } from '../../../events/types.js';
import { publishWarning } from '../../publish/notice.js';
import { formatValidationCommand } from '../commands.js';
import { unsafeCommandReason } from './command.js';

const REFUSED_WARNING = {
  category: 'validation',
  code: 'discovered_validation_refused',
} as const;

/** Why a test file pattern is refused, in the words of the rule it broke. */
function testPatternRefusal(pattern: string): string {
  return pattern.includes('..') ? 'it contains ".."' : 'it contains a path separator';
}

type TestResolutionContext = {
  projectDir: string;
  config: Config;
  manifest: ManifestCommands;
  stack: Stack | null;
};

export function sanitizeDiscoveredValidation(
  discovered: DiscoveredValidation | null | undefined,
  notices: { bus: EventBus; phase: Phase },
  resolution?: TestResolutionContext,
): DiscoveredValidation | undefined {
  if (!discovered) return undefined;

  const refuse = (message: string) =>
    publishWarning({
      bus: notices.bus,
      phase: notices.phase,
      message,
      safety: REFUSED_WARNING,
    });
  const sanitized: DiscoveredValidation = {};

  if (discovered.language) sanitized.language = discovered.language;
  if (discovered.testPattern) {
    if (isTestPatternSafe(discovered.testPattern)) {
      sanitized.testPattern = discovered.testPattern;
    } else {
      refuse(
        `The test checks do not take the file pattern ${discovered.testPattern} from the plan: ${testPatternRefusal(discovered.testPattern)}. They use config or the stack's test file patterns.`,
      );
    }
  }

  const value = discovered.testCommand;
  if (value) {
    const refusal = unsafeCommandReason(value);
    // A refusal empties only the discovered rung: config and the manifest outrank it and
    // the stack default follows it, so a test check may still run this very command.
    const resolved =
      refusal === null || resolution === undefined
        ? null
        : resolveTestCommand({ ...resolution, discovered: undefined });
    if (refusal === null) {
      sanitized.testCommand = value;
    } else if (
      resolved === null ||
      formatValidationCommand(resolved.cmd, resolved.args) !== value
    ) {
      refuse(
        `The test checks do not take ${value} from the plan: it ${refusal}. They use config, the manifest or the stack default.`,
      );
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
