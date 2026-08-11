import { configStore } from '../../../stores/project/config.js';
import { sanitizeRowDisplayText } from './row-format/text.js';
import type { ConversationRow } from './types.js';
import {
  getMarkdownRowsCacheEntry,
  markdownRowsIdentityKey,
  rememberMarkdownRows,
  resetMarkdownRowsCache,
} from './markdown-rows/cache.js';
import {
  appendMarkdownRowsCacheEntry,
  createMarkdownRowsCacheEntry,
  normalizeMarkdownSource,
} from './markdown-rows/chunks.js';
import type {
  MarkdownConversationRowsInput,
  MarkdownConversationRowsProjection,
} from './markdown-rows/types.js';

export type {
  MarkdownConversationRowsIdentityInput,
  MarkdownConversationRowsInput,
  MarkdownConversationRowsProjection,
} from './markdown-rows/types.js';
export {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRowsCacheKey,
} from './markdown-rows/cache.js';

export function markdownConversationRows(input: MarkdownConversationRowsInput): ConversationRow[] {
  const projection = markdownConversationRowsProjection(input);
  return projection.createRows(0, projection.rowCount);
}

export function markdownConversationRowsProjection(
  input: MarkdownConversationRowsInput,
): MarkdownConversationRowsProjection {
  const key = markdownRowsIdentityKey(input);
  const cached = getMarkdownRowsCacheEntry(key);
  // Sanitizing is the expensive half of a re-projection, so unchanged raw text short-circuits
  // ahead of it — scrolling re-renders every markdown block without touching its source.
  if (cached?.rawText === input.text) {
    rememberMarkdownRows(key, cached);
    return cached.projection;
  }

  const sourceText = normalizeMarkdownSource(sanitizeRowDisplayText(input.text));
  const projectDir = configStore.get().projectDir || undefined;
  if (cached?.sourceText === sourceText) {
    rememberMarkdownRows(key, { ...cached, rawText: input.text });
    return cached.projection;
  }

  const next =
    cached !== undefined && sourceText.startsWith(cached.sourceText)
      ? appendMarkdownRowsCacheEntry({
          cached,
          sourceText,
          keyPrefix: input.keyPrefix,
          width: input.width,
          projectDir,
        })
      : createMarkdownRowsCacheEntry({
          sourceText,
          keyPrefix: input.keyPrefix,
          width: input.width,
          startChunkIndex: 0,
          startOffset: 0,
          projectDir,
        });

  rememberMarkdownRows(key, { ...next, rawText: input.text });
  return next.projection;
}

export function resetMarkdownConversationRowsCache(): void {
  resetMarkdownRowsCache();
}
