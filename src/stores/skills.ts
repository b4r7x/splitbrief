import { createStore, storeBase } from './create-store.js';
import type { PlannerTool, SkillMeta } from '../types.js';

interface SkillsState {
  available: SkillMeta[];
  selected: Set<string>;
}

const store = createStore<SkillsState>(() => ({ available: [], selected: new Set() }));

async function discover(
  discoverFn: (tool: PlannerTool, projectDir: string) => Promise<SkillMeta[]>,
  plannerTool: PlannerTool,
  projectDir: string,
) {
  const available = await discoverFn(plannerTool, projectDir);
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
