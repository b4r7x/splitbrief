import { createElement, useRef } from 'react';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { useCompletionNavigation } from './use-completion-navigation.js';

const ENTER = '\r';
const UP = '\x1b[A';

interface Snapshot {
  hasItems: boolean;
}

function Harness(props: {
  hasItems: boolean;
  onSelect: (l: Snapshot) => void;
  onReturn?: ((l: Snapshot) => void) | undefined;
  onMove?: ((l: Snapshot, dir: -1 | 1) => void) | undefined;
}) {
  const latestRef = useRef<Snapshot | null>({ hasItems: props.hasItems });
  latestRef.current = { hasItems: props.hasItems };
  useCompletionNavigation<Snapshot>({
    isActive: true,
    latestRef,
    hasItems: (l) => l.hasItems,
    onMove: props.onMove ?? (() => {}),
    onSelect: props.onSelect,
    onEscape: () => {},
    ...(props.onReturn ? { onReturn: props.onReturn } : {}),
  });
  return createElement(Text, null, 'x');
}

describe('useCompletionNavigation', () => {
  it('invokes onReturn on Enter even when there are no items', async () => {
    const onReturn = vi.fn();
    const onSelect = vi.fn();
    const ui = renderFeature(createElement(Harness, { hasItems: false, onReturn, onSelect }));

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);

    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('does not move or select while there are no items', async () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const ui = renderFeature(createElement(Harness, { hasItems: false, onMove, onSelect }));

    await flushEffects();
    ui.stdin.write(UP);
    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);

    expect(onMove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('falls back to onSelect for Enter when no onReturn is provided and items exist', async () => {
    const onSelect = vi.fn();
    const ui = renderFeature(createElement(Harness, { hasItems: true, onSelect }));

    await flushEffects();
    ui.stdin.write(ENTER);
    await tick(20);

    expect(onSelect).toHaveBeenCalledTimes(1);
    ui.unmount();
  });
});
