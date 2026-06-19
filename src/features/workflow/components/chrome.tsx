import { Box } from 'ink';
import type { RuntimeCommandDef } from '../../../core/runtime/commands/types.js';
import type { InputMode } from '../../../core/navigation/types.js';
import { Composer } from '../../../components/composer/composer.js';
import { Header } from './header.js';
import { ConfigLine } from './config-line.js';
import { AgentStatusRow } from './agent-status-row.js';
import { CostStatusLine } from './cost/status-line.js';
import { FeedbackRow } from './feedback-row.js';
import { InputFooter } from './input-footer.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { createLatestEventByTypeSelector } from '../latest-event-selector.js';
import { getWorkflowConfigDensity, WorkflowConfigCard } from './event-cards/config.js';
import { getChromeContentWidth, INLINE_CONFIG_MIN_COLS } from '../layout/chrome-rows.js';

const selectLatestWorkflowConfig = createLatestEventByTypeSelector('workflow_config');

function WorkflowMetaRow() {
  const cols = terminalSizeStore.use((s) => s.cols);
  const configEvent = eventsStore.use(selectLatestWorkflowConfig);
  const canInlineConfig = configEvent !== undefined && cols >= INLINE_CONFIG_MIN_COLS;

  if (!configEvent) {
    return <CostStatusLine />;
  }

  if (!canInlineConfig) {
    return (
      <>
        <ConfigLine />
        <CostStatusLine />
      </>
    );
  }

  const contentWidth = getChromeContentWidth(cols);
  const costWidth = Math.min(56, Math.max(24, Math.floor(contentWidth * 0.36)));
  const configWidth = Math.max(20, contentWidth - costWidth - 4);

  return (
    <Box
      width="100%"
      height={1}
      overflow="hidden"
      paddingX={1}
      justifyContent="space-between"
      flexShrink={0}
    >
      <Box width={configWidth} height={1} overflow="hidden">
        <WorkflowConfigCard
          event={configEvent}
          density={getWorkflowConfigDensity(configEvent, configWidth)}
        />
      </Box>
      <CostStatusLine maxWidth={costWidth} paddingX={0} align="right" />
    </Box>
  );
}

export function WorkflowHeader({ startedAt }: { startedAt: string }) {
  return (
    <>
      <Header startedAt={startedAt} />
      <WorkflowMetaRow />
      <AgentStatusRow />
    </>
  );
}

export function WorkflowFooter({
  handleInput,
  onEmptySubmit,
  onRuntimeCommand,
  commands,
  mode,
  inputHint,
  disabled,
}: {
  handleInput: (text: string) => void;
  onEmptySubmit?: (() => void) | undefined;
  onRuntimeCommand: (command: string) => void;
  commands: RuntimeCommandDef[];
  mode: InputMode;
  inputHint: string;
  disabled: boolean;
}) {
  return (
    <>
      <FeedbackRow />
      <Composer
        onSubmit={handleInput}
        onEmptySubmit={onEmptySubmit}
        onRuntimeCommand={onRuntimeCommand}
        commands={commands}
        mode={mode}
        hint={inputHint}
        currentScreen="workflow"
        disabled={disabled}
      />
      <InputFooter />
    </>
  );
}
