const ALPHABET = ':/\\|[]{}<>_-=+.*01';

type Glyph = {
  text: string;
  x: number;
  y: number;
  width: number;
  font: string;
  color: string;
};

export function decodeCharacter(text: string, index: number, count: number, amount: number) {
  if (amount >= 1 || index / Math.max(1, count) < amount * 1.08 - 0.08) return text;
  const seed = Math.imul(index + 1, 2654435761) ^ Math.imul(Math.floor(amount * 512), 1597334677);
  return ALPHABET[(seed >>> 0) % ALPHABET.length] ?? ':';
}

export function createDecoder(panel: HTMLElement, selector = '[data-decode]') {
  const canvas = document.createElement('canvas');
  canvas.className = 'decode-layer';
  canvas.setAttribute('aria-hidden', 'true');
  panel.append(canvas);
  const context = canvas.getContext('2d');
  let sources: HTMLElement[] = [];
  let glyphs: Glyph[] = [];
  let lastAmount = -1;

  function restore() {
    for (const source of sources) source.classList.remove('is-decoding');
    canvas.hidden = true;
  }

  function measure() {
    restore();
    sources = [...panel.querySelectorAll<HTMLElement>(selector)].filter(
      (source) => !source.closest('[data-decode-skip]'),
    );
    lastAmount = -1;
    glyphs = [];
    if (!context) return;
    const outer = panel.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const left = Math.floor(outer.left * ratio) / ratio;
    const top = Math.floor(outer.top * ratio) / ratio;
    canvas.width = Math.ceil((outer.right - left) * ratio);
    canvas.height = Math.ceil((outer.bottom - top) * ratio);
    canvas.style.left = `${left - outer.left}px`;
    canvas.style.top = `${top - outer.top}px`;
    canvas.style.width = `${canvas.width / ratio}px`;
    canvas.style.height = `${canvas.height / ratio}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.textBaseline = 'alphabetic';
    for (const source of sources) {
      const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!parent || !node.textContent || parent.closest('button, a')) continue;
        const style = getComputedStyle(parent);
        const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        context.font = font;
        const metrics = context.measureText('Mg');
        const ascent = metrics.fontBoundingBoxAscent || Number.parseFloat(style.fontSize) * 0.8;
        const descent = metrics.fontBoundingBoxDescent || Number.parseFloat(style.fontSize) * 0.2;
        const range = document.createRange();
        for (let index = 0; index < node.textContent.length; index++) {
          const text = node.textContent[index];
          if (!text || /\s/.test(text)) continue;
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          if (rect.bottom < outer.top || rect.top > outer.bottom) continue;
          glyphs.push({
            text,
            x: rect.left - left,
            y: rect.top - top + (rect.height - ascent - descent) / 2 + ascent,
            width: rect.width,
            font,
            color: style.color,
          });
        }
      }
    }
  }

  function paint(amount: number) {
    if (amount === lastAmount) return;
    lastAmount = amount;
    if (!context || amount >= 1) {
      restore();
      return;
    }
    canvas.hidden = false;
    for (const source of sources) source.classList.add('is-decoding');
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const [index, glyph] of glyphs.entries()) {
      const text = decodeCharacter(glyph.text, index, glyphs.length, amount);
      context.font = glyph.font;
      context.fillStyle = glyph.color;
      context.globalAlpha = text === glyph.text ? 1 : 0.55;
      context.fillText(text, glyph.x, glyph.y, glyph.width + 1);
    }
    context.globalAlpha = 1;
  }

  return {
    measure,
    paint,
    destroy() {
      restore();
      canvas.remove();
    },
  };
}
