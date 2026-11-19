import { plainUserMessage } from '../../../core/types/user-input.js';
import { Box } from 'ink';
import { fitKeyLegend } from '../../../components/key-legend.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { assertNever } from '../../../utils/type-guards.js';
import { MenuRows } from './menu-rows.js';
import { cancelBoundaryPause, requestBoundaryPause } from '../run-requests/boundary.js';
import { requestStopNow, requestResume } from '../run-requests/stop-resume.js';
import { requestLeaveSession } from '../run-requests/departure.js';
import { requestEndRun } from '../run-requests/end-run.js';
import {
  STOP_SHEET_LEGEND,
  STOP_SHEET_PARKED_LEGEND,
  STOP_SHEET_TITLE,
  type StopRow,
  type StopRowId,
} from './options.js';
import { inlineMenuChrome, inlineMenuLayout } from '../inline-menu/layout.js';
import { InlineMenuPanel } from '../inline-menu/panel.js';
import { useInlineMenuKeys } from '../inline-menu/use-keys.js';

function performStop(id: StopRowId): void {
  switch (id) {
    case 'resume': {
      const refusal = requestResume(plainUserMessage(''));
      if (refusal !== undefined) feedbackStore.setMessage(refusal);
      return;
    }
    case 'leave':
      requestLeaveSession();
      return;
    case 'retry-stop':
    case 'stop-now':
      requestStopNow();
      return;
    case 'pause-after-brief':
      requestBoundaryPause();
      return;
    case 'keep-running':
      cancelBoundaryPause();
      return;
    case 'end-run':
      requestEndRun();
      return;
    default:
      assertNever(id);
  }
}

export function StopSheet({
  rows,
  height,
  footer,
}: {
  rows: readonly StopRow[];
  height?: number | undefined;
  footer: string | null;
}) {
  const cols = terminalSizeStore.use((state) => state.cols);
  const layout = inlineMenuLayout(rows, cols);
  const title = rows.some((row) => row.id === 'leave') ? 'Session options' : STOP_SHEET_TITLE;
  const legend = rows.some((row) => row.id === 'leave')
    ? STOP_SHEET_PARKED_LEGEND
    : STOP_SHEET_LEGEND;
  const boxHeight = height ?? layout.height;
  const chrome = inlineMenuChrome(boxHeight, layout.bodyRows);

  const selectedIndex = useInlineMenuKeys<StopRow>({
    items: rows,
    // The run keeps going behind the sheet and the middle row comes and goes with the running
    // brief, so the cursor is pinned to its row id rather than to a slot End run can slide into.
    keyOf: (row) => row.id,
    focused: true,
    listRows: chrome.listRows,
    onSelect: (row) => {
      overlayStore.close();
      performStop(row.id);
    },
    onTab: () => overlayStore.close(),
  });

  return (
    <InlineMenuPanel
      width={layout.width}
      height={boxHeight}
      framed={chrome.framed}
      focused
      title={
        chrome.titled
          ? fitKeyLegend(
              footer === null ? title : `${title} · ${footer}`,
              Math.max(1, layout.width - 4),
            )
          : undefined
      }
      legend={chrome.legend ? legend : undefined}
    >
      <Box height={chrome.listRows} flexDirection="column" flexShrink={0}>
        <MenuRows
          options={layout.options}
          selectedIndex={selectedIndex}
          cursor="focused"
          rowBudget={chrome.listRows}
          width={layout.width - 4}
        />
      </Box>
    </InlineMenuPanel>
  );
}
