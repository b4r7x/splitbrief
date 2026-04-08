import { createContext, useContext, type ReactNode } from 'react';
import type { TwoColumnNavState } from './use-two-column-state.js';
import type { FilterableItem } from '../../../ui/picker-utils.js';

export interface TwoColumnLayout {
  cols: number;
  rows: number;
  totalBoxWidth: number;
  columnContentWidth: number;
  columnHeight: number;
  maxVisible: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TwoColumnPickerCtx<L = any, R extends { id: string } = any> {
  nav: TwoColumnNavState<L, R>;
  layout: TwoColumnLayout;
  leftGetKey: (item: L) => string;
  rightGetKey: (item: R) => string;
  selectedLeftKey: string | null;
  specialHelp?: ReactNode;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TwoColumnPickerContext = createContext<TwoColumnPickerCtx<any, any> | null>(null);

export function useTwoColumnPickerCtx<L extends FilterableItem, R extends { id: string }>(): TwoColumnPickerCtx<L, R> {
  const ctx = useContext(TwoColumnPickerContext);
  if (!ctx) throw new Error('TwoColumnPicker subcomponents must be used inside <TwoColumnPicker>');
  return ctx as TwoColumnPickerCtx<L, R>;
}
