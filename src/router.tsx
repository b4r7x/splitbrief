import { Box, useInput } from 'ink';
import { useAppContext } from './app.js';
import { HomeScreen } from './screens/home.js';
import { WorkflowScreen } from './screens/workflow.js';
import { SummaryScreen } from './screens/summary.js';
import { HelpOverlay } from './components/help-overlay.js';
import { CommandPalette } from './components/command-palette.js';
import { SkillsPicker } from './components/skills-picker.js';
import { ConfigPicker } from './components/config-picker.js';
import type {
  Screen,
  RouteData,
  CommandPaletteItem,
  OverlayType,
  Session,
  Summary,
  WorkflowState,
} from './types.js';

interface RouterProps {
  screen: Screen;
  routeData: RouteData;
  overlayActive: OverlayType;
  exclusiveInput: boolean;
  onCloseOverlay: () => void;
  onOpenOverlay: (type: OverlayType) => void;
  onSetExclusive: (v: boolean) => void;
  sessions: Session[];
  paletteItems: CommandPaletteItem[];
  onSlashCommand: (raw: string, from: Screen) => void;
  navigate: (to: 'home' | 'workflow' | 'summary', data?: { feature?: string; summary?: Summary; resumeState?: WorkflowState }) => void;
}

export function Router({
  screen,
  routeData,
  overlayActive,
  exclusiveInput,
  onCloseOverlay,
  onOpenOverlay,
  onSetExclusive,
  sessions,
  paletteItems,
  onSlashCommand,
  navigate,
}: RouterProps) {
  const { availableSkills, selectedSkillIds, onSkillsConfirm } = useAppContext();
  const hasOverlay = overlayActive !== 'none';

  useInput(
    (_input, key) => {
      if (key.escape) onCloseOverlay();
    },
    { isActive: hasOverlay && !exclusiveInput },
  );

  const screenContent = (() => {
    switch (screen) {
      case 'home':
        return (
          <HomeScreen
            sessions={sessions}
            hasOverlay={hasOverlay}
            onStartWorkflow={(feat) => navigate('workflow', { feature: feat })}
            onSlashCommand={(raw) => onSlashCommand(raw, 'home')}
          />
        );

      case 'workflow':
        if (routeData.screen !== 'workflow') return null;
        return (
          <WorkflowScreen
            feature={routeData.feature}
            resumeState={routeData.resumeState}
            hasOverlay={hasOverlay}
            onComplete={(summary) => navigate('summary', { summary })}
            onSlashCommand={(raw) => onSlashCommand(raw, 'workflow')}
          />
        );

      case 'summary':
        if (routeData.screen !== 'summary') return null;
        return (
          <SummaryScreen
            summary={routeData.summary}
            onDone={() => navigate('home')}
            onSlashCommand={(raw) => onSlashCommand(raw, 'summary')}
          />
        );
    }
  })();

  return (
    <>
      <Box display={hasOverlay ? 'none' : 'flex'}>
        {screenContent}
      </Box>

      {overlayActive === 'help' && (
        <HelpOverlay currentScreen={screen} />
      )}

      {overlayActive === 'command-palette' && (
        <CommandPalette
          items={paletteItems}
          currentScreen={screen}
          onExecute={(item) => {
            onCloseOverlay();
            item.action();
          }}
          onClose={onCloseOverlay}
        />
      )}

      {overlayActive === 'skills' && (
        <SkillsPicker
          skills={availableSkills}
          selected={selectedSkillIds}
          onConfirm={(selected) => {
            onSkillsConfirm(selected);
            onCloseOverlay();
          }}
          onClose={onCloseOverlay}
        />
      )}

      {overlayActive === 'picker' && (
        <ConfigPicker onClose={onCloseOverlay} onSetExclusive={onSetExclusive} />
      )}
    </>
  );
}
