import { error, matches } from '../../utils/error.js';

export const evidenceError = {
  ledgerNotFound: () =>
    error('evidence-ledger-not-found', 'Evidence ledger not found for this session'),
  isLedgerNotFound: matches('evidence-ledger-not-found'),
  lockTimeout: (lockPath: string) =>
    error('evidence-ledger-lock-timeout', `timed out acquiring evidence ledger lock: ${lockPath}`, {
      lockPath,
    }),
  isLockTimeout: matches('evidence-ledger-lock-timeout'),
} as const;
