export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
  projectDir?: string | undefined;
}
