import type { Point } from './geometry.js';
import { createPartTransform, detailPose } from './pose.js';

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
  let cells: string[] = [];
  const layers = palette.map((color) => ({ color, cells: [] as number[] }));
  const transformed = { x: 0, z: 0 };
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
    columns = Math.ceil(width / cellWidth);
    rows = Math.ceil(height / cellHeight);
    depths = new Float32Array(columns * rows);
    inks = new Uint8Array(columns * rows);
    cells = new Array(columns * rows);
  }

  function render(progress: ArtProgress, time: number, region: ArtRegion, snap: boolean) {
    const value = clamp(progress.workflow);
    const morph = value * value * (3 - 2 * value);
    const tension = Math.sin(morph * Math.PI);
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
    const fitted = Math.max(0, Math.min((region.width - 16) / 23, (region.height - 16) / 16));
    const horizontalScale = mix(sceneWidth, fitted, fit);
    const verticalScale = mix(sceneHeight, fitted, fit);
    const centerX = mix(width * 0.5, region.left + region.width * 0.5, fit);
    const centerY = mix(sceneCenter, region.top + region.height * 0.5, settle);
    const depthScale = mix(0.25, 0.55, morph);
    const pose = detailPose(progress.details, snap);
    const transformPart = createPartTransform(pose, settle);
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
    cells.fill('');
    inks.fill(0);

    for (const point of points) {
      const startX = mix(point.start[0], point.end[0], morph);
      const startY = mix(point.start[1], point.end[1], morph);
      let startZ = mix(point.start[2], point.end[2], morph);
      if (tension !== 0) startZ += tension * Math.sin(startX * 0.16 + point.phase * 0.25) * 0.55;
      if (!snap) startZ += Math.sin(time * 0.32 + startX * 0.23) * 0.035;
      transformPart(startX, startZ, point.part, transformed);
      const { x, z } = transformed;
      const px = centerX + (x * 0.98 + z * depthScale) * horizontalScale;
      const py = centerY + (-startY + z * 0.21 - x * slope) * verticalScale;
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
      const light = !snap && Math.sin(time * 0.4 + x * 0.13) > 0.94 ? 1 : 0;
      inks[key] = Math.min(7, point.tone + light);
      cells[key] = point.glyph;
    }

    for (const layer of layers) layer.cells.length = 0;
    for (let key = 0; key < cells.length; key += 1) {
      if (cells[key]) layers[inks[key] ?? 0]?.cells.push(key);
    }
    for (const { color, cells: occupied } of layers) {
      context.fillStyle = color;
      for (const key of occupied) {
        const glyph = cells[key];
        if (glyph)
          context.fillText(
            glyph,
            (key % columns) * cellWidth,
            Math.floor(key / columns) * cellHeight,
          );
      }
    }
  }

  return { resize, render };
}
