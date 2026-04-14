import type { WorkflowState, OrchestratorCallbacks, ClarificationQuestion } from '../../types.js';
import { readSpecFileOrEmpty, writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE } from '../../core/paths.js';
import { emit } from './events.js';

export async function collectAndPersistClarifications(
  questions: ClarificationQuestion[],
  projectDir: string,
  state: WorkflowState,
  onQuestionAsked: NonNullable<OrchestratorCallbacks['onQuestionAsked']>,
  metadata?: SpecMetadata | null,
): Promise<void> {
  const clarifications: Array<{ question: string; answer: string }> = [];
  const total = questions.length;

  for (const [qi, question] of questions.entries()) {
    const answer = await onQuestionAsked(question, qi + 1, total);

    if (answer === 'done') break;
    if (answer === 'skip' || answer === '') continue;

    clarifications.push({ question: question.text, answer });
  }

  if (clarifications.length === 0) return;

  let content = readSpecFileOrEmpty(projectDir, SPEC_FILE);
  const sessionHeader = `### Session ${new Date().toISOString().slice(0, 10)}`;
  const entries = clarifications.map(c => `- Q: ${c.question} \u2192 A: ${c.answer}`).join('\n');

  if (!content.includes('## Clarifications')) {
    content += `\n\n## Clarifications\n\n${sessionHeader}\n${entries}\n`;
  } else if (!content.includes(sessionHeader)) {
    content += `\n${sessionHeader}\n${entries}\n`;
  } else {
    content += `\n${entries}\n`;
  }

  writeSpecFile(projectDir, SPEC_FILE, content, metadata);
  emit(projectDir, state, 'clarifications_collected', undefined, {
    count: clarifications.length,
    clarifications,
  });
}
