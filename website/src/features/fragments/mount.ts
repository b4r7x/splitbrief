import { createTicker } from '../../lib/ticker';
import {
  CELL,
  type Cell,
  cellRect,
  cells,
  type Field,
  type FieldSpec,
  latticeField,
  relit,
} from '../aura/dots';
import { atRest, pageKeepClear, pageRect } from '../aura/keep-clear';
import {
  footprint,
  type KeepClear,
  type Layer,
  overlaps,
  type Placement,
  placeFragments,
  type Rect,
} from './place';
import { HERO, lower } from './pool';

export type Backdrop = {
  start(): void;
  stop(): void;
};

type Lit = { readonly spec: FieldSpec; readonly cells: readonly Cell[] };
type Painted = Lit & { readonly spans: readonly HTMLElement[] };
type Zone = { readonly rect: Rect; readonly layer: Layer };

const PHONE = 768;
const FADE = { in: 1, out: 2 };
const RATE = 2;
const QUIET = 24;
const CLEAR = 6;
const EDGE = 8;
const INSET = 24;
const SEAM = 48;
const DESK = { anchors: '.marg-list, .seat--implementer, .seat--reviewer', above: 24, below: 110 };
const SKYLINES: readonly { section: string; below: string }[] = [
  { section: '.s02', below: '.tick-list' },
  { section: '.s04', below: '.head' },
];
const SEEDS = { edgeLeft: 64, edgeRight: 32, under: 33, skyline: 40, desk: 50, lower: 8152 };

function box(root: ParentNode, selector: string): Rect | undefined {
  const element = root.querySelector(selector);
  const rect = element ? pageRect(element.getBoundingClientRect()) : undefined;
  return rect && rect.right > rect.left ? rect : undefined;
}

function grow(rect: Rect, by: number): Rect {
  return {
    left: rect.left - by,
    top: rect.top - by,
    right: rect.right + by,
    bottom: rect.bottom + by,
  };
}

function hover(span: HTMLElement, placement: Placement): Animation {
  const { duration, opacity, phase } = placement;
  return span.animate(
    [
      { opacity: 0, offset: 0 },
      { opacity, offset: FADE.in / duration },
      { opacity, offset: 1 - FADE.out / duration },
      { opacity: 0, offset: 1 },
    ],
    {
      duration: duration * 1000,
      delay: -phase * duration * 1000,
      iterations: Number.POSITIVE_INFINITY,
    },
  );
}

// Each hero whisper sits beside the object the reference annotates with it: the strip under the
// nav, the planner's lower half beside the headline's short lines, the implementer's upper half
// and the column under its note, the reviewer under its note, the band under the stage.
function heroZones(content: Rect, top: number): Zone[] {
  const at = (selector: string): Rect | undefined => box(document, selector);
  const steps = at('.hero .steps');
  const claim = at('.hero .claim');
  const headline = at('.hero h1');
  const stage = at('.stage');
  const label = at('.label--planner');
  const planner = at('.ghost--planner');
  const implementer = at('.ghost--implementer');
  const reviewer = at('.ghost--reviewer');
  const implementerNote = at('.seat--implementer');
  const reviewerNote = at('.seat--reviewer');
  if (
    !steps ||
    !claim ||
    !headline ||
    !stage ||
    !label ||
    !planner ||
    !implementer ||
    !reviewer ||
    !implementerNote ||
    !reviewerNote
  )
    return [];
  const rect = (zone: Rect, layer: Layer): Zone => ({ rect: zone, layer });
  return [
    rect(
      { left: steps.right + QUIET, top, right: claim.left - QUIET, bottom: label.top - EDGE },
      HERO.strip,
    ),
    rect(
      {
        left: headline.left,
        top: (planner.top + planner.bottom) / 2,
        right: planner.left,
        bottom: planner.bottom + QUIET,
      },
      HERO.planner,
    ),
    rect(
      {
        left: implementer.right + EDGE,
        top: implementer.top,
        right: content.right,
        bottom: implementerNote.top - EDGE,
      },
      HERO.implementer,
    ),
    rect(
      {
        left: implementer.right + EDGE,
        top: implementerNote.bottom + QUIET,
        right: content.right,
        bottom: reviewerNote.top - QUIET,
      },
      HERO.results,
    ),
    rect(
      {
        left: reviewer.right + EDGE,
        top: reviewerNote.bottom + EDGE,
        right: reviewerNote.right,
        bottom: stage.bottom + 2 * QUIET,
      },
      HERO.reviewer,
    ),
    rect({ ...content, left: stage.left, top: stage.bottom }, HERO.under),
  ];
}

