import { createStore, storeBase } from './create-store.js';
import { discoverSkills } from '../engine/skills/index.js';
import type { PlannerTool, SkillMeta } from '../types.js';

interface SkillsState {
  available: SkillMeta[];
  selected: Set<string>;
}

const store = createStore<SkillsState>({ available: [], selected: new Set() });

function discover(plannerTool: PlannerTool, projectDir: string) {
  store.set(s => ({ ...s, available: discoverSkills(plannerTool, projectDir) }));
}

function setSelected(ids: Set<string>) {
  store.set(s => ({ ...s, selected: ids }));
}

export const skillsStore = { ...storeBase(store), discover, setSelected };
