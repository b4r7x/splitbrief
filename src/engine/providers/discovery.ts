import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-config.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import { hasNativeCliCatalog, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { throwIfAborted } from '../../utils/abort.js';
import { detectRunnerEvidence, type DetectRunnerEvidenceOptions } from '../detection/detect.js';
import {
  scopedCliCatalogConnection,
  type ScopedCliCatalogAttempt,
} from '../detection/cli-catalog-outcomes.js';
import type { CliExecutableResolver } from '../runners/resolve-cli-executable.js';

type NativeCatalogContext = RunnerDiscoveryContext &
  Readonly<{
    kind: 'cli';
    id: CliToolId;
  }>;
function isNativeCatalogContext(context: RunnerDiscoveryContext): context is NativeCatalogContext {
  return context.kind === 'cli' && hasNativeCliCatalog(context.id);
}

/**
 * The native CLI catalog lane is only a context-bound adapter over canonical
 * runner evidence. It deliberately owns no executable lookup, subprocess,
 * sandbox, version decision, cancellation policy, or parser execution.
 */
export interface DiscoverAllCliToolsOptions {
  readonly contexts: readonly RunnerDiscoveryContext[];
  readonly projectDir: string;
  readonly refresh?: 'automatic' | 'manual' | undefined;
  readonly signal?: AbortSignal | undefined;
  /** A test resolver may choose a real receipt; detector-owned readiness remains canonical. */
  readonly resolveExecutable?: CliExecutableResolver | undefined;
  readonly now?: (() => number) | undefined;
}

function detectorOptions(
  input: Readonly<{
    context: NativeCatalogContext;
    options: DiscoverAllCliToolsOptions;
    onResolvedCliExecutable: (executable: CliExecutableIdentity) => void;
  }>,
): DetectRunnerEvidenceOptions {
  return {
    context: input.context,
    projectDir: input.options.projectDir,
    includeCatalog: true,
    catalogRefresh: input.options.refresh ?? 'automatic',
    onResolvedCliExecutable: input.onResolvedCliExecutable,
    ...(input.options.resolveExecutable === undefined
      ? {}
      : { resolveExecutable: input.options.resolveExecutable }),
    ...(input.options.now === undefined ? {} : { now: input.options.now }),
    ...(input.options.signal === undefined ? {} : { signal: input.options.signal }),
  };
}

export async function discoverAllCliTools(
  options: DiscoverAllCliToolsOptions,
): Promise<readonly ScopedCliCatalogAttempt[]> {
  throwIfAborted(options.signal);
  const contexts = options.contexts.filter(isNativeCatalogContext);
  const attempts = await Promise.all(
    contexts.map(async (context): Promise<ScopedCliCatalogAttempt> => {
      let executable: CliExecutableIdentity | undefined;
      const evidence = await detectRunnerEvidence(
        detectorOptions({
          context,
          options,
          onResolvedCliExecutable: (resolved) => {
            executable = resolved;
          },
        }),
      );
      return {
        connection: scopedCliCatalogConnection({
          role: context.role,
          tool: context.id,
          runnerContextKey: evidence.context.key,
          ...(executable === undefined ? {} : { executable }),
        }),
        outcome: evidence.catalog,
      };
    }),
  );
  throwIfAborted(options.signal);
  return attempts;
}
