import { z } from 'zod';
import {
  MAX_VIEWPORT_CELLS,
  MAX_VIEWPORT_COLS,
  MAX_VIEWPORT_ROWS,
  MIN_VIEWPORT_COLS,
  MIN_VIEWPORT_ROWS,
} from './limits.js';

export const ViewportSchema = z
  .object({
    cols: z.number().int().min(MIN_VIEWPORT_COLS).max(MAX_VIEWPORT_COLS),
    rows: z.number().int().min(MIN_VIEWPORT_ROWS).max(MAX_VIEWPORT_ROWS),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cols * value.rows > MAX_VIEWPORT_CELLS) {
      context.addIssue({
        code: 'custom',
        message: `viewport exceeds ${MAX_VIEWPORT_CELLS} cells`,
      });
    }
  })
  .readonly();
export type Viewport = z.infer<typeof ViewportSchema>;

const ViewportInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return value;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}, ViewportSchema);

export function viewport(options: z.input<typeof ViewportSchema>): Viewport {
  return ViewportSchema.parse(options);
}

export function parseViewport(value: unknown): Viewport {
  return ViewportInputSchema.parse(value);
}

export function formatViewport(value: Viewport): string {
  return `${value.cols}x${value.rows}`;
}

export const CellRectSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
  .readonly();
export type CellRect = z.infer<typeof CellRectSchema>;

export function isCellRectInViewport(rect: CellRect, viewportValue: Viewport): boolean {
  return rect.x + rect.width <= viewportValue.cols && rect.y + rect.height <= viewportValue.rows;
}

export function isFullFrameRect(rect: CellRect, viewportValue: Viewport): boolean {
  return (
    rect.x === 0 &&
    rect.y === 0 &&
    rect.width === viewportValue.cols &&
    rect.height === viewportValue.rows
  );
}
