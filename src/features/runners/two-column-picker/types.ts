import type { ReactNode } from 'react';
import type { RightItemOrVirtual } from './virtual-items.js';

/**
 * A left row that answers for itself: the right column becomes a read-only card
 * and Enter commits the row instead of advancing into an empty model column.
 */
export interface TerminalPane {
  label: string;
  /** The verb the hint promises for Enter on this row. */
  verb: string;
  lines: string[];
}

/** What Enter does on the highlighted right row. */
export type RightActivation = 'confirm' | 'expand' | 'collapse' | 'refresh' | 'none';

/**
 * What a right row does with a value-stepping gesture. `stepped` marks the row as
 * the value control: it takes the space key, and a click on it steps instead of
 * activating. `held` takes the key without owning the click, which is how a row
 * inside an expansion refuses to collapse it.
 */
export type CycleOutcome = 'stepped' | 'held' | 'none';

export interface RightSectionProps<R> {
  by: (item: R) => string;
  headerFor?: ((section: string) => boolean) | undefined;
}

export interface LeftRowMeta {
  isCursor: boolean;
  isSelected: boolean;
  /** The left row the right column is showing while the cursor sits in it. */
  isContext: boolean;
  maxWidth: number;
}

export interface LeftColumnProps<L> {
  items: L[];
  label?: string | undefined;
  filterBy?: ((item: L, query: string) => boolean) | undefined;
  renderRow: (item: L, meta: LeftRowMeta) => ReactNode;
  getKey: (item: L) => string;
  terminalPane?: ((item: L) => TerminalPane | undefined) | undefined;
  isDisabled?: ((item: L) => boolean) | undefined;
  initialIndex?: number | undefined;
  compare?: ((a: L, b: L) => number) | undefined;
}

export interface CustomRowOptions<L, R> {
  onSelect: (left: L) => void;
  isCustom?: ((item: R) => boolean) | undefined;
  onDelete?: ((item: R) => void) | undefined;
}

export interface RightColumnProps<L, R> {
  items: R[];
  label?: string | undefined;
  filterBy?: ((item: R, query: string) => boolean) | undefined;
  renderRow: (item: R, meta: { isCursor: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: R) => string;
  placeholder?: ReactNode | undefined;
  customRow?: CustomRowOptions<L, R> | undefined;
  onLeftChange?: ((item: L) => void) | undefined;
  /** Index into `items`; the display offset for pinned virtual rows is added here. */
  initialIndex?: number | undefined;
  resolveInitialIndex?: ((left: L | undefined) => number | undefined) | undefined;
  section?: RightSectionProps<R> | undefined;
  activationOf?: ((item: R) => RightActivation) | undefined;
  onExpand?: ((item: R) => void) | undefined;
  onCollapse?: (() => void) | undefined;
  onCycle?: ((item: R) => CycleOutcome) | undefined;
  isExpanded?: boolean | undefined;
  /** Replaces the expanded-column Enter verb for the highlighted row (`⏎ choose route` otherwise). */
  expandedHint?: ((item: R | undefined) => string | undefined) | undefined;
}

export interface ColumnState<T> {
  filter: string;
  items: T[];
  index: number;
  currentItem: T | undefined;
}

export interface TwoColumnNavState<L, R> {
  activeColumn: 'left' | 'right';
  left: ColumnState<L>;
  right: ColumnState<RightItemOrVirtual<R>>;
  selectedLeftKey: string | null;
  terminalPane: TerminalPane | undefined;
  isOnCustomItem: boolean;
  currentRightIsCustom: boolean;
  activateLeft: (index: number) => void;
  activateRight: (index: number) => void;
  cycleRight: (index: number) => CycleOutcome;
}
