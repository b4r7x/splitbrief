import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './theme.js';
import { useResponsiveLayout } from '../hooks/use-terminal-size.js';
import { Spinner } from './spinner.js';
import { PlannerPicker } from './planner-picker.js';
import type { PlannerOption } from './planner-picker.js';
import { ModelPicker } from './model-picker.js';
import type { ProviderGroup } from './model-picker.js';
import { detectAvailablePlanners, detectAvailableImplementers } from '../engine/detection.js';
import type { PlannerDetection } from '../engine/detection.js';
import type { ProviderDetection } from '../engine/providers/types.js';

type Step = 'detecting' | 'planner' | 'model' | 'done';

export interface InitWizardResult {
  planner: { tool?: string; provider?: string };
  implementer: { provider: string; model: string };
}

export interface InitWizardProps {
  onComplete: (config: InitWizardResult) => void;
  onCancel: () => void;
}

function toPlannerOptions(detections: PlannerDetection[]): PlannerOption[] {
  return detections.map((d) => ({
    name: d.tool,
    type: 'cli' as const,
    version: d.version,
    available: d.available,
  }));
}

function toProviderGroups(detections: ProviderDetection[]): ProviderGroup[] {
  const LOCAL_PROVIDERS = new Set(['ollama', 'lm-studio']);
  return detections
    .filter((d) => d.available && d.models && d.models.length > 0)
    .map((d) => ({
      name: d.provider,
      models: d.models!,
      isLocal: LOCAL_PROVIDERS.has(d.provider),
    }));
}

function stepLabel(step: Step, total: number): string {
  const stepNum = step === 'planner' ? 1 : step === 'model' ? 2 : 0;
  if (stepNum === 0) return '';
  return `Step ${stepNum}/${total}`;
}

export function InitWizard({ onComplete, onCancel }: InitWizardProps) {
  const t = useTheme();
  const { cols } = useResponsiveLayout();
  const [step, setStep] = useState<Step>('detecting');
  const [plannerOptions, setPlannerOptions] = useState<PlannerOption[]>([]);
  const [providerGroups, setProviderGroups] = useState<ProviderGroup[]>([]);
  const [selectedPlanner, setSelectedPlanner] = useState<{ name: string; type: 'cli' | 'api' } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([detectAvailablePlanners(), detectAvailableImplementers()]).then(
      ([planners, implementers]) => {
        if (cancelled) return;
        setPlannerOptions(toPlannerOptions(planners));
        setProviderGroups(toProviderGroups(implementers));
        setStep('planner');
      },
    ).catch(() => {
      if (cancelled) return;
      setStep('planner');
    });
    return () => { cancelled = true; };
  }, []);

  const totalSteps = 2;
  const label = stepLabel(step, totalSteps);

  if (step === 'detecting') {
    return (
      <Box flexDirection="column" width={cols} alignItems="center" paddingTop={2}>
        <Text bold color={t.accent}>Init Wizard</Text>
        <Box marginTop={1}>
          <Spinner label="Detecting available planners and models..." color={t.accent} />
        </Box>
      </Box>
    );
  }

  if (step === 'planner') {
    return (
      <Box flexDirection="column" width={cols}>
        <Box justifyContent="center" paddingTop={1}>
          <Text color={t.textDim}>{label}: Select planner</Text>
        </Box>
        <PlannerPicker
          planners={plannerOptions}
          onSelect={(planner) => {
            setSelectedPlanner(planner);
            setStep('model');
          }}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (step === 'model') {
    return (
      <Box flexDirection="column" width={cols}>
        <Box justifyContent="center" paddingTop={1}>
          <Text color={t.textDim}>{label}: Select implementer model</Text>
        </Box>
        <ModelPicker
          providers={providerGroups}
          onSelect={(provider, model) => {
            onComplete({
              planner: { tool: selectedPlanner?.name },
              implementer: { provider, model },
            });
            setStep('done');
          }}
          onCancel={() => setStep('planner')}
        />
      </Box>
    );
  }

  return null;
}
