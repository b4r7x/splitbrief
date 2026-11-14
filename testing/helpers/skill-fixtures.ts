import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeFlatSkill(
  root: string,
  id: string,
  frontmatter: string,
  body = 'Content',
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\n${frontmatter}\n---\n${body}`);
}

export function writeSkillDir(
  parent: string,
  id: string,
  frontmatter: string,
  body = 'Content',
): string {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
  return dir;
}
