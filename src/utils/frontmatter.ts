import YAML from 'yaml';

type FrontmatterRecord = Record<string, unknown>;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_WITH_TRAILER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function isRecord(value: unknown): value is FrontmatterRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseSimpleYamlFrontmatter(raw: string): FrontmatterRecord | null {
  const match = raw.match(FRONTMATTER_RE);
  const body = match?.[1];
  if (body === undefined) return null;
  try {
    const parsed: unknown = YAML.parse(body);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

export function extractFrontmatter(
  raw: string,
): { frontmatter: FrontmatterRecord | null; body: string } {
  const match = raw.match(FRONTMATTER_WITH_TRAILER_RE);
  if (!match) return { frontmatter: null, body: raw };
  const frontmatter = parseSimpleYamlFrontmatter(raw);
  const body = raw.slice(match[0].length);
  return { frontmatter, body };
}
