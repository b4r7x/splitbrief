import { SPEC_FILE, TASKS_FILE } from '../../../../src/core/paths.js';
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
      call: 'tasks',
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

const specSection = (heading: string, subsections: readonly string[]): string[] => [
  heading,
  '',
  ...subsections.flatMap((title) => [`### ${title}`, '', `${title}.`, '']),
];

// The title stands over two sections of six subsections each: the card lists the two and counts
// the twelve it does not nest, and the title is not one of them.
const titledSpecDocument = [
  '# Spec: Email validation',
  '',
  ...specSection('## Requirements', [
    'Reject an address with no domain',
    'Trim surrounding whitespace',
    'Show the message under the field',
    'Keep the typed value after a failed submit',
    'Accept plus addressing',
    'Refuse an address over 254 characters',
  ]),
  ...specSection('## Acceptance Criteria', [
    'A missing domain is refused',
    'Whitespace is trimmed',
    'The message names the problem',
    'The typed value survives',
    'Plus addressing passes',
    'A 255-character address is refused',
  ]),
].join('\n');

// The shapes the card once read apart from the parser: T001 opens a code sample it never closes,
// T002's long title is a YAML block scalar, and T003 carries a sample of its own.
const openFenceTasksDocument = [
  formatTasks([
    makeTask({
      id: 'T001',
      title: 'Reject an address with no domain',
      file: 'src/email/validate.ts',
      description: 'Refuse `user@` before it reaches the server:\n```ts\nif (!domainOf(address)) {',
    }),
  ]),
  '---',
  'id: T002',
  'title: >-',
  '  Trim surrounding whitespace before the',
  '  address is checked',
  'action: create',
  'file: src/email/normalize.ts',
  'depends_on: []',
  '---',
  '',
  '### Description',
  'Trim the input before any rule reads it.',
  formatTasks([
    makeTask({
      id: 'T003',
      title: 'Show the validation message under the field',
      file: 'src/email/field.tsx',
      signature: 'export function validationMessage(address: string): string | null',
      dependsOn: ['T001'],
    }),
  ]),
].join('\n');

const SPEC_TASKS_SESSION = '.splitbrief/sessions/2026-09-25-email-validation';

export const specTasksCardsProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-spec-tasks-cards'),
  feature: CARD_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    {
      type: 'workflow_started',
      ts: CARD_TS,
      phase: 'specifying',
      feature: CARD_FEATURE,
    },
    {
      type: 'artifact_written',
      ts: CARD_TS + 100,
      phase: 'specifying',
      filename: SPEC_FILE,
      path: `${SPEC_TASKS_SESSION}/${SPEC_FILE}`,
      ...buildArtifactExcerpt(titledSpecDocument, SPEC_FILE),
    },
    {
      type: 'planner_status',
      ts: CARD_TS + 200,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: 'fixture-planner-v1',
      call: 'tasks',
    },
    {
      type: 'artifact_written',
      ts: CARD_TS + 300,
      phase: 'planning',
      filename: TASKS_FILE,
      path: `${SPEC_TASKS_SESSION}/${TASKS_FILE}`,
      ...buildArtifactExcerpt(openFenceTasksDocument, TASKS_FILE),
    },
  ],
};
