export type PromptSection = {
  heading: string;
  body: string;
};

export const plannerInteractionInstructions = `SPLITBRIEF handles all interaction with the user. When you need a decision to complete this step, return the question in your final response and end this turn. SPLITBRIEF will collect the answer and continue the same step.
Do not invoke or search for native user-question tools, including AskUserQuestion. Do not wait for input inside this invocation. Do not invent requirements or present an unfinished document as complete.`;

export const plannerConversationSection: PromptSection = {
  heading: 'Clarifications',
  body: `${plannerInteractionInstructions}
You may optionally provide up to five interactive questions as markers:
<!-- Q:{"id":"scope","type":"input","text":"Which module should change?"} -->
<!-- Q:{"id":"approach","type":"choice","text":"Which approach?","options":["Option 1","Option 2"],"default":"Option 1"} -->
Use type "confirm" with a boolean default for yes/no questions. Input and choice defaults are strings. Ordinary questions are also accepted.`,
};

/** A section the caller rendered whole, heading included: the run's skills block. */
export type PromptPart = PromptSection | string;

type PromptSpec = {
  title: string;
  intro: string;
  sections: PromptPart[];
  output?: string | undefined;
};

export function buildPrompt(spec: PromptSpec): string {
  const parts: string[] = [`# ${spec.title}`, '', spec.intro];

  for (const section of spec.sections) {
    if (typeof section === 'string') parts.push('', section);
    else parts.push('', `## ${section.heading}`, section.body);
  }

  if (spec.output !== undefined) {
    parts.push('', '## Output', spec.output);
  }

  return parts.join('\n');
}

/**
 * A diff or a captured log carries its own backtick runs — a markdown file in a
 * unified diff contributes ` ``` ` as a context line — so the fence is one
 * backtick longer than the longest run in the body and no content line can
 * close the data block.
 */
export function fenced(body: string, lang = ''): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return fence + lang + '\n' + body + '\n' + fence;
}

/** The run's skills as a section of their own, never inside another section's body. */
export function skillsSection(skillsContext: string | undefined): PromptPart[] {
  return skillsContext ? [skillsContext] : [];
}

export function instructionsSection(body: string): PromptSection {
  return { heading: 'Instructions', body };
}

export function requiredSectionsSection(body: string): PromptSection {
  return { heading: 'Required Sections', body };
}
