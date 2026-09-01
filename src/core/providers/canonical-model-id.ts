export interface ModelIdentity {
  readonly id: string;
  /** The catalog owner that lists this id, when the id itself carries no `owner/` prefix. */
  readonly owner?: string | undefined;
}

/** Lower-cased, `:free`-stripped, owner-qualified path form of a model identity. */
export function canonicalModelId(identity: ModelIdentity): string {
  const trimmed = identity.id.trim().toLowerCase();
  const base = trimmed.endsWith(':free') ? trimmed.slice(0, -':free'.length) : trimmed;
  if (base.includes('/')) return base;
  const owner = identity.owner?.trim().toLowerCase();
  if (owner !== undefined && owner !== '') return `${owner}/${base}`;
  return base;
}

/** Suffix-aware identity: `deepseek/x` and `openrouter/deepseek/x` name one model. */
export function isSameCanonicalModel(left: ModelIdentity, right: ModelIdentity): boolean {
  const canonicalLeft = canonicalModelId(left);
  const canonicalRight = canonicalModelId(right);
  if (canonicalLeft === canonicalRight) return true;

  const pa = canonicalLeft.split('/');
  const pb = canonicalRight.split('/');
  const [shorter, longer] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  if (shorter.length >= 2 && isSegmentSuffix(shorter, longer)) return true;

  return (
    shorter[shorter.length - 1] === longer[longer.length - 1] &&
    !left.id.includes('/') &&
    !right.id.includes('/')
  );
}

/**
 * The last canonical segment, which every `isSameCanonicalModel` match shares.
 * Bucketing candidates by it turns a dedup scan into a lookup.
 */
export function canonicalModelBucket(identity: ModelIdentity): string {
  const canonical = canonicalModelId(identity);
  const slash = canonical.lastIndexOf('/');
  return slash === -1 ? canonical : canonical.slice(slash + 1);
}

function isSegmentSuffix(shorter: readonly string[], longer: readonly string[]): boolean {
  const offset = longer.length - shorter.length;
  return shorter.every((segment, index) => segment === longer[offset + index]);
}
