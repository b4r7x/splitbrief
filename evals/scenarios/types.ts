export type QualityCheck = {
  name: string;
  check: (resultDir: string) => QualityCheckResult | Promise<QualityCheckResult>;
};

export type QualityCheckResult = {
  passed: boolean;
  detail: string;
};

export type EvalScenario = {
  id: string;
  name: string;
  feature: string;
  fixtureDir: string;
  qualityChecks: QualityCheck[];
};
