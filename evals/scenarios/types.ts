export type QualityCheck = {
  name: string;
  check: (resultDir: string) => Promise<QualityCheckResult>;
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
  mode: 'quick';
  qualityChecks: QualityCheck[];
};
