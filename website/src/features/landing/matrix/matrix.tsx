import { useHydrated } from '@tanstack/react-router';
import { useLayoutEffect, useRef } from 'react';
import type { FocusEvent } from 'react';
import { IMPLEMENTER_JACK_IDS, PLANNER_JACK_IDS, pairingYaml } from './pairings.js';
import type { PairingSelection } from './pairings.js';
import { ConfigOutput } from './config-output.js';
import { MatrixGrid } from './grid.js';
import { MATRIX_DESKTOP_QUERY, useMatrixLayout, useReducedMotion } from './matrix-media.js';
import type { MatrixLayout } from './matrix-media.js';
import { PairingPicker } from './picker.js';
import { usePairingSelection } from './use-pairing-selection.js';
import './matrix.css';

interface LayoutProps {
  readonly selected: PairingSelection;
  readonly onSelect: (selection: PairingSelection) => void;
  readonly layout: MatrixLayout;
}

type MobileFocusSide = 'implementer' | 'planner';

function LayoutFrame({ layout, selected, onSelect }: LayoutProps) {
  return (
    <div className={`matrix__${layout}`} data-matrix-layout={layout}>
      {layout === 'desktop' ? (
        <MatrixGrid onSelect={onSelect} selected={selected} />
      ) : (
        <PairingPicker onSelect={onSelect} selected={selected} />
      )}
    </div>
  );
}

function mobileFocusSide(element: HTMLElement): MobileFocusSide | null {
  if (!element.matches('.pairing-picker__input')) return null;
  const side = element.dataset.jackSide;
  return side === 'planner' || side === 'implementer' ? side : null;
}

function focusSelectedControl(
  root: HTMLElement,
  layout: MatrixLayout,
  mobileSide: MobileFocusSide,
): void {
  const selector =
    layout === 'desktop'
      ? '[role="gridcell"][aria-selected="true"]'
      : `.pairing-picker__input[data-jack-side="${mobileSide}"]:checked`;
  const control = root.querySelector(selector);
  if (control instanceof HTMLElement) control.focus();
}

function matrixLayoutForViewport(): MatrixLayout {
  return window.matchMedia(MATRIX_DESKTOP_QUERY).matches ? 'desktop' : 'mobile';
}

export function PairingMatrix() {
  const hydrated = useHydrated();
  const layout = useMatrixLayout();
  const reducedMotion = useReducedMotion();
  const { announcement, output, pulse, select, selected } = usePairingSelection({
    reducedMotion,
  });
  const controlsRef = useRef<HTMLDivElement>(null);
  const focusedSideRef = useRef<MobileFocusSide | null>(null);
  const preferredMobileSideRef = useRef<MobileFocusSide>('planner');

  function handleFocusCapture(event: FocusEvent<HTMLDivElement>): void {
    if (!(event.target instanceof HTMLElement)) return;

    if (event.target.matches('[role="gridcell"]')) {
      focusedSideRef.current = preferredMobileSideRef.current;
      return;
    }

    const mobileSide = mobileFocusSide(event.target);
    focusedSideRef.current = mobileSide;
    if (mobileSide) preferredMobileSideRef.current = mobileSide;
  }

  function handleBlurCapture(event: FocusEvent<HTMLDivElement>): void {
    const controls = event.currentTarget;
    if (event.relatedTarget instanceof Node && controls.contains(event.relatedTarget)) return;

    if (event.relatedTarget && event.relatedTarget !== document.body) {
      focusedSideRef.current = null;
      return;
    }

    const renderedLayout =
      event.target.closest<HTMLElement>('[data-matrix-layout]')?.dataset.matrixLayout;
    if (
      (renderedLayout === 'desktop' || renderedLayout === 'mobile') &&
      renderedLayout !== matrixLayoutForViewport()
    ) {
      return;
    }

    queueMicrotask(() => {
      if (!controls.contains(document.activeElement)) focusedSideRef.current = null;
    });
  }

  useLayoutEffect(() => {
    if (layout === 'prerender') return;

    const root = controlsRef.current?.querySelector<HTMLElement>(
      `[data-matrix-layout="${layout}"]`,
    );
    const focusedSide = focusedSideRef.current;
    if (!root || !focusedSide) return;

    const activeElement = document.activeElement;
    if (
      activeElement instanceof Node &&
      activeElement !== document.body &&
      !root.contains(activeElement)
    ) {
      focusedSideRef.current = null;
      return;
    }

    focusSelectedControl(root, layout, focusedSide);
  }, [layout]);

  const activeRowIndex = PLANNER_JACK_IDS.indexOf(selected.plannerId);
  const activeColumnIndex = IMPLEMENTER_JACK_IDS.indexOf(selected.implementerId);
  const layoutProps = { selected, onSelect: select };

  return (
    <section className="matrix" aria-label="Planner and implementer pairing">
      <div
        className="matrix__controls"
        data-active-column-index={activeColumnIndex}
        data-active-row-index={activeRowIndex}
        data-pulse={pulse ? 'active' : undefined}
        data-pulse-variant={pulse ? (pulse.revision % 2 === 0 ? 'a' : 'b') : undefined}
        inert={!hydrated}
        onBlurCapture={handleBlurCapture}
        onFocusCapture={handleFocusCapture}
        ref={controlsRef}
      >
        {layout === 'prerender' ? (
          <div className="matrix__prerender" data-matrix-prerender="">
            <LayoutFrame {...layoutProps} layout="desktop" />
            <LayoutFrame {...layoutProps} layout="mobile" />
          </div>
        ) : (
          <LayoutFrame {...layoutProps} layout={layout} />
        )}
      </div>

      <ConfigOutput
        key={`${output.plannerId}:${output.implementerId}`}
        yaml={pairingYaml(output)}
      />

      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </section>
  );
}
