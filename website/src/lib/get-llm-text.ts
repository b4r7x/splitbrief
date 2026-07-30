export interface LLMPage {
  url: string;
  data: {
    title: string;
    description?: string | undefined;
    getText(type: 'processed'): Promise<string>;
  };
}

export async function getLLMText(page: LLMPage): Promise<string> {
  const processed = (await page.data.getText('processed')).trimStart();
  const description = page.data.description ? `\n\n> ${page.data.description}` : '';

  return `# ${page.data.title} (${page.url})${description}\n\n${processed}`;
}
