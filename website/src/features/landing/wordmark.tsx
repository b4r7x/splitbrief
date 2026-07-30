export type WordmarkTier = 'full' | 'compact';

// Both tiers verbatim from src/features/home/logo.ts — the product's figlet wordmark.
export const WORDMARK_TIERS: Record<WordmarkTier, readonly string[]> = {
  full: [
    ' ____        _ _ _   _          _       __',
    '/ ___| _ __ | (_) |_| |__  _ __(_) ___ / _|',
    "\\___ \\| '_ \\| | | __| '_ \\| '__| |/ _ \\ |_",
    ' ___) | |_) | | | |_| |_) | |  | |  __/  _|',
    '|____/| .__/|_|_|\\__|_.__/|_|  |_|\\___|_|',
    '      |_|',
  ],
  compact: [
    ' ___      _ _ _   _        _      __',
    '/ __|_ __| (_) |_| |__ _ _(_)___ / _|',
    "\\__ \\ '_ \\ | |  _| '_ \\ '_| / -_)  _|",
    '|___/ .__/_|_|\\__|_.__/_| |_\\___|_|',
    '    |_|',
  ],
};

export interface WordmarkProps {
  readonly tier?: WordmarkTier;
  readonly className?: string;
}

export function WordmarkRows({ tier }: { readonly tier: WordmarkTier }) {
  const rows = WORDMARK_TIERS[tier];
  return (
    <>
      {rows.map((row, index) => (
        <span aria-hidden="true" key={row}>
          {index > 0 ? '\n' : null}
          {row}
        </span>
      ))}
    </>
  );
}

export function Wordmark({ tier = 'compact', className }: WordmarkProps) {
  const tierClass = `wordmark wordmark--${tier}`;
  const classes = className ? `${tierClass} ${className}` : tierClass;
  return (
    <pre aria-label="splitbrief" className={classes} role="img">
      <WordmarkRows tier={tier} />
    </pre>
  );
}
