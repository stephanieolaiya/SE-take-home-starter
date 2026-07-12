import { describe, it, expect } from "vitest";
import { getTrialSummary } from "../services/analysis-service.js";
import { getTrialById } from "../services/trial-service.js";

describe("analysis-service", () => {
  describe("getTrialSummary", () => {
    it("does not throw for a trial with a null responseRate", () => {
      const trial = getTrialById("NCT-003")!;
      expect(trial.responseRate).toBeNull();

      expect(() => getTrialSummary(trial)).not.toThrow();
      const summary = getTrialSummary(trial);
      expect(summary.summary).toContain("not yet available");
    });

    it("includes the formatted response rate for a trial that has one", () => {
      const trial = getTrialById("NCT-001")!;
      const summary = getTrialSummary(trial);
      expect(summary.summary).toContain("38.5%");
    });
  });
});
