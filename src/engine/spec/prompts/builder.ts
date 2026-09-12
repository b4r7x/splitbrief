export type PromptSection = {
  heading: string;
  body: string;
};

type PromptSpec = {
  title: string;
  intro: string;
  sections: PromptSection[];
  output?: string | undefined;
};

export function buildPrompt(spec: PromptSpec): string {
  const parts: string[] = [`# ${spec.title}`, '', spec.intro];

  for (const section of spec.sections) {
    parts.push('', `## ${section.heading}`, section.body);
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

export function instructionsSection(body: string): PromptSection {
  return { heading: 'Instructions', body };
}

export function requiredSectionsSection(body: string): PromptSection {
  return { heading: 'Required Sections', body };
}