function scene(height: number): { zones: Zone[]; fields: FieldSpec[] } {
  const content = box(document, '.hero');
  const nav = box(document, '.nav');
  if (!content || !nav) return { zones: [], fields: [] };
  const origin = { x: EDGE, y: nav.bottom + QUIET };
  const sections = [...document.querySelectorAll<HTMLElement>('.lower section')];
  const stage = box(document, '.stage');
  const zones: Zone[] = [
    ...heroZones(content, origin.y),
    ...sections.flatMap((section, i) => {
      const grid = box(section, '.grid');
      return grid ? [{ rect: grid, layer: lower(SEEDS.lower + i) }] : [];
    }),
  ];
  const wanted: [Field, Rect | undefined][] = [
    [
      { seed: SEEDS.edgeLeft, profile: 'edge', flip: false, rim: true, level: 1 },
      { left: EDGE, top: origin.y, right: content.left - INSET, bottom: height - EDGE },
    ],
    [
      { seed: SEEDS.edgeRight, profile: 'edge', flip: true, rim: false, level: 0.35 },
      {
        left: content.right + INSET,
        top: origin.y,
        right: document.documentElement.clientWidth - EDGE,
        bottom: height - EDGE,
      },
    ],
    [
      { seed: SEEDS.under, profile: 'ground', flip: false, rim: false, level: 0.9 },
      stage && {
        left: stage.left,
        top: stage.bottom + EDGE,
        right: content.right,
        bottom: content.bottom - EDGE,
      },
    ],
    ...SKYLINES.flatMap(({ section, below }, i): [Field, Rect | undefined][] => {
      const root = document.querySelector(section);
      const head = root && box(root, '.head');
      const from = root && box(root, below);
      if (!root || !head || !from) return [];
      const rect = {
        left: EDGE,
        top: from.bottom + QUIET,
        right: head.right,
        bottom: pageRect(root.getBoundingClientRect()).bottom - SEAM,
      };
      return [
        [{ seed: SEEDS.skyline + i, profile: 'skyline', flip: false, rim: false, level: 1 }, rect],
      ];
    }),
    ...[...document.querySelectorAll(DESK.anchors)].flatMap((anchor, i): [Field, Rect][] => {
      const list = pageRect(anchor.getBoundingClientRect());
      if (list.right <= list.left) return [];
      const rect = {
        left: content.right + EDGE,
        top: list.top - DESK.above,
        right: document.documentElement.clientWidth - EDGE,
        bottom: list.bottom + DESK.below,
      };
      return [
        [{ seed: SEEDS.desk + i, profile: 'column', flip: false, rim: false, level: 1 }, rect],
      ];
    }),
  ];
  const fields = wanted.flatMap(([field, rect]) => {
    const spec = rect && latticeField(field, rect, origin);
    return spec ? [spec] : [];
  });
  return { zones, fields };
}

function light(fields: readonly FieldSpec[], keepClear: KeepClear, bands: readonly Rect[]): Lit[] {
  const taken = new Set<string>();
  const clear = [...keepClear.text, ...keepClear.marks].map((rect) => grow(rect, CLEAR));
  clear.push(...bands);
  return fields.map((spec) => {
    const frame = {
      left: spec.left,
      top: spec.top,
      right: spec.left + spec.cols * CELL.width,
      bottom: spec.top + spec.rows * CELL.height,
    };
    const near = clear.filter((rect) => overlaps(rect, frame));
    const lit = cells(spec).filter((cell) => {
      const rect = cellRect(spec, cell);
      const key = `${rect.left},${rect.top}`;
      if (taken.has(key) || near.some((other) => overlaps(other, rect))) return false;
      taken.add(key);
      return true;
    });
    return { spec, cells: lit };
  });
}

