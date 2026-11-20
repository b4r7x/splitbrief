import { useStdout } from 'ink';
import { ListRow } from '../../src/components/list-row/row.js';
import { planListRows, type ListRowModel } from '../../src/components/list-row/plan.js';
import type { ListRowState } from '../../src/components/list-row/lead.js';

export function ListRowFixture({
  width,
  state,
  ...model
}: ListRowModel & { width?: number; state?: ListRowState }) {
  const { stdout } = useStdout();
  const [line] = planListRows([model], { width: width ?? stdout.columns });
  return (
    line && (
      <ListRow
        line={line}
        selected={state === 'active'}
        state={state}
        width={model.maxWidth ?? width}
      />
    )
  );
}
