export interface ModelOption {
  id: string;
  isDefault?: boolean | undefined;
  isDetected?: boolean | undefined;
  isCustom?: boolean | undefined;
  contextLength?: number | undefined;
  releaseDate?: string | undefined;
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

    if (a.releaseDate || b.releaseDate) {
      const aDate = a.releaseDate ?? '';
      const bDate = b.releaseDate ?? '';
      if (aDate !== bDate) return bDate.localeCompare(aDate);
    }

    return compareRecency(extractRecencyKey(a.id), extractRecencyKey(b.id));
  });
}
