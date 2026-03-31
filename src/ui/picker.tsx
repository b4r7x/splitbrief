import { useState } from 'react';
import { Box, Text } from 'ink';
import { Select } from '@inkjs/ui';
import type { PlannerTool } from '../types.js';
import type { PlannerDetection, ImplementerDetection } from '../engine/detection.js';
import { getTheme } from '../theme.js';

type Step = 'planner' | 'implementer' | 'done';

interface PickerProps {
  planners: PlannerDetection[];
  implementers: ImplementerDetection[];
  onComplete: (planner: PlannerTool, provider: string, model: string) => void;
  onError: (message: string) => void;
}

function Picker({ planners, implementers, onComplete, onError }: PickerProps) {
  const t = getTheme();
  const availablePlanners = planners.filter((p) => p.available);
  const availableImplementers = implementers.filter((i) => i.available && i.models && i.models.length > 0);

  const [step, setStep] = useState<Step>('planner');
  const [selectedPlanner, setSelectedPlanner] = useState<PlannerTool | null>(null);

  if (availablePlanners.length === 0) {
    onError(
      'No planner backends detected.\n' +
      'Install one of: claude-code (npm i -g @anthropic-ai/claude-code), codex, opencode, aider, or agent-sdk.',
    );
    return <Text color={t.error}>No planner backends available.</Text>;
  }

  // Auto-select single planner
  if (step === 'planner' && availablePlanners.length === 1 && !selectedPlanner) {
    const tool = availablePlanners[0].tool;
    setSelectedPlanner(tool);
    if (availableImplementers.length === 0) {
      setStep('done');
    } else {
      setStep('implementer');
    }
  }

  // Build flat model list from implementers
  const allModels: Array<{ provider: string; model: string }> = [];
  for (const imp of availableImplementers) {
    for (const m of imp.models!) {
      allModels.push({ provider: imp.provider, model: m });
    }
  }

  // Auto-select single model
  if (step === 'implementer' && allModels.length === 1 && selectedPlanner) {
    onComplete(selectedPlanner, allModels[0].provider, allModels[0].model);
    return (
      <Box flexDirection="column">
        <Text color={t.success}>Auto-selected planner: {selectedPlanner}</Text>
        <Text color={t.success}>Auto-selected model: {allModels[0].provider} / {allModels[0].model}</Text>
      </Box>
    );
  }

  if (step === 'planner') {
    const options = availablePlanners.map((p) => ({ label: p.tool, value: p.tool }));
    return (
      <Box flexDirection="column">
        <Text bold color={t.text}>Select a planner backend:</Text>
        <Select
          options={options}
          onChange={(value) => {
            const tool = value as PlannerTool;
            setSelectedPlanner(tool);
            if (availableImplementers.length === 0) {
              setStep('done');
            } else {
              setStep('implementer');
            }
          }}
        />
      </Box>
    );
  }

  if (step === 'implementer' && selectedPlanner) {
    if (allModels.length === 0) {
      onError(
        `Selected planner: ${selectedPlanner}\n` +
        'No local models detected. Configure implementer manually in .tiny-spec/config.yaml\n' +
        'or start Ollama/LM Studio.',
      );
      return (
        <Box flexDirection="column">
          <Text color={t.accent}>Planner: {selectedPlanner}</Text>
          <Text color={t.warning}>No local models detected. Configure implementer manually.</Text>
        </Box>
      );
    }

    const options = allModels.map((m) => ({
      label: `${m.provider} / ${m.model}`,
      value: `${m.provider}::${m.model}`,
    }));

    return (
      <Box flexDirection="column">
        <Text color={t.accent}>Planner: {selectedPlanner}</Text>
        <Text bold color={t.text}>Select an implementer model:</Text>
        <Select
          options={options}
          onChange={(value) => {
            const [provider, model] = value.split('::');
            onComplete(selectedPlanner, provider, model);
          }}
        />
      </Box>
    );
  }

  if (step === 'done' && selectedPlanner) {
    onComplete(selectedPlanner, 'ollama', 'qwen2.5-coder:7b');
    return <Text color={t.accent}>Planner: {selectedPlanner} (no local models -- using defaults)</Text>;
  }

  return null;
}

export default Picker;
