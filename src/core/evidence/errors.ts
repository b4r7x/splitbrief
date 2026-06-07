import { error, matches } from '../../utils/error.js';

export const evidenceError = {
  ledgerNotFound: () =>
    error('evidence-ledger-not-found', 'Evidence ledger not found for this session'),
  isLedgerNotFound: matches('evidence-ledger-not-found'),
} as const;
