import {
  renderMarkdownRows,
  type RenderMarkdownRowsOptions,
} from '../../../components/markdown.js';
import type { ScrollableDocumentRow } from '../../../components/scrollable-document.js';

interface ReviewRowsCacheEntry {
  options: RenderMarkdownRowsOptions;
  rows: readonly ScrollableDocumentRow[];
}

// One entry is enough: the review pane shows a single document at a time, and every scroll
// keypress re-renders it with identical inputs.
let cachedReviewRows: ReviewRowsCacheEntry | null = null;

function sameReviewRowsOptions(
  a: RenderMarkdownRowsOptions,
  b: RenderMarkdownRowsOptions,
): boolean {
  return (
    a.source === b.source &&
    a.width === b.width &&
    a.theme === b.theme &&
    a.decorateSegment === b.decorateSegment &&
    a.projectDir === b.projectDir
  );
}

export function renderReviewRows(
  options: RenderMarkdownRowsOptions,
): readonly ScrollableDocumentRow[] {
  const cached = cachedReviewRows;
  if (cached !== null && sameReviewRowsOptions(cached.options, options)) return cached.rows;

  const rows = renderMarkdownRows(options);
  cachedReviewRows = { options, rows };
  return rows;
}