function paint(
  layer: HTMLElement,
  fields: readonly Lit[],
  placements: readonly Placement[],
): { fields: Painted[]; hovering: { span: HTMLElement; placement: Placement }[] } {
  layer.replaceChildren();
  const painted = fields.map((field) => {
    const element = document.createElement('span');
    element.className = 'field';
    element.style.left = `${field.spec.left}px`;
    element.style.top = `${field.spec.top}px`;
    element.style.width = `${field.spec.cols * CELL.width}px`;
    element.style.height = `${field.spec.rows * CELL.height}px`;
    element.dataset.cols = String(field.spec.cols);
    element.dataset.rows = String(field.spec.rows);
    const spans = field.cells.map((cell) => {
      const span = document.createElement('span');
      span.style.left = `${cell.c * CELL.width}px`;
      span.style.top = `${cell.r * CELL.height}px`;
      span.style.opacity = String(cell.alpha);
      span.className = `${cell.bright ? 'bright ' : ''}${cell.glyph === ':' ? 'stack' : ''}`;
      element.append(span);
      return span;
    });
    layer.append(element);
    return { ...field, spans };
  });
  const hovering = placements.map((placement) => {
    const span = document.createElement('span');
    span.className = 'fragment';
    span.textContent = placement.text;
    span.style.left = `${placement.x}px`;
    span.style.top = `${placement.y}px`;
    span.style.opacity = String(placement.opacity);
    layer.append(span);
    return { span, placement };
  });
  return { fields: painted, hovering };
}

export function mountBackdrop(layer: HTMLElement): Backdrop {
  let fields: Painted[] = [];
  let hovering: { span: HTMLElement; placement: Placement }[] = [];
  let running = false;

  function place(): void {
    layer.style.height = '0';
    const height = document.documentElement.scrollHeight;
    layer.style.height = `${height}px`;
    const {
      keepClear,
      zones,
      fields: specs,
    } = atRest(() =>
      innerWidth < PHONE
        ? { keepClear: { text: [], marks: [] }, zones: [], fields: [] }
        : { keepClear: pageKeepClear(), ...scene(height) },
    );
    const placements: Placement[] = [];
    const bands: Rect[] = [];
    for (const zone of zones) {
      const placed = placeFragments(
        zone.rect,
        { text: keepClear.text, marks: [...keepClear.marks, ...bands] },
        zone.layer,
      );
      placements.push(...placed);
      bands.push(...placed.map(({ text, x, y }) => footprint(text, x, y)));
    }
    ({ fields, hovering } = paint(layer, light(specs, keepClear, bands), placements));
    if (!running) return;
    layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, easing: 'ease-out' });
    for (const { span, placement } of hovering) hover(span, placement);
  }

  const shimmer = createTicker(layer, RATE, (t) => {
    const tick = Math.round(t * RATE);
    const top = scrollY;
    const bottom = top + innerHeight;
    for (const field of fields) {
      const { spec } = field;
      if (spec.top > bottom || spec.top + spec.rows * CELL.height < top) continue;
      for (const { at, alpha } of relit(spec, field.cells, tick)) {
        const span = field.spans[at];
        if (!span) continue;
        span.style.opacity = String(alpha);
      }
    }
  });

  let queued = 0;
  document.fonts.ready.then(place);
  addEventListener('resize', () => {
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(place);
  });

  return {
    start(): void {
      if (running) return;
      running = true;
      for (const { span, placement } of hovering) hover(span, placement);
      shimmer.start();
    },
    stop(): void {
      running = false;
      shimmer.stop();
      for (const { span } of hovering)
        for (const animation of span.getAnimations()) animation.cancel();
    },
  };
}
