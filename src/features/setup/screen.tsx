import { useState } from 'react';
import { type ReactNode } from 'react';
import { Text, useApp } from 'ink';
import { useTheme } from '../../components/theme.js';
import { OverlayPanel } from '../../components/overlays/overlay-panel.js';
import { routerStore } from '../../stores/navigation/router.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { useStores } from '../../stores/use-stores.js';
import type { Config } from '../../core/schemas/config.js';

type Step = 'no-planners' | 'planner' | 'implementer';

export interface SetupToolPickerArgs {
  role: 'planner' | 'implementer';
  stepLabel: string;
  onConfirm: (updated: Config) => void;
  onCancel: () => void;
}

interface SetupScreenProps {
  renderToolPicker: (args: SetupToolPickerArgs) => ReactNode;
}

export function SetupScreen({ renderToolPicker }: SetupScreenProps) {
  const t = useTheme();
  const { exit } = useApp();
  const [{ planners }, { projectDir }] = useStores(detectionStore, configStore);
  const onComplete = routerStore.use(s => s.screen === 'setup' ? s.onComplete : undefined);
  const pendingFeature = routerStore.use(s => s.screen === 'setup' ? s.feature : undefined);

  const [step, setStep] = useState<Step>(() =>
    planners.filter(p => p.available).length === 0 ? 'no-planners' : 'planner',
  );

  const finalize = (finalConfig: Config) => {
    if (!projectDir) return;
    const result = configStore.save(finalConfig);
    if (!result.ok) {
      if (result.error) feedbackStore.setError(`Failed to save config: ${result.error.message}`);
      return;
    }
    if (onComplete === 'workflow' && pendingFeature) {
      routerStore.navigate({ to: 'workflow', feature: pendingFeature });
    } else {
      routerStore.navigate({ to: 'home' });
    }
  };

  if (step === 'no-planners') {
    return (
      <OverlayPanel title="Setup — Planner" hint="Install a planner, then run init again">
        <Text color={t.warning}>No planner tools detected.</Text>
        <Text color={t.textDim}>Install one of:</Text>
        <Text color={t.text}>  npm i -g @anthropic-ai/claude-code</Text>
        <Text color={t.text}>  npm i -g @openai/codex</Text>
        <Text color={t.textDim}>Then run <Text bold>diptych init</Text> again.</Text>
      </OverlayPanel>
    );
  }

  if (step === 'planner') {
    return renderToolPicker({
      role: 'planner',
      stepLabel: 'Choose Planner (1/2)',
      onConfirm: (updated) => {
        const result = configStore.save(updated);
        if (result.ok) {
          setStep('implementer');
        } else if (result.error) {
          feedbackStore.setError(`Failed to save config: ${result.error.message}`);
        }
      },
      onCancel: exit,
    });
  }

  return renderToolPicker({
    role: 'implementer',
    stepLabel: 'Choose Model (2/2)',
    onConfirm: finalize,
    onCancel: () => setStep('planner'),
  });
}
