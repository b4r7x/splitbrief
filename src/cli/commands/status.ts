import type { Command } from 'commander';
import ansis from 'ansis';
import { loadState } from '../../core/state/persistence.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
} from '../../core/state/selectors.js';
import { canonicalizeProjectDir } from '../setup.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import {
  getProviderDisplayName,
  getRunnerIdentityDisplayName,
} from '../../core/providers/catalog.js';
import type { RunnerKind } from '../../core/schemas/enums.js';
import type { CallUsageEvidence } from '../../core/schemas/usage-evidence.js';
import { resolveCallUsageEvidence } from '../../engine/orchestrator/summary/call-evidence.js';
import { cliVocabularyTool, formatModelName } from '../../core/model-display.js';
import { stripTerminalControls } from '../../utils/display-text.js';

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

      const sessionId = readActive(projectDir);
      const state = sessionId ? loadState({ projectDir, sessionId }) : null;

      if (!state) {
        console.log('No active workflow.');
      } else {
        // The displayed seat's own calls name its kind, so an API provider that
        // shares a name with a CLI tool is not reported as that CLI, and a seat
        // whose own record is ambiguous stays literal instead of guessing.
        const evidence =
          sessionId === null ? undefined : resolveCallUsageEvidence({ projectDir, sessionId });
        const seatLabel = (role: 'planner' | 'implementer', tool: string): string => {
          const recorded = recordedRunnerKind(evidence, role, tool);
          if (recorded === 'ambiguous') return tool;
          return recorded === undefined
            ? getProviderDisplayName(tool)
            : getRunnerIdentityDisplayName(recorded, tool);
        };
        const seatModelLabel = (
          role: 'planner' | 'implementer',
          tool: string,
          model: string,
        ): string => {
          const recorded = recordedRunnerKind(evidence, role, tool);
          const provider = recorded === 'ambiguous' ? undefined : cliVocabularyTool(tool, recorded);
          return stripTerminalControls(formatModelName(model, provider));
        };
        console.log(
          `${ansis.dim('Feature:')}  ${ansis.bold(stripTerminalControls(state.feature))}`,
        );
        const phaseSuffix = state.awaitingContinue ? ` ${ansis.yellow('(awaiting continue)')}` : '';
        console.log(`${ansis.dim('Phase:')}    ${ansis.bold(state.phase)}${phaseSuffix}`);
        // The cursor points one past the last brief once every brief has settled, so the
        // position is the brief it names, never a brief the run does not have.
        const position = Math.min(state.currentTaskIndex + 1, state.tasks.length);
        console.log(`${ansis.dim('Task:')}     ${position}/${state.tasks.length}`);
        console.log(`${ansis.dim('Started:')}  ${state.startedAt}`);
        console.log(`${ansis.dim('Session:')}  ${sessionId}`);

        if (state.plannerTool) {
          const model = state.plannerModel
            ? ` (${seatModelLabel('planner', state.plannerTool, state.plannerModel)})`
            : '';
          console.log(
            `${ansis.dim('Planner:')}  ${stripTerminalControls(seatLabel('planner', state.plannerTool))}${model}`,
          );
        }
        if (state.implementerTool) {
          const model = state.implementerModel
            ? ` (${seatModelLabel('implementer', state.implementerTool, state.implementerModel)})`
            : '';
          console.log(
            `${ansis.dim('Impl:')}     ${stripTerminalControls(seatLabel('implementer', state.implementerTool))}${model}`,
          );
        }

        const completed = getCompletedTaskIds(state);
        const escalated = getEscalatedTaskIds(state);
        const failed = getFailedTaskIds(state);
        if (completed.length > 0) {
          console.log(`${ansis.dim('Done:')}     ${ansis.green(String(completed.length))}`);
        }
        if (escalated.length > 0) {
          console.log(`${ansis.dim('Escalated:')} ${ansis.yellow(String(escalated.length))}`);
        }
        if (failed.length > 0) {
          console.log(`${ansis.dim('Failed:')}   ${ansis.red(String(failed.length))}`);
        }
      }
    });
}
