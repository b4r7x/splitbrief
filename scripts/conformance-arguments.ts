export type ConformanceOptionName =
  | '--contract-json'
  | '--module'
  | '--role'
  | '--record'
  | '--tool'
  | '--model';

export type ConformanceArguments<Mode extends string> = Readonly<{
  mode: Mode;
  options: Readonly<Partial<Record<ConformanceOptionName, string>>>;
}>;

export function parseConformanceArguments<Mode extends string>(
  args: readonly string[],
  modes: readonly Mode[],
  accepted: readonly ConformanceOptionName[],
  usageError: (message: string) => never,
): ConformanceArguments<Mode> {
  const [mode, ...rest] = args;
  if (!isMode(mode, modes)) usageError(`mode must be ${modes.join(' or ')}`);

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

function isMode<Mode extends string>(
  value: string | undefined,
  modes: readonly Mode[],
): value is Mode {
  return modes.some((mode) => mode === value);
}
