import { StopSheet } from './sheet.js';
import { useStopMenuRows } from './use-menu-rows.js';

export function StopMenu({ height }: { height?: number | undefined }) {
  const { rows, footer } = useStopMenuRows();
  return <StopSheet height={height} rows={rows} footer={footer} />;
}
