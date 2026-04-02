import { useState, useMemo } from 'react';
import type { PlannerTool } from '../types.js';
import { discoverSkills } from '../engine/skills.js';

export function useSkills(plannerTool: PlannerTool, projectDir: string) {
  const available = useMemo(() => discoverSkills(plannerTool, projectDir), [plannerTool, projectDir]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const selectedMetas = useMemo(() => available.filter(s => selected.has(s.id)), [available, selected]);

  return { available, selected, setSelected, selectedMetas };
}
