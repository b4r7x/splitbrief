type Rect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

const MARKS = '.panel, .tree, .marg, .marg-list, .stop, canvas.dots';
const BLOCKS = '.tick-list, .marg-list, .steps, .callouts';
const RAIL_PAD = 8;
const SEAM = 16;
const WIDE = 1600;
const EDGE = 96;
const CONTENT_PAD = 24;

export function sectionKeepClear(section: HTMLElement): {
  text: Rect[];
  marks: Rect[];
  panels: Rect[];
} {
  const layer = section.querySelector('.aura');
  const origin = (layer ?? section).getBoundingClientRect();
  const rel = (r: DOMRect): Rect => ({
    left: r.left - origin.left,
    top: r.top - origin.top,
    right: r.right - origin.left,
    bottom: r.bottom - origin.top,
  });
  const text: Rect[] = [];
  const grid = section.querySelector('.grid');
  if (grid === null) return { text, marks: [], panels: [] };
  const walker = document.createTreeWalker(grid, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) text.push(rel(r));
  }
  const C = grid.getBoundingClientRect().left - origin.left;
  const E = grid.getBoundingClientRect().right - origin.left;
  const railElement = document.querySelector('.rail');
  const railX =
    railElement === null
      ? E - Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail'))
      : railElement.getBoundingClientRect().left - origin.left;
  const w = origin.width;
  const h = origin.height;
  const marks = [
    ...[...section.querySelectorAll(MARKS)].map((element) => rel(element.getBoundingClientRect())),
    { left: railX - RAIL_PAD, top: 0, right: railX + RAIL_PAD, bottom: h },
    { left: 0, top: 0, right: w, bottom: SEAM },
    { left: 0, top: h - SEAM, right: w, bottom: h },
    ...[...section.querySelectorAll(BLOCKS)].map((element) => {
      const rect = element.getBoundingClientRect();
      const line = Number.parseFloat(getComputedStyle(element).lineHeight);
      const box = rel(rect);
      return {
        left: box.left - rect.width,
        top: box.top - line,
        right: box.right + rect.width,
        bottom: box.bottom + line,
      };
    }),
    { left: C - CONTENT_PAD, top: 0, right: C, bottom: h },
    { left: E, top: 0, right: E + CONTENT_PAD, bottom: h },
    ...(innerWidth < WIDE
      ? []
      : [
          { left: 0, top: 0, right: EDGE, bottom: h },
          { left: w - EDGE, top: 0, right: w, bottom: h },
        ]),
  ];
  const panels = [...section.querySelectorAll('.panel')].map((element) =>
    rel(element.getBoundingClientRect()),
  );
  return { text, marks, panels };
}
