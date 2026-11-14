import type { RunnerDiscoveryContext } from '../../../core/config/accessors/runner-discovery-context.js';
import type { CliExecutableIdentity } from '../../../core/discovery/detection/executable.js';
import type { RunnerEvidence } from '../../../core/discovery/runner-evidence.js';
import type { CliExecutableResolver } from '../../runners/cli-executable/types.js';
import type {
  probeDeclaredCliReadinessEvidence,
  VersionProbeReads,
} from '../../runners/cli-tools/probe/declared-readiness.js';
import type { lookupCliReadinessProbe } from '../../runners/cli-tools/registry.js';

type ResolveCliExecutable = CliExecutableResolver;
export type ProbeDeclaredCliReadinessEvidence = typeof probeDeclaredCliReadinessEvidence;
type LookupCliReadinessProbe = typeof lookupCliReadinessProbe;

export type RunnerEvidenceBase = Pick<
  RunnerEvidence,
  'runner' | 'context' | 'endpoint' | 'catalog' | 'modelRun'
>;

export interface DetectRunnerEvidenceOptions {
  context: RunnerDiscoveryContext;
  projectDir?: string | undefined;
  /** A test resolver may select only a real receipt; catalog work revalidates it before every run. */
  resolveExecutable?: ResolveCliExecutable | undefined;
  /** Readiness-only test seam. It is ignored whenever catalog discovery is requested. */
  lookupProbe?: LookupCliReadinessProbe | undefined;
  /** Readiness-only test seam. It is ignored whenever catalog discovery is requested. */
  probeDeclaredReadiness?: ProbeDeclaredCliReadinessEvidence | undefined;
  includeCatalog?: boolean | undefined;
  catalogRefresh?: 'automatic' | 'manual' | undefined;
  /**
   * The model list names `projectDir`, so it carries the providers the project's
   * own tool config sets up. OpenCode loads that config, its plugins and its MCP
   * servers to answer, so only a read for a tool the crew uses sets it.
   */
  catalogNamesProject?: boolean | undefined;
  /** Observation-only catalog attribution handoff; receives an immutable receipt snapshot. */
  onResolvedCliExecutable?: ((executable: CliExecutableIdentity) => void) | undefined;
  /** The version checks one preparation already ran; a read of the same executable reuses them. */
  versionProbes?: VersionProbeReads | undefined;
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}
