export const BASELINE_RULE = {
  fingerprint: 'sha256',
  file: 'baseline-sha.txt',
  text: 'Before the first spawn, record one `sha256 <path>` line per file in `baseline-sha.txt`. A path is changed when its hash differs from its baseline line or when it has no baseline line; a file already dirty at run start is reported changed once a brief modifies it.',
} as const;
