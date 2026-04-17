import { createStore, storeBase } from '../create-store.js';
import { discoverSkills } from '../../engine/skills/discovery.js';
import type { PlannerTool } from '../../core/types/config-options.js';
import type { SkillMeta } from '../../core/types/app.js';

interface SkillsState {
  available: SkillMeta[];
  selected: Set<string>;
}

const initial = (): SkillsState => ({ available: [], selected: new Set() });

const store = createStore<SkillsState>(initial);

async function discover(plannerTool: PlannerTool, projectDir: string) {
  const available = await discoverSkills(plannerTool, projectDir);
  const availableIds = new Set(available.map(s => s.id));
  store.set(s => ({
    available,
    selected: new Set([...s.selected].filter(id => availableIds.has(id))),
  }));
}

function setSelected(ids: Set<string>) {
  store.set(s => ({ ...s, selected: ids }));
}

export const skillsStore = { ...storeBase(store), discover, setSelected };
