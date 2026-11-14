import { z } from 'zod';
import { normalizeDisplayLabel } from '../../../../../utils/display-text/sanitize.js';
import { cleanCatalogLines, isCatalogHeading, NATIVE_DEFAULT_SUFFIX } from './listing.js';
import {
  type NativeCliModelCatalogEntry,
  type NativeCliModelCatalog,
  catalogFromEntries,
} from './entries.js';

// `cmd --list-models` aligns a bare selection id against a capability blurb with
// a run of spaces, and only first-party ids drop the `provider/` prefix. The id
// shape rejects the provider headings, the `cmd --model …` usage examples and
// the trailing `Docs:` line, none of which are selectable.
const COMMAND_CODE_MODEL_LINE =
  /^([a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)?(?:\/[a-z0-9][a-z0-9.-]*(?::[a-z0-9][a-z0-9.-]*)?)*) {2,}(.+)$/i;
// The footer closes the counted coding list. cmd 1.62.1 prints its "Decision models
// (headless only)" after it: they answer a JSON query, not a coding prompt.
const COMMAND_CODE_FOOTER = /^Docs:\s+https:\/\/commandcode\.ai\/docs\/reference\/cli\/models\/?$/;

// `cmd --list-models` (1.88.5) prints ids and blurbs only. The same run writes
// `$HOME/.commandcode/cache/model-catalog/v1/catalog-<hash>.json`, which holds each
// model's levels, label, input and window under the id the API spells (`Qwen/Qwen3.8-Max`)
// and the aliases the listing may print (`claude-haiku-4-5`).
const CommandCodeCatalogCacheSchema = z.object({
  scope: z.object({ schemaVersion: z.literal(1) }),
  body: z.object({
    schemaVersion: z.literal(1),
    data: z.array(
      z.object({
        id: z.string().trim().min(1),
        aliases: z.array(z.string().trim().min(1)),
        display: z.object({ label: z.string() }),
        reasoningEfforts: z.array(z.string().trim().min(1)).nullable(),
        inputModalities: z.array(z.string().trim().min(1)),
        context_length: z.number().int().positive(),
      }),
    ),
  }),
});

type CommandCodeCacheEntry = z.infer<typeof CommandCodeCatalogCacheSchema>['body']['data'][number];

/** A cache file that is not JSON or has another schema adds nothing. */
function commandCodeCacheEntries(
  cacheTexts: readonly string[],
): ReadonlyMap<string, CommandCodeCacheEntry> {
  const byName = new Map<string, CommandCodeCacheEntry>();
  for (const text of cacheTexts) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const cache = CommandCodeCatalogCacheSchema.safeParse(json);
    if (!cache.success) continue;
    for (const entry of cache.data.body.data) {
      for (const name of [entry.id, ...entry.aliases]) byName.set(name.toLowerCase(), entry);
    }
  }
  return byName;
}

function commandCodeCacheFields(
  entry: CommandCodeCacheEntry | undefined,
): Omit<NativeCliModelCatalogEntry, 'nativeOrder' | 'selectionId'> {
  if (entry === undefined) return {};
  const displayName = normalizeDisplayLabel(entry.display.label);
  return {
    ...(displayName.length === 0 ? {} : { displayName }),
    // A `null` ladder is a model with no effort axis.
    nativeReasoningEfforts: entry.reasoningEfforts ?? [],
    inputModalities: entry.inputModalities,
    contextWindow: entry.context_length,
  };
}

export function parseCommandCodeNativeModelCatalog(
  stdout: string,
  cacheTexts: readonly string[] = [],
): NativeCliModelCatalog | null {
  const cache = commandCodeCacheEntries(cacheTexts);
  const entries: Omit<NativeCliModelCatalogEntry, 'nativeOrder'>[] = [];
  for (const line of cleanCatalogLines(stdout)) {
    if (COMMAND_CODE_FOOTER.test(line)) break;
    if (isCatalogHeading(line)) continue;
    const match = COMMAND_CODE_MODEL_LINE.exec(line);
    const selectionId = match?.[1];
    const blurb = match?.[2];
    if (selectionId === undefined || blurb === undefined) continue;
    const detail = blurb.replace(NATIVE_DEFAULT_SUFFIX, '').trim();
    entries.push({
      selectionId,
      ...(detail.length === 0 ? {} : { detail }),
      ...(NATIVE_DEFAULT_SUFFIX.test(blurb) ? { nativeDefault: true } : {}),
      ...commandCodeCacheFields(cache.get(selectionId.toLowerCase())),
    });
  }
  return entries.length === 0 ? null : catalogFromEntries({ tool: 'command-code', entries });
}

/** The native count and the footer that closes the list prove it finished even if shutdown stalls. */
export function parseCompleteCommandCodeNativeModelCatalog(
  stdout: string,
  cacheTexts: readonly string[] = [],
): NativeCliModelCatalog | null {
  const lines = cleanCatalogLines(stdout);
  const counts = lines.flatMap((line) => {
    const match = /^Available models\s*·\s*(\d+) models$/i.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
  if (counts.length !== 1 || !lines.some((line) => COMMAND_CODE_FOOTER.test(line))) return null;
  const catalog = parseCommandCodeNativeModelCatalog(stdout, cacheTexts);
  return catalog !== null && catalog.models.length === counts[0] ? catalog : null;
}
