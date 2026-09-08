import type { ResolvedModelMembership } from '../../../engine/providers/model/catalog.js';

/** One provider-qualified spelling of a merged model row. */
export interface ModelVariant {
  fullId: string;
  providerPrefix: string;
  tag: string;
  displayName?: string | undefined;
  /** Pre-merge enumeration facts so counting can restate per-variant truth. */
  membership?: ResolvedModelMembership | undefined;
  isCustom?: boolean | undefined;
  isAccountOption?: boolean | undefined;
  /**
   * Named presets the seat's tool offers for this route; synthetic, never
   * id-encoded. Vocabulary is per model, so it belongs to the route rather
   * than to the merged row.
   */
  variantChoices?: readonly string[] | undefined;
}

export interface ModelOption {
  id: string;
  displayName?: string | undefined;
  isDefault?: boolean | undefined;
  isDetected?: boolean | undefined;
  /** Membership remains visible after engine catalog projection. */
  membership?: ResolvedModelMembership | undefined;
  /** Last-confirmed runtime inventory retained after a failed refresh. */
  isStale?: boolean | undefined;
  isCustom?: boolean | undefined;
  /**
   * The authoritative list's own position — a confirmed row's place in the
   * tool's output, or a bundled alias's place in the documented set; absent on
   * catalog and custom rows.
   */
  nativeOrder?: number | undefined;
  /** The configured model the authoritative list does not contain. */
  isRecovery?: boolean | undefined;
  /** The tool's own per-account option cache, never a documented alias. */
  isAccountOption?: boolean | undefined;
  contextLength?: number | undefined;
  /**
   * The effort ladder this model's own source publishes — the tool's `--verbose`
   * listing, models.dev `reasoning_options`, or the tool's documented flag ladder.
   * Empty means the model publishes none; absent means nothing has answered.
   * A row's routes can publish their own (`ModelVariant.variantChoices`), so read a
   * route's ladder through `effortLadderFor`: the route's first, this one second.
   */
  effortChoices?: readonly string[] | undefined;
  releaseDate?: string | undefined;
  /** Present on provider-merged rows and option-family rows (≥2 members). */
  variants?: readonly ModelVariant[] | undefined;
}

export function isCustomModel(item: ModelOption): boolean {
  return item.isCustom ?? false;
}

const TRAILING_DATE_CAPTURE_RE = /(\d{8})$/;
const SIZE_SEGMENT_RE = /^\d+(?:\.\d+)?b$/i;

function extractRecencyKey(id: string): { date: number; version: number[]; name: string } {
  const base = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  const withoutTag = base.includes(':') ? base.slice(0, base.indexOf(':')) : base;

  const dateMatch = withoutTag.match(TRAILING_DATE_CAPTURE_RE);
  const date = dateMatch?.[1] ? parseInt(dateMatch[1], 10) : 0;

  const segments = withoutTag.split(/[-._]/);
  const version: number[] = [];
  for (const seg of segments) {
    if (/^\d+$/.test(seg) && !SIZE_SEGMENT_RE.test(seg)) {
      version.push(parseInt(seg, 10));
    }
  }

  return { date, version, name: base };
}

function compareRecency(
  a: ReturnType<typeof extractRecencyKey>,
  b: ReturnType<typeof extractRecencyKey>,
): number {
  if (a.date !== b.date) return b.date - a.date;
  const maxLen = Math.max(a.version.length, b.version.length);
  for (let i = 0; i < maxLen; i++) {
    const av = a.version[i] ?? 0;
    const bv = b.version[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return a.name.localeCompare(b.name);
}

export function sortModelsByRecency(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;

    const aNative = a.nativeOrder;
    const bNative = b.nativeOrder;
    if (aNative !== undefined && bNative !== undefined && aNative !== bNative) {
      return aNative - bNative;
    }
    if (aNative !== undefined && bNative === undefined) return -1;
    if (aNative === undefined && bNative !== undefined) return 1;

    if (a.releaseDate || b.releaseDate) {
      const aDate = a.releaseDate ?? '';
      const bDate = b.releaseDate ?? '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
    }

    return compareRecency(extractRecencyKey(a.id), extractRecencyKey(b.id));
  });
}
