import { useState, useEffect } from 'react';
import type { PlannerTool, SkillMeta } from '../types.js';
import { discoverSkills } from '../engine/skills.js';

export function useSkills(plannerTool: PlannerTool, projectDir: string) {
  const [available, setAvailable] = useState<SkillMeta[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setAvailable(discoverSkills(plannerTool, projectDir));
    setSelected(new Set());
  }, [plannerTool, projectDir]);

  const selectedMetas = available.filter(s => selected.has(s.id));

  return { available, selected, setSelected, selectedMetas };
}
