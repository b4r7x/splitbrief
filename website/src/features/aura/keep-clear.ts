import type { KeepClear, Rect } from '../fragments/place';

const TEXT = [
  '.hero .steps li > *, .hero .claim, .hero-eyebrow, .lede, .cta, .works, .hero .quote, .label',
  '.seat, .brief, .foot p',
].join(', ');
// The headline by its ink, line by line: the reference tucks a whisper beside its short lines.
const LINES = '.hero h1, .lower .grid';
const MARKS = '.route, .cross, canvas, .scatter span, .panel, .tree, .marg, .marg-list';
const NAV_QUIET = 24;
const RAIN = { top: 0.06, width: 42 };

export function pageRect(r: DOMRect): Rect {
  return {
    left: r.left + scrollX,
    top: r.top + scrollY,
    right: r.right + scrollX,
    bottom: r.bottom + scrollY,
  };
}

function boxes(selector: string): Rect[] {
  return [...document.querySelectorAll(selector)].map((element) =>
    pageRect(element.getBoundingClientRect()),
  );
}

function lines(selector: string): Rect[] {
  const out: Rect[] = [];
  for (const root of document.querySelectorAll(selector)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects())
        if (r.width > 0 && r.height > 0) out.push(pageRect(r));
    }
  }
  return out;
}

// A label's own rows stay clear for its width on either side (a neighbour there reads as a third
// column of it); above and below, only the label's own column stays clear for one line.
function blockAround(selector: string): Rect[] {
  return [...document.querySelectorAll(selector)].flatMap((element) => {
    const rect = pageRect(element.getBoundingClientRect());
    const width = rect.right - rect.left;
    const line = Number.parseFloat(getComputedStyle(element).lineHeight);
    return [
      { ...rect, left: rect.left - width, right: rect.right + width },
      { ...rect, top: rect.top - line, bottom: rect.bottom + line },
    ];
  });
}

function rainColumns(): Rect[] {
  const rain = document.querySelector<HTMLElement>('.rain');
  if (!rain?.childElementCount) return [];
  const stage = pageRect(rain.getBoundingClientRect());
  const fit = (stage.right - stage.left) / rain.offsetWidth;
  return [...document.querySelectorAll('.tick--planner, .tick--implementer')].map((tick) => {
    const { left, right, top } = pageRect(tick.getBoundingClientRect());
    const x = (left + right) / 2;
    return {
      left: x - (RAIN.width / 2) * fit,
      top: stage.top + RAIN.top * (stage.bottom - stage.top),
      right: x + (RAIN.width / 2) * fit,
      bottom: top,
    };
  });
}

export function atRest<T>(measure: () => T): T {
  const entering = document.getAnimations().flatMap((animation) => {
    const end = animation.effect?.getComputedTiming().endTime;
    if (typeof end !== 'number' || !Number.isFinite(end)) return [];
    const was = animation.currentTime;
    animation.currentTime = end;
    return [{ animation, was }];
  });
  const result = measure();
  for (const { animation, was } of entering) animation.currentTime = was;
  return result;
}

export function pageKeepClear(): KeepClear {
  const nav = document.querySelector('.nav');
  return {
    text: [...boxes(TEXT), ...lines(LINES)],
    marks: [
      ...(nav
        ? [
            {
              left: 0,
              top: 0,
              right: document.documentElement.clientWidth,
              bottom: pageRect(nav.getBoundingClientRect()).bottom + NAV_QUIET,
            },
          ]
        : []),
      ...blockAround('.label, .seat'),
      ...rainColumns(),
      ...boxes(MARKS),
    ],
  };
}
