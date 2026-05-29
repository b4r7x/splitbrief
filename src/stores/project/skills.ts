import { createStore, storeBase } from '../create-store.js';
import type { SkillMeta } from '../../core/skills/types.js';

interface SkillsState {
  available: SkillMeta[];
  selected: Set<string>;
}

const initial = (): SkillsState => ({ available: [], selected: new Set() });

const store = createStore<SkillsState>(initial);

function cloneSkill(skill: SkillMeta): SkillMeta {
  return { ...skill };
}

function setAvailable(available: SkillMeta[]) {
  const cloned = available.map(cloneSkill);
  const availableIds = new Set(available.map((s) => s.id));
  store.set((s) => ({
    available: cloned,
    selected: new Set([...s.selected].filter((id) => availableIds.has(id))),
  }));
}

function setSelected(ids: Set<string>) {
  store.set((s) => ({ ...s, selected: new Set(ids) }));
}

export const skillsStore = { ...storeBase(store), setAvailable, setSelected };
