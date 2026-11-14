import type { DetectedModel } from '../../../core/discovery/detection/model.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { RunnerKind, ProviderId } from '../../../core/schemas/enums.js';
import type { PricingMode } from '../cost/pricing.js';
import type { ModelCacheAccessor } from './runtime-snapshot.js';

export type ResolvedModelSource =
  | 'models-dev'
  | 'runtime'
  | 'bundled-fallback'
  | 'account-options'
  | 'configured-recovery';

export type ResolvedModelMembership =
  | 'confirmed'
  | 'stale'
  | 'catalog-suggestion'
  | 'bundled-suggestion'
  | 'custom';

export interface ResolveModelCatalogOptions {
  readonly cache?: ModelCacheAccessor | undefined;
  readonly configuredSelectionId?: string | undefined;
  readonly role?: ActiveRunnerRole | undefined;
  readonly browseCatalog?: boolean | undefined;
  /**
   * The asking runner's kind. Kind decides the lane; a CLI-named `api` provider
   * is a custom endpoint with no catalog rows (like any custom name), and a
   * non-CLI-named `cli` tool can never read the API lanes. Absent keeps the
   * legacy name-only behavior.
   */
  readonly kind?: RunnerKind | undefined;
}

export interface ResolvedModelCatalogEntry extends DetectedModel {
  readonly id: string;
  readonly selectionId: string;
  readonly runnerId: ProviderId;
  readonly sourceProviderId: string;
  /** The catalog id a documented alias resolves to; absent when the row's own id already is one. */
  readonly catalogModelId?: string;
  readonly isDefault?: boolean;
  readonly isDetected?: boolean;
  readonly isCustom?: boolean;
  readonly nativeOrder?: number | undefined;
  readonly source: ResolvedModelSource;
  readonly membership: ResolvedModelMembership;
  readonly isStale?: boolean;
  readonly canConfigure: boolean;
  readonly pricingMode: PricingMode;
  /** `nativeReasoningEfforts` is the tool's floor ladder, not one the model published. */
  readonly effortFromFloor?: boolean;
}
