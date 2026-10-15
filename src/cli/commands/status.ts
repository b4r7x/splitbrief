import type { Command } from 'commander';
import chalk from 'chalk';
import { plainTheme } from '../../core/theme/resolve.js';
import { paint } from '../../core/theme/paint.js';
import { loadState } from '../../core/state/persistence.js';
import { readSeatIdentityRecord } from '../../core/state/seats.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
} from '../../core/state/selectors.js';
import { canonicalizeProjectDir } from '../setup.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import { sessionStatusWord } from '../../core/sessions/display.js';
import { rowFor } from '../../core/sessions/io.js';
import { checkSessionLiveness } from '../../core/sessions/lockfile.js';
import { readSessionSummary } from '../../core/sessions/run-record-io.js';
import { deriveRunStatus } from '../../core/sessions/run-status.js';
import { sessionDir } from '../../core/paths.js';
import { candidateIdsOf, formatSeatIdentity, type SeatIds } from '../../core/crew/identity.js';
import type { RunnerKind } from '../../core/schemas/enums.js';
import type { CallUsageEvidence } from '../../core/schemas/usage-evidence.js';
import { resolveCallUsageEvidence } from '../../engine/orchestrator/summary/call-evidence.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { recordedSeatIdentityInput } from '../../engine/providers/model/display-names.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { loadRememberedCatalog } from '../bootstrap/discovery.js';

/**
 * The kind the displayed seat's own calls recorded for its tool name, when they
 * recorded exactly one. A seat whose calls recorded both an API and a CLI kind
 * for the same name is ambiguous and keeps the literal name; a seat with no
 * record at all is missing legacy evidence and resolves through the merged
 * catalog as before.
 */
function recordedRunnerKind(
  evidence: readonly CallUsageEvidence[] | undefined,
  role: 'planner' | 'implementer',
  tool: string,
): RunnerKind | 'ambiguous' | undefined {
  if (evidence === undefined) return undefined;
  const kinds = new Set<RunnerKind>();
  for (const call of evidence) {
    if (call.role !== role) continue;
    const runner = call.invocationIdentity?.runner;
    const id = runner?.id ?? call.runnerName;
    if (id !== tool) continue;
    kinds.add(runner?.kind ?? call.backendKind);
  }
  if (kinds.size === 0) return undefined;
  return kinds.size === 1 ? [...kinds][0] : 'ambiguous';
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current workflow state')
    .option('--project <dir>', 'Project directory (default: cwd)')
    .action(async (opts: { project?: string }) => {
      const projectDir = await canonicalizeProjectDir(opts);
      const theme = plainTheme();
      await loadRememberedCatalog(projectDir);

      const sessionId = readActive(projectDir);
      const state = sessionId ? loadState({ projectDir, sessionId }) : null;

      if (!state || sessionId === null) {
        console.log('No active workflow.');
      } else {
        const ref = { projectDir, sessionId };
        const evidence = resolveCallUsageEvidence(ref);
        const seats = readSeatIdentityRecord(ref);
        const seatIdentity = (role: 'planner' | 'implementer', seat: SeatIds): string => {
          const seatId = role === 'planner' ? 'plan' : 'build';
          const switchIndex =
            state.seatSwitches?.findLastIndex((change) => change.seat === seatId) ?? -1;
          const switched = state.seatSwitches?.[switchIndex];
          const current =
            switched?.toSeat !== undefined &&
            (seats?.ids === undefined ||
              seats.switchCount === undefined ||
              switchIndex >= seats.switchCount)
              ? candidateIdsOf(switched.toSeat)
              : seats?.ids?.[seatId];
          const selected = current ?? seat;
          const recorded = selected.kind ?? recordedRunnerKind(evidence, role, selected.tool);
          // API vocabulary keeps an ambiguous legacy name literal without selecting a CLI.
          const kind = recorded === 'ambiguous' ? 'api' : recorded;
          const ids =
            current !== undefined
              ? current
              : kind === undefined || kind === 'cli'
                ? candidateIdsOf(selected)
                : selected;
          return stripTerminalControls(
            formatSeatIdentity(
              recordedSeatIdentityInput({
                seat: { ...ids, kind: kind ?? ids.kind },
                role,
                cache: modelCacheStore,
              }),
            ),
          );
        };
        console.log(
          `${paint(theme.textDim, 'Feature:')}  ${chalk.bold(stripTerminalControls(state.feature))}`,
        );
        const status = deriveRunStatus({
          state,
          liveness: checkSessionLiveness(sessionDir(projectDir, sessionId)).alive
            ? 'alive'
            : 'not-alive',
        });
        const session = rowFor(
          {
            id: sessionId,
            feature: state.feature,
            startedAt: Date.parse(state.startedAt),
            completedAt: null,
            stateVersion: state.stateVersion,
          },
          status,
          readSessionSummary(ref),
        );
        console.log(
          `${paint(theme.textDim, 'Status:')}   ${chalk.bold(sessionStatusWord(session))}`,
        );
        // The cursor points one past the last brief once every brief has settled, so the
        // position is the brief it names, never a brief the run does not have.
        const position = Math.min(state.currentTaskIndex + 1, state.tasks.length);
        console.log(`${paint(theme.textDim, 'Task:')}     ${position}/${state.tasks.length}`);
        console.log(`${paint(theme.textDim, 'Started:')}  ${state.startedAt}`);
        console.log(`${paint(theme.textDim, 'Session:')}  ${sessionId}`);

        if (state.plannerTool) {
          console.log(
            `${paint(theme.textDim, 'Planner:')}  ${seatIdentity('planner', {
              tool: state.plannerTool,
              model: state.plannerModel,
              kind: state.plannerKind,
            })}`,
          );
        }
        if (state.implementerTool) {
          console.log(
            `${paint(theme.textDim, 'Impl:')}     ${seatIdentity('implementer', {
              tool: state.implementerTool,
              model: state.implementerModel,
              kind: state.implementerKind,
            })}`,
          );
        }

        const completed = getCompletedTaskIds(state);
        const escalated = getEscalatedTaskIds(state);
        const failed = getFailedTaskIds(state);
        if (completed.length > 0) {
          console.log(
            `${paint(theme.textDim, 'Done:')}     ${paint(theme.success, String(completed.length))}`,
          );
        }
        if (escalated.length > 0) {
          console.log(
            `${paint(theme.textDim, 'Escalated:')} ${paint(theme.warning, String(escalated.length))}`,
          );
        }
        if (failed.length > 0) {
          console.log(
            `${paint(theme.textDim, 'Failed:')}   ${paint(theme.error, String(failed.length))}`,
          );
        }
      }
    });
}
