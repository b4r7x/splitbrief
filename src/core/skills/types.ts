export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
  projectDir?: string | undefined;
  /** The directory a `SKILL.md` skill owns; a loose `.md` skill and AGENTS.md own only their file. */
  dir?: string | undefined;
}
