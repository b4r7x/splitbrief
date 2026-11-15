import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import { isApiProviderId, type ApiProviderId } from '../../../core/providers/api-catalog.js';
import type { ClaudeCodeModelOption } from '../../../core/providers/claude-code-options.js';
import { type KnownModel, KNOWN_MODELS } from '../../../core/providers/known-models.js';
import { CLI_TOOL_IDS } from '../../../core/runners/cli-tool/catalog.js';
import type { CliToolId } from '../../../core/runners/cli-tool/types.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { ProviderId, RunnerKind } from '../../../core/schemas/enums.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import { includes } from '../../../utils/type-guards.js';
import type { ScopedCliCatalogRuntime } from '../../detection/cli-catalog-outcomes.js';
import type { ConfiguredProviderRuntime } from '../../detection/provider-outcomes.js';

export interface ModelCacheAccessor {
  getModelsDevCatalog(): ModelsDevCatalog | null;
  /**
   * Remembered provider rows. `kind` names the caller's runner kind, so an API
   * runner whose name is also a CLI tool id never reads the CLI catalog lane;
   * absent keeps the legacy name-only lookup.
   */
  getProviderModels(providerId: ProviderId, kind?: RunnerKind): readonly DetectedModel[] | null;
  /** Staleness of the generic memory backing getProviderModels (remembered rows). */
  isProviderModelCacheStale?(providerId: ProviderId, kind?: RunnerKind): boolean;
  /**
   * Current role-scoped API membership. When present, this is authoritative
   * for API model lookup and prevents ambiguous generic reuse.
   */
  getScopedProviderRuntime?(
    input: Readonly<{ role: ActiveRunnerRole; provider: ApiProviderId }>,
  ): ConfiguredProviderRuntime | null | undefined;
  /** Exact tool/context CLI membership; null is authoritative absence. */
  getCliCatalogRuntime?(
    input: Readonly<{ tool: CliToolId }>,
  ): ScopedCliCatalogRuntime | null | undefined;
  /** Claude Code's local `~/.claude.json` option cache; absent means no options. */
  getClaudeCodeModelOptions?(): readonly ClaudeCodeModelOption[];
}

export const NULL_CACHE: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

export interface RuntimeModelSnapshot {
  readonly providerId: ProviderId;
  readonly entries: readonly DetectedModel[];
  readonly isStale: boolean;
}

export function getBundledModels(providerId: ProviderId): readonly KnownModel[] {
  return KNOWN_MODELS[providerId] ?? [];
}

function scopedRuntimeProvider(providerId: ProviderId): ApiProviderId | null {
  return isApiProviderId(providerId) ? providerId : null;
}

function scopedCliTool(providerId: ProviderId, kind?: RunnerKind): CliToolId | null {
  // An `api` runner reads API lanes only: `provider: opencode` is a custom HTTP
  // endpoint that reuses the tool's name, never the local OpenCode CLI catalog.
  if (kind === 'api') return null;
  return includes(CLI_TOOL_IDS, providerId) ? providerId : null;
}

/**
 * Resolves a role-scoped runtime snapshot when the cache can provide one.
 * `undefined` means a non-API runner or legacy cache. `null` is an
 * authoritative scoped absence, while an existing empty/failed record is also
 * authoritative and cannot fall back to generic provider memory.
 */
export function getScopedRuntimeSnapshot(
  input: Readonly<{
    providerId: ProviderId;
    role?: ActiveRunnerRole | undefined;
    cache: ModelCacheAccessor;
    kind?: RunnerKind | undefined;
  }>,
): RuntimeModelSnapshot | undefined {
  if (input.role === undefined) return undefined;
  const cliTool = scopedCliTool(input.providerId, input.kind);
  if (cliTool !== null && input.cache.getCliCatalogRuntime !== undefined) {
    const runtime = input.cache.getCliCatalogRuntime({ tool: cliTool });
    if (runtime === undefined) return undefined;
    return {
      providerId: cliTool,
      entries: runtime?.models ?? [],
      isStale: runtime?.state === 'stale',
    };
  }
  if (input.cache.getScopedProviderRuntime === undefined) return undefined;
  const provider = scopedRuntimeProvider(input.providerId);
  if (provider === null) return undefined;
  const runtime = input.cache.getScopedProviderRuntime({ role: input.role, provider });
  if (runtime === undefined) return undefined;
  return {
    providerId: provider,
    entries: runtime?.models ?? [],
    isStale: runtime?.state === 'stale',
  };
}

export function getRuntimeModelSnapshot(
  input: Readonly<{
    providerId: ProviderId;
    role?: ActiveRunnerRole | undefined;
    cache: ModelCacheAccessor;
    kind?: RunnerKind | undefined;
  }>,
): RuntimeModelSnapshot | null {
  const scoped = getScopedRuntimeSnapshot(input);
  if (scoped !== undefined) return scoped;
  const runtimeProviderId = input.providerId;
  const entries = input.cache.getProviderModels(runtimeProviderId, input.kind);
  if (entries === null) return null;
  return {
    providerId: runtimeProviderId,
    entries,
    isStale: input.cache.isProviderModelCacheStale?.(runtimeProviderId, input.kind) ?? false,
  };
}
