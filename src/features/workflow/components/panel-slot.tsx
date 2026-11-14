import type { RunRecord } from '../../../core/sessions/run/record.js';
import type { usePanels } from '../hooks/workflow-screen/use-panels.js';
import { ResultMenu } from '../result/menu.js';
import { showRunDiff } from '../result/show-diff.js';
import { StopMenu } from '../stop/menu.js';

/** The menu above the composer: the stop sheet, or else the result menu of a run ready to apply. */
export function PanelSlot({
  stopMenuOpen,
  height,
  ready,
  panels,
  keysHeldAbove,
  onCommand,
}: {
  stopMenuOpen: boolean;
  height: number;
  ready: RunRecord | undefined;
  panels: ReturnType<typeof usePanels>;
  keysHeldAbove: boolean;
  onCommand: (raw: string) => void;
}) {
  if (stopMenuOpen) return <StopMenu height={height} />;
  return (
    <ResultMenu
      {...panels.resultMenu}
      height={height}
      onConfirmingChange={panels.setConfirming}
      focused={panels.result.focused && !keysHeldAbove}
      onFocusChange={panels.result.setMenu}
      onCommand={onCommand}
      onShowDiff={() => {
        if (ready !== undefined) void showRunDiff(ready);
      }}
    />
  );
}
