import type { Point } from './geometry.js';
import { createGlyphs } from './glyphs.js';
import { detailPose, markTargets } from './pose.js';

export type ArtRegion = { left: number; top: number; width: number; height: number };
export type ArtProgress = { workflow: number; entry: number; details: number };

const palette = [
  '#303030',
  '#3c3c3c',
  '#464646',
  '#505050',
  '#5b5b5b',
  '#686868',
  '#767676',
  '#868686',
];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function createRenderer(context: CanvasRenderingContext2D, points: readonly Point[]) {
  let width = 0;
  let height = 0;
  let columns = 0;
  let rows = 0;
  let depths = new Float32Array(0);
  let inks = new Uint8Array(0);
  let cells = new Uint16Array(0);
  const glyphs = [...new Set(points.map((point) => point.glyph))];
  const glyphIds = new Map(glyphs.map((glyph, index) => [glyph, index + 1]));
  const prepared = points.map((point) => {
    const targets = markTargets(point);
    return {
      x: point.start[0],
      y: point.start[1],
      z: point.start[2],
      dx: point.end[0] - point.start[0],
      dy: point.end[1] - point.start[1],
      dz: point.end[2] - point.start[2],
      splitX: targets.split[0] - point.end[0],
      splitY: targets.split[1] - point.end[1],
      splitZ: targets.split[2] - point.end[2],
      briefsX: targets.briefs[0] - point.end[0],
      briefsY: targets.briefs[1] - point.end[1],
      briefsZ: targets.briefs[2] - point.end[2],
      tone: point.tone,
      edge: point.edge,
      phase: point.phase,
      glyph: glyphIds.get(point.glyph) ?? 0,
    };
  });
  let paintGlyph: ReturnType<typeof createGlyphs> | undefined;
  const layers = palette.map((color) => ({ color, cells: [] as number[] }));
  const cellWidth = 7;
  const cellHeight = 10;

  function resize(nextWidth: number, nextHeight: number, ratio: number) {
    width = nextWidth;
    height = nextHeight;
    context.canvas.width = Math.round(width * ratio);
    context.canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.font = '9px Departure, monospace';
    context.textBaseline = 'top';
    paintGlyph = createGlyphs(context, palette, glyphs, ratio);
    columns = Math.ceil(width / cellWidth);
    rows = Math.ceil(height / cellHeight);
    depths = new Float32Array(columns * rows);
    inks = new Uint8Array(columns * rows);
    cells = new Uint16Array(columns * rows);
  }

  function render(progress: ArtProgress, region: ArtRegion, snap: boolean, opacity = 1) {
    const value = clamp(progress.workflow);
    const morph = value * value * (3 - 2 * value);
    const tension = value > 0 && value < 1 ? Math.sin(morph * Math.PI) : 0;
    const entry = clamp(progress.entry);
    const settle = entry * entry * (3 - 2 * entry);
    // Clear the incoming text column before the scene finishes moving into place.
    const docking = clamp(entry / 0.3);
    const fit = docking * docking * (3 - 2 * docking);
    const lower = 1 - (1 - morph) ** 3;
    const small = width <= 600;
    const bridgeScale = small ? height / 38 : Math.min(width / 24.5, height / 12.6);
    const markScale = small ? height / 38 : Math.min(width / 24.5, (height - 280) / 13.4);
    const markWidth = small ? width / 23 : markScale;
    const sceneWidth = mix(width / 16, markWidth, morph * morph);
    const sceneHeight = mix(bridgeScale, markScale, lower);
    const sceneCenter = small ? height * 0.55 : mix(height * 0.585, 240 + 6.7 * markScale, lower);
    const fitted = Math.max(0, Math.min((region.width - 16) / 26, (region.height - 16) / 17));
    const horizontalScale = mix(sceneWidth, fitted, fit);
    const verticalScale = mix(sceneHeight, fitted, fit);
    const centerX = mix(width * 0.5, region.left + region.width * 0.5, fit);
    const centerY = mix(sceneCenter, region.top + region.height * 0.5, settle);
    const depthScale = mix(0.25, 0.55, morph);
    const pose = detailPose(progress.details * settle, snap);
    const strength = morph * morph * settle;
    const split = pose.split * strength;
    const briefs = pose.briefs * strength;
    const slope = mix(0.075, 0.03, morph);
    context.fillStyle = '#141414';
    context.fillRect(0, 0, width, height);
    if (
      entry === 1 &&
      (fitted === 0 ||
        region.top + region.height <= 0 ||
        region.top >= height ||
        region.left + region.width <= 0 ||
        region.left >= width)
    )
      return;
    depths.fill(-10000);
    cells.fill(0);
    inks.fill(0);

    for (const point of prepared) {
      const x = point.x + point.dx * morph + point.splitX * split + point.briefsX * briefs;
      const y = point.y + point.dy * morph + point.splitY * split + point.briefsY * briefs;
      let z = point.z + point.dz * morph + point.splitZ * split + point.briefsZ * briefs;
      if (tension !== 0) z += tension * Math.sin(x * 0.16 + point.phase * 0.25) * 0.55;
      const px = centerX + (x * 0.98 + z * depthScale) * horizontalScale;
      const py = centerY + (-y + z * 0.21 - x * slope) * verticalScale;
      if (
        entry === 1 &&
        (px < region.left ||
          px > region.left + region.width - cellWidth ||
          py < region.top ||
          py > region.top + region.height - cellHeight)
      )
        continue;
      const col = Math.round(px / cellWidth);
      const row = Math.round(py / cellHeight);
      if (col < 0 || row < 0 || col >= columns || row >= rows) continue;
      const key = row * columns + col;
      const depth = z + (point.edge ? 0.07 : 0);
      if (depth < (depths[key] ?? -10000)) continue;
      depths[key] = depth;
      inks[key] = point.tone;
      cells[key] = point.glyph;
    }

    for (const layer of layers) layer.cells.length = 0;
    for (let key = 0; key < cells.length; key += 1) {
      if (cells[key]) layers[inks[key] ?? 0]?.cells.push(key);
    }
    context.globalAlpha = opacity * opacity * (3 - 2 * opacity);
    for (const [tone, { color, cells: occupied }] of layers.entries()) {
      context.fillStyle = color;
      for (const key of occupied) {
        const glyph = cells[key];
        if (glyph)
          paintGlyph?.(
            glyph - 1,
            tone,
            (key % columns) * cellWidth,
            Math.floor(key / columns) * cellHeight,
          );
      }
    }
    context.globalAlpha = 1;
  }

  return { resize, render };
}
