import { useEffect, useState } from 'react';
import type { Summary } from '../../../core/schemas/summary.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { configStore } from '../../../stores/project/config.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger.js';

interface SummaryEvidenceLedgerState {
  key: string;
  ledger: EvidenceLedger | null;
}

export function useSummaryEvidenceLedger(
  summary: Summary | null,
  sessionId: string | undefined,
): EvidenceLedger | null {
  const projectDir = configStore.use((s) => s.projectDir);
  const evidencePath = summary?.evidenceSummary?.path;
  const ledgerKey =
    projectDir && sessionId && evidencePath
      ? `${projectDir}\u0000${sessionId}\u0000${evidencePath}`
      : '';
  const [state, setState] = useState<SummaryEvidenceLedgerState>({ key: '', ledger: null });

  useEffect(() => {
    if (!projectDir || !sessionId || !evidencePath) {
      setState((current) =>
        current.key === ledgerKey && current.ledger === null
          ? current
          : { key: ledgerKey, ledger: null },
      );
      return;
    }

    let ledger: EvidenceLedger | null = null;
    try {
      ledger = readEvidenceLedger({ projectDir, sessionId });
    } catch {
      ledger = null;
    }
    setState({ key: ledgerKey, ledger });
  }, [projectDir, sessionId, evidencePath, ledgerKey]);

  return state.key === ledgerKey ? state.ledger : null;
}
