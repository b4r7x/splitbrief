/**
 * One authoritative lane per runner renders rows; models.dev rows exist for
 * `api` providers only — a CLI tool's rows come from its own listing, its
 * bundled table, and (claude-code) its account options (REQ-B08).
 */
import { CLI_TOOL_CATALOG, isCliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { ProviderId } from '../../../core/schemas/enums.js';

export interface ModelRowLanes {
  /** models.dev entries may become rows. */
  readonly modelsDev: boolean;
  /** KNOWN_MODELS entries may become rows. */
  readonly bundled: boolean;
  /** `~/.claude.json` `additionalModelOptionsCache` entries may become rows. */
  readonly claudeCodeOptions: boolean;
}

export function modelRowLanes(
  input: Readonly<{
    providerId: ProviderId;
    /**
     * A native list exists for this runner — confirmed live, or remembered and
     * stale. A remembered exact list is still the authority, so a failed refresh
     * must not flood it with speculative rows that churn away on the next probe.
     */
    hasRuntimeList: boolean;
    browseCatalog?: boolean | undefined;
  }>,
): ModelRowLanes {
  if (input.browseCatalog === true) {
    return {
      modelsDev: !isCliToolId(input.providerId),
      bundled: !input.hasRuntimeList,
      claudeCodeOptions: input.providerId === 'claude-code',
    };
  }

  const discoveryMode = isCliToolId(input.providerId)
    ? CLI_TOOL_CATALOG[input.providerId].modelDiscoveryMode
    : undefined;

  if (discoveryMode === 'native-aliases-and-custom') {
    return { modelsDev: false, bundled: true, claudeCodeOptions: true };
  }
  if (discoveryMode !== undefined) {
    return {
      modelsDev: false,
      bundled: !input.hasRuntimeList,
      claudeCodeOptions: false,
    };
  }

  return { modelsDev: true, bundled: !input.hasRuntimeList, claudeCodeOptions: false };
}
