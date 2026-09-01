/**
 * One authoritative lane per runner renders rows; models.dev is metadata-only
 * enrichment where a native lane exists (REQ-010/011).
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
      modelsDev: true,
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
  if (discoveryMode === 'static-catalog-unverified') {
    return { modelsDev: false, bundled: true, claudeCodeOptions: false };
  }
  if (discoveryMode !== undefined) {
    return {
      modelsDev: !input.hasRuntimeList,
      bundled: !input.hasRuntimeList,
      claudeCodeOptions: false,
    };
  }

  return { modelsDev: true, bundled: !input.hasRuntimeList, claudeCodeOptions: false };
}
