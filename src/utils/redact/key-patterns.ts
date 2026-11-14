type RedactionReplacement = string | ((substring: string, ...args: string[]) => string);

interface RedactionRule {
  pattern: RegExp;
  replacement: (marker: string) => RedactionReplacement;
}

// Order matters: structured multi-line secrets first, specific prefixes before generic sk-,
// then keyword-contextual patterns.
export const KEY_PATTERNS: RedactionRule[] = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: (marker) => `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`,
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----(?![\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----)[\s\S]*$/g,
    replacement: (marker) => marker,
  },
  {
    pattern: /-----END PGP PRIVATE KEY BLOCK-----/g,
    replacement: (marker) => marker,
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sk-ant-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-or-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sk-or-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])gsk_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `gsk_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])xai-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `xai-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glhf_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glhf_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{20,128}(?![A-Za-z0-9])/g,
    replacement: (marker) => `hf_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(do[por]_v1_)[A-Za-z0-9_-]{20,128}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])((?:s|r)k_(?:live|test)_)[A-Za-z0-9]{16,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{16,128}(?![A-Za-z0-9])/g,
    replacement: (marker) => `whsec_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9])/g,
    replacement: (marker) => `SG.${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])xapp-1-[A-Za-z0-9-]{20,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => `xapp-1-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])pypi-[A-Za-z0-9_-]{20,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => `pypi-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9])/g,
    replacement: (marker) => `GOCSPX-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])sntrys_[A-Za-z0-9+/_=-]{64,512}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sntrys_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])dapi[a-f0-9]{32}(?:-\d)?(?![A-Za-z0-9])/g,
    replacement: (marker) => `dapi${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])pul-[a-f0-9]{40}(?![A-Za-z0-9])/g,
    replacement: (marker) => `pul-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])lin_api_[A-Za-z0-9]{40}(?![A-Za-z0-9])/g,
    replacement: (marker) => `lin_api_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glsa_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glrt-[A-Za-z0-9_-]{20}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glrt-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])NRAK-[A-Za-z0-9]{27}(?![A-Za-z0-9])/g,
    replacement: (marker) => `NRAK-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])PMAK-[A-Fa-f0-9]{24}-[A-Fa-f0-9]{34}(?![A-Za-z0-9])/g,
    replacement: (marker) => `PMAK-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `AIza${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{12,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `github_pat_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(gh[opur]_)[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(ghs_)[A-Za-z0-9._-]{36,}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `glpat-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `npm_${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])(xox[baprs])[-_][A-Za-z0-9_=-]{8,256}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}-${marker}`,
  },
  {
    pattern:
      /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])/g,
    replacement: (marker) => marker,
  },
  {
    pattern: /(?<![A-Za-z0-9])(AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    replacement: (marker) => (_match, prefix: string) => `${prefix}${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9])/g,
    replacement: (marker) => `sk-${marker}`,
  },
  {
    pattern: /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9])/gi,
    replacement: (marker) => `Bearer ${marker}`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    replacement: (marker) => (_match, protocol: string) => `${protocol}${marker}@`,
  },
];
