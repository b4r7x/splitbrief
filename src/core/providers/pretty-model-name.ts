const WORD_SPELLINGS: Readonly<Record<string, string>> = {
  gpt: 'GPT',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  mai: 'MAI',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  oss: 'OSS',
  o3: 'o3',
  o4: 'o4',
};

export function prettyModelName(modelId: string): string {
  // The leading path segments are routes and vendors; a bare-word tail (`kilo-auto/free`) is a
  // variant of the segment before it, so that segment stays.
  const segments = modelId.split('/');
  const tail = segments.slice(/^[a-z]+$/i.test(segments.at(-1) ?? '') ? -2 : -1).join('-');
  const parts = tail.split(/[-:]/).filter((part) => part !== '');

  const merged: string[] = [];
  let digits = '';
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      digits = digits === '' ? part : `${digits}.${part}`;
      continue;
    }
    if (digits !== '') {
      merged.push(digits);
      digits = '';
    }
    merged.push(part);
  }
  if (digits !== '') merged.push(digits);

  // Vendor catalogs join the brand to its next word (`GPT-5.6 Sol`, `GPT-OSS`) and spell a
  // parameter count in capitals (`30B`).
  return merged
    .map((word) =>
      /^\d+(\.\d+)?[bkm]$/i.test(word)
        ? word.toUpperCase()
        : (WORD_SPELLINGS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1)),
    )
    .join(' ')
    .replace(/^GPT /, 'GPT-');
}
