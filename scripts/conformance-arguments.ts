export type ConformanceOptionName = '--contract-json' | '--module' | '--role' | '--record';

export type ConformanceArguments = Readonly<{
  mode: 'raw' | 'production';
  options: Readonly<Partial<Record<ConformanceOptionName, string>>>;
}>;

export function parseConformanceArguments(
  args: readonly string[],
  accepted: readonly ConformanceOptionName[],
  usageError: (message: string) => never,
): ConformanceArguments {
  const [mode, ...rest] = args;
  if (mode !== 'raw' && mode !== 'production') usageError('mode must be raw or production');

  const options: Partial<Record<ConformanceOptionName, string>> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === undefined || !isAccepted(option, accepted)) {
      usageError(`unsupported option ${option ?? ''}`);
    }
    if (options[option] !== undefined) usageError(`${option} may appear once`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) usageError(`${option} requires a value`);
    options[option] = value;
    index += 1;
  }

  if (options['--record'] === undefined) usageError('--record is required');
  return { mode, options };
}

function isAccepted(
  option: string,
  accepted: readonly ConformanceOptionName[],
): option is ConformanceOptionName {
  return accepted.some((name) => name === option);
}
