import type { ProvenanceWord } from '../../../core/providers/provenance.js';
import type { RouteAuthState } from '../../../core/runners/route-auth.js';
import type { OptionAxisName } from './option-axis.js';
import type { ModelOption, ModelVariant } from './recency.js';

/**
 * A steppable dimension of an expanded model: spelled by the model id, or by the
 * ladder the tool publishes for it. One vocabulary answers both, so the row model
 * borrows the id parser's names rather than adding one of its own.
 */
export type RightAxisName = OptionAxisName;

export interface TreeLead {
  /** Level 1 = a route, or the axes of a flat option family. Level 2 = the axes under a route. */
  readonly depth: 1 | 2;
  /** Depth 2 only: the level-1 parent above is not last, so its spine continues. */
  readonly parentContinues: boolean;
}

export type RightRow =
  | {
      kind: 'model';
      model: ModelOption;
      provenance: ProvenanceWord;
      section: string;
      expanded: boolean;
    }
  | {
      kind: 'route';
      model: ModelOption;
      variant: ModelVariant;
      auth: RouteAuthState;
      /** Picks the tree glyph that closes the model's route block. */
      last: boolean;
      tree: TreeLead;
    }
  | {
      kind: 'axis';
      model: ModelOption;
      axis: RightAxisName;
      /** The provider route the axis steps inside; empty on an option family. */
      providerPrefix: string;
      value: string;
      /** The ladder this axis steps through; empty when the axis is spelled by the model id. */
      choices: readonly string[];
      /** Whether the ladder has anywhere to step, so no surface promises a key that cannot move. */
      steps: boolean;
      /** Picks the tree glyph that closes the parent's child block. */
      last: boolean;
      tree: TreeLead;
    }
  | { kind: 'action'; action: 'browse-catalog'; text: string };

export type AxisRow = Omit<Extract<RightRow, { kind: 'axis' }>, 'tree'>;

/** Whether the catalog fetch that feeds suggestion rows has landed. */
export type CatalogLane = 'ready' | 'pending' | 'failed';
