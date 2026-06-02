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

export function fenced(body: string, lang = ''): string {
  return '```' + lang + '\n' + body + '\n```';
}

export function instructionsSection(body: string): PromptSection {
  return { heading: 'Instructions', body };
}

export function requiredSectionsSection(body: string): PromptSection {
  return { heading: 'Required Sections', body };
}
