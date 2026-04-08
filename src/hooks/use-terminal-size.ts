import { useState, useEffect } from "react";
import { useStdout } from "ink";

const MEDIUM_BREAKPOINT = 120;

export function useResponsiveLayout() {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setDimensions({ cols: stdout.columns, rows: stdout.rows });
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  return {
    cols: dimensions.cols,
    rows: dimensions.rows,
    isSmall: dimensions.cols < MEDIUM_BREAKPOINT,
  };
}
