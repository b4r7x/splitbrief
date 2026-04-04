import { createInterface } from 'node:readline';
import { createDefaultConfig, initConfig, writeConfig } from '../core/config.js';
import { getProvider } from '../engine/providers/registry.js';
import { detectAvailablePlanners, detectAvailableImplementers } from '../engine/detection.js';
import type { PlannerTool } from '../types.js';

export async function promptSelection(question: string, options: string[]): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<number>((res) => {
    console.log(question);
    options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
    rl.question('Selection: ', (answer) => {
      rl.close();
      const n = parseInt(answer, 10);
      if (n >= 1 && n <= options.length) {
        res(n - 1);
      } else {
        res(0);
      }
    });
  });
}

export async function runPicker(projectDir: string): Promise<void> {
  console.log('Detecting available planners and models...\n');
  const [planners, implementers] = await Promise.all([
    detectAvailablePlanners(),
    detectAvailableImplementers(),
  ]);

  const availablePlanners = planners.filter((p) => p.available);
  const availableImplementers = implementers.filter((i) => i.available && i.models && i.models.length > 0);

  if (availablePlanners.length === 0) {
    console.log('No planner backends detected.');
    console.log('Install one of: claude-code (npm i -g @anthropic-ai/claude-code), codex, opencode, aider, or agent-sdk.\n');
    console.log('Creating config with defaults (claude-code planner, ollama implementer).');
    initConfig(projectDir);
    return;
  }

  const formatPlannerName = (p: { tool: string; version?: string | null }) =>
    p.version ? `${p.tool} v${p.version}` : p.tool;

  let selectedTool: PlannerTool;
  if (availablePlanners.length === 1) {
    selectedTool = availablePlanners[0].tool;
    console.log(`Auto-selected planner: ${formatPlannerName(availablePlanners[0])}`);
  } else {
    const plannerOptions = availablePlanners.map((p) => formatPlannerName(p));
    const idx = await promptSelection('Select a planner backend:', plannerOptions);
    selectedTool = availablePlanners[idx].tool;
  }

  const allModels: Array<{ provider: string; model: string }> = [];
  for (const imp of availableImplementers) {
    for (const m of imp.models!) {
      allModels.push({ provider: imp.provider, model: m });
    }
  }

  const defaults = createDefaultConfig();
  defaults.planner.tool = selectedTool;

  if (allModels.length === 0) {
    console.log('\nNo local models detected. Using defaults (ollama / qwen2.5-coder:7b).');
    console.log('Start Ollama or LM Studio and run `tiny-spec init --reconfigure`.\n');
  } else if (allModels.length === 1) {
    const selected = allModels[0];
    console.log(`Auto-selected model: ${selected.provider} / ${selected.model}`);
    defaults.implementer.provider = selected.provider;
    defaults.implementer.model = selected.model;
  } else {
    console.log('');
    const modelOptions = allModels.map((m) => `${m.provider} / ${m.model}`);
    const idx = await promptSelection('Select a model for implementation:', modelOptions);
    defaults.implementer.provider = allModels[idx].provider;
    defaults.implementer.model = allModels[idx].model;
  }

  defaults.implementer.apiBase = getProvider(defaults.implementer.provider).baseURL || defaults.implementer.apiBase;

  writeConfig(projectDir, defaults);

  console.log(`\nCreated .tiny-spec/config.yaml (planner: ${selectedTool}, model: ${defaults.implementer.provider} / ${defaults.implementer.model})`);
}
