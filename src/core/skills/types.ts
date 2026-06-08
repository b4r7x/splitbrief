export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
  projectRoot?: string | undefined;
}
