import { z } from 'zod';
import { extractFrontmatter } from '../../utils/frontmatter.js';

const SkillFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().default(''),
});

type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

const FRONTMATTER_FIELD_RE = /^(name|description):[ \t]*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed.slice(0, 1);
  const quoted = (quote === '"' || quote === "'") && trimmed.length > 1 && trimmed.endsWith(quote);
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function scanFrontmatterFields(block: string): SkillFrontmatter {
  const fm: SkillFrontmatter = { description: '' };
  for (const line of block.split('\n')) {
    const match = line.match(FRONTMATTER_FIELD_RE);
    if (match === null) continue;
    const value = unquote(match[2] ?? '');
    if (match[1] === 'name') fm.name = value;
    else fm.description = value;
  }
  return fm;
}

// YAML rejects an unquoted value containing `: ` — the `description: Use when … Triggers: …`
// convention most skills are authored with — so a block that fails to parse is line-scanned
// instead of dropping a real skill.
export function parseFrontmatter(
  raw: string,
): { fields: SkillFrontmatter; recovered: boolean } | null {
  const { frontmatter, body } = extractFrontmatter(raw);
  if (frontmatter !== null) {
    const parsed = SkillFrontmatterSchema.safeParse(frontmatter);
    if (parsed.success) return { fields: parsed.data, recovered: false };
  }
  // extractFrontmatter hands back the input untouched only when there is no `---` block at all.
  if (body === raw) return null;
  return { fields: scanFrontmatterFields(raw.slice(0, raw.length - body.length)), recovered: true };
}
