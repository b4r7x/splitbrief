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

export function WorkflowHeader({ startedAt }: { startedAt: string }) {
  return (
    <>
      <Header startedAt={startedAt} />
      <ConfigLine />
      <AgentStatusRow />
      <CostStatusLine />
      <Box height={1} flexShrink={0} />
    </>
  );
}

export function WorkflowFooter({
  handleInput,
  onRuntimeCommand,
  commands,
  mode,
  inputHint,
  disabled,
}: {
  handleInput: (text: string) => void;
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
