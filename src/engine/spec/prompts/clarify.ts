import { buildPrompt, instructionsSection } from './shared.js';

export const DEFAULT_MAX_CLARIFY_QUESTIONS = 5;

export function buildClarifyPrompt(spec: string, maxQuestions: number = DEFAULT_MAX_CLARIFY_QUESTIONS): string {
  return buildPrompt({
    title: 'Spec Clarification',
    intro:
      'You are given a feature spec. Identify ambiguities or underspecified requirements that, if left unresolved, would cause a small local implementer to make wrong assumptions.',
    sections: [
      { heading: 'Spec', body: spec },
      instructionsSection(`Identify up to ${maxQuestions} concrete ambiguities in the spec.

For each, emit an inline marker on its own line:
<!-- Q:{"id":"Q1","question":"..."} -->

If the spec is sufficiently clear, emit zero markers and a single line:
"No clarifications needed."

Keep questions concrete and answerable with a short reply.`),
    ],
  });
}
