import { describe, it, expect } from "vitest";
import { listTrials, getTrialById } from "../services/trial-service.js";

describe("trial-service", () => {
  describe("getTrialById", () => {
    it("returns a trial for a valid ID", () => {
      const trial = getTrialById("NCT-001");
      expect(trial).toBeDefined();
      expect(trial!.name).toBe("AURORA-1: Pocenbrodib in mCRPC");
    });

    it("returns undefined for an invalid ID", () => {
      const trial = getTrialById("NCT-999");
      expect(trial).toBeUndefined();
    });
  });

  describe("listTrials", () => {
    it("returns all trials when no filters are applied", () => {
      const result = listTrials({});
      expect(result.trials.length).toBeGreaterThan(0);
      expect(result.total).toBe(result.trials.length);
    });

    it("filters by phase", () => {
      const result = listTrials({ phase: "III" });
      expect(result.trials.every((t) => t.phase === "III")).toBe(true);
    });

    it("filters by status", () => {
      const result = listTrials({ status: "completed" });
      expect(result.trials.every((t) => t.status === "completed")).toBe(true);
    });

    it("filters by minEnrollment", () => {
      const result = listTrials({ minEnrollment: 400 });
      expect(result.trials.every((t) => t.enrollment >= 400)).toBe(true);
      expect(result.trials.length).toBeGreaterThan(0);
    });

    it("sorts by startDate", () => {
      const result = listTrials({ sort: "startDate" });
      const dates = result.trials.map((t) => new Date(t.startDate).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]! <= dates[i - 1]!).toBe(true);
      }
    });

    it("sorts by startDate ascending when order=asc (oldest first)", () => {
      const result = listTrials({ sort: "startDate", order: "asc" });
      const dates = result.trials.map((t) => new Date(t.startDate).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i]! >= dates[i - 1]!).toBe(true);
      }
    });

    it("sorts by enrollment ascending", () => {
      const result = listTrials({ sort: "enrollment", order: "asc" });
      const enrollments = result.trials.map((t) => t.enrollment);
      for (let i = 1; i < enrollments.length; i++) {
        expect(enrollments[i]! >= enrollments[i - 1]!).toBe(true);
      }
    });

    it("matches a search term that only appears inside keyFindings text", () => {
      // "PSA50" appears only in NCT-001/NCT-007's keyFindings sentences, not in
      // their name, indication, or primaryEndpoint fields.
      const result = listTrials({ search: "psa50" });
      const ids = result.trials.map((t) => t.id);
      expect(ids).toContain("NCT-001");
      expect(ids).toContain("NCT-007");
    });

    it("still matches search terms found in name/indication (regression check)", () => {
      const result = listTrials({ search: "melanoma" });
      expect(result.trials.map((t) => t.id)).toContain("NCT-002");
    });

    it("does not mutate shared trial objects when searching", () => {
      listTrials({ search: "AURORA" });
      const trial = getTrialById("NCT-001");
      expect(trial).not.toHaveProperty("_score");
      expect(JSON.stringify(trial)).not.toContain("_score");
    });
  });
});
