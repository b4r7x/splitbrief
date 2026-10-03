import { TASKS_FILE } from '../../../../src/core/paths.js';
import { buildArtifactExcerpt } from '../../../../src/engine/orchestrator/artifact-card.js';
import { formatTasks } from '../../../../src/engine/spec/formatter.js';
import { makeTask } from '../../../helpers/factories/task.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const CARD_TS = 1_783_958_400_000;
const CARD_FEATURE = 'Visual fixture workflow';

// A 2026-09-25 run's briefs with the number of files each declared. `formatTasks` writes one
// header line per file and dependency, so T004 and T006 run to 13 and 14 lines; the card is built
// from that document by the production excerpt, not typed in here.
const TASKS_CARD_BRIEFS = [
  ['T001', 'Give the reviewer every recorded validation entry', 4],
  ['T002', "Name scripts/ and evals/ in the brief contract's consumer rule", 4],
  ['T003', "Keep the owner's committed files out of drift analysis", 2],
  ['T004', 'Report committed-only files and pass them to drift at the final review', 6],
  ['T005', "Count a direct writer's promoted lines in implementer_generate_done", 5],
  ['T006', 'Hand the workspace snapshot to every direct-writer implementer call', 7],
  ['T007', 'Stop naming promoted files as unpromoted leftovers at a fresh reseed', 2],
] as const;

const tasksCardDocument = formatTasks(
  TASKS_CARD_BRIEFS.map(([id, title, fileCount], index) =>
    makeTask({
      id,
      title,
      file: `src/brief-${index + 1}/0.ts`,
      files: Array.from({ length: fileCount }, (_, file) => `src/brief-${index + 1}/${file}.ts`),
      dependsOn: id === 'T004' ? ['T003'] : id === 'T006' ? ['T005'] : [],
    }),
  ),
);

export const tasksCardProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-tasks-card'),
  feature: CARD_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: CARD_TS,
      phase: 'planning',
      feature: CARD_FEATURE,
    },
    {
      type: 'planner_status',
      ts: CARD_TS + 100,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'plan',
    },
    {
      type: 'artifact_written',
      ts: CARD_TS + 200,
      phase: 'planning',
      filename: TASKS_FILE,
      path: `.splitbrief/sessions/2026-09-25-fix-the-four-part-b-defects/${TASKS_FILE}`,
      ...buildArtifactExcerpt(tasksCardDocument, TASKS_FILE),
    },
  ],
};
