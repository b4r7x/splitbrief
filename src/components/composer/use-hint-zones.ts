import { useEffect } from 'react';
import { registerMouseZone } from '../../lib/terminal/mouse-zones.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import {
  compactComposerHints,
  composerHintZoneRects,
  computeComposerHintBudget,
  type ComposerHintDisplay,
} from './hint-zones.js';

interface HintZonesBoxHints {
  keys: string;
  cost?: string | undefined;
  costTone?: 'text' | 'warning' | 'error' | undefined;
}

export function useHintZones(opts: {
  boxHints: HintZonesBoxHints | undefined;
  hintBoxWidth: number;
  inputPaddingX: number;
  visibleRows: number;
  rows: number;
  registerHintZones: boolean;
  hintBoxLeft: number;
}): ComposerHintDisplay | null {
  const {
    boxHints,
    hintBoxWidth,
    inputPaddingX,
    visibleRows,
    rows,
    registerHintZones,
    hintBoxLeft,
  } = opts;

  const hintDisplay = boxHints
    ? compactComposerHints(
        { keys: boxHints.keys, cost: boxHints.cost },
        computeComposerHintBudget({ boxWidth: hintBoxWidth, paddingX: inputPaddingX }),
      )
    : null;

  const hintKeys = hintDisplay?.keys;
  const hintCost = hintDisplay?.cost;

  useEffect(() => {
    if (!registerHintZones || hintKeys === undefined) return;
    const hintRow = rows - visibleRows - 1;
    const rects = composerHintZoneRects({
      boxLeft: hintBoxLeft,
      boxWidth: hintBoxWidth,
      hintRow,
      display: { keys: hintKeys, cost: hintCost },
      paddingX: inputPaddingX,
    });
    const disposers = rects.map((rect) =>
      registerMouseZone({
        id: `composer-hint-${rect.id}`,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        z: 5,
        onClick: () => overlayStore.open('cost-drilldown'),
      }),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [
    registerHintZones,
    hintKeys,
    hintCost,
    hintBoxWidth,
    hintBoxLeft,
    inputPaddingX,
    rows,
    visibleRows,
  ]);

  return hintDisplay;
}
