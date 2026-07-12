import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDataPipeline,
  runDataPipelineFromFile,
  parseCsv,
  parseFlexibleDate,
  normalizeSex,
  normalizeResponseAssessment,
  validateStatus,
  redactPii,
  FIELD_COUNT_MISMATCH_KEY,
} from "../services/data-pipeline.js";

const HEADER =
  "patient_id,trial_id,site_id,enrollment_date,age,sex,weight_kg,dose_level,adverse_events,lab_notes,response_assessment,last_visit_date,status";

function csvOf(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

function baseRow(overrides: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    patient_id: "PT-100",
    trial_id: "NCT-001",
    site_id: "SITE-A01",
    enrollment_date: "2023-01-01",
    age: "50",
    sex: "M",
    weight_kg: "80.0",
    dose_level: "400mg BID",
    adverse_events: "fatigue",
    lab_notes: "Routine visit, no concerns.",
    response_assessment: "stable_disease",
    last_visit_date: "2023-06-01",
    status: "active",
  };
  const merged = { ...defaults, ...overrides };
  const fields = [
    "patient_id",
    "trial_id",
    "site_id",
    "enrollment_date",
    "age",
    "sex",
    "weight_kg",
    "dose_level",
    "adverse_events",
    "lab_notes",
    "response_assessment",
    "last_visit_date",
    "status",
  ];
  return fields.map((f) => `"${merged[f]}"`).join(",");
}

describe("data-pipeline", () => {
  describe("parseCsv", () => {
    it("handles commas embedded inside quoted fields without misaligning columns", () => {
      const csv = csvOf(
        baseRow({ lab_notes: "PSA 12.4 ng/mL at baseline, declining trend" })
      );
      const rows = parseCsv(csv);
      expect(rows).toHaveLength(1);
      expect(rows[0]!["lab_notes"]).toBe(
        "PSA 12.4 ng/mL at baseline, declining trend"
      );
      expect(rows[0]!["status"]).toBe("active");
    });

    it("flags a row whose unquoted comma splits one field into two", () => {
      // A comma in lab_notes that ISN'T wrapped in quotes is invalid CSV —
      // it shifts every subsequent column by one. This should be detected
      // via a field-count mismatch, not silently misparsed.
      const csv = [
        HEADER,
        'PT-201,NCT-001,SITE-A01,2023-01-01,50,M,80.0,400mg BID,fatigue,PSA 12.4 ng/mL at baseline, declining trend,stable_disease,2023-06-01,active',
      ].join("\n");
      const rows = parseCsv(csv);
      expect(rows[0]![FIELD_COUNT_MISMATCH_KEY]).toBeDefined();
    });

    it("throws a clear error when the CSV doesn't match the expected schema, instead of quarantining every row individually", () => {
      const wrongSchemaCsv = "name,value\nfoo,bar";
      expect(() => parseCsv(wrongSchemaCsv)).toThrow(
        /does not match the expected patient data schema/
      );
    });
  });

  describe("parseFlexibleDate", () => {
    it("passes through ISO YYYY-MM-DD unchanged", () => {
      expect(parseFlexibleDate("2023-04-12")).toBe("2023-04-12");
    });

    it("normalizes YYYY/MM/DD to ISO", () => {
      expect(parseFlexibleDate("2023/11/01")).toBe("2023-11-01");
    });

    it("normalizes MM/DD/YYYY to ISO when unambiguous", () => {
      expect(parseFlexibleDate("04/25/2023")).toBe("2023-04-25");
    });

    it("normalizes DD/MM/YYYY to ISO when unambiguous (day > 12)", () => {
      expect(parseFlexibleDate("15/05/2024")).toBe("2024-05-15");
    });

    it("normalizes 'Mon DD YYYY' to ISO", () => {
      expect(parseFlexibleDate("Jun 20 2023")).toBe("2023-06-20");
      expect(parseFlexibleDate("Mar 15 2024")).toBe("2024-03-15");
    });

    it("returns null for a genuinely ambiguous ##/##/YYYY date rather than guessing", () => {
      expect(parseFlexibleDate("03/04/2024")).toBeNull();
    });

    it("returns null for unparseable garbage", () => {
      expect(parseFlexibleDate("not a date")).toBeNull();
    });
  });

  describe("normalizeSex", () => {
    it("normalizes M/Male to M, case-insensitively", () => {
      expect(normalizeSex("M")).toBe("M");
      expect(normalizeSex("Male")).toBe("M");
      expect(normalizeSex("male")).toBe("M");
    });

    it("normalizes F/Female to F, case-insensitively", () => {
      expect(normalizeSex("F")).toBe("F");
      expect(normalizeSex("Female")).toBe("F");
      expect(normalizeSex("female")).toBe("F");
    });

    it("returns null for unrecognized values", () => {
      expect(normalizeSex("Unknown")).toBeNull();
    });
  });

  describe("normalizeResponseAssessment", () => {
    it("maps N/A to null", () => {
      expect(normalizeResponseAssessment("N/A")).toBeNull();
    });

    it("normalizes the non-standard 'confirmed_response' to 'partial_response'", () => {
      expect(normalizeResponseAssessment("confirmed_response")).toBe(
        "partial_response"
      );
    });

    it("passes through already-standard values unchanged", () => {
      expect(normalizeResponseAssessment("stable_disease")).toBe(
        "stable_disease"
      );
    });
  });

  describe("validateStatus", () => {
    it("accepts the four known status values", () => {
      expect(validateStatus("active")).toBe("active");
      expect(validateStatus("completed")).toBe("completed");
      expect(validateStatus("withdrawn")).toBe("withdrawn");
      expect(validateStatus("screen_fail")).toBe("screen_fail");
    });

    it("rejects unrecognized status values", () => {
      expect(validateStatus("in_progress")).toBeNull();
    });
  });

  describe("redactPii", () => {
    it("redacts a patient name and MRN while preserving clinical content", () => {
      const { text, redacted } = redactPii(
        "Patient John Williams (MRN: 4451892) requires close monitoring"
      );
      expect(redacted).toBe(true);
      expect(text).not.toContain("John Williams");
      expect(text).not.toContain("4451892");
      expect(text).toContain("requires close monitoring");
    });

    it("redacts an SSN-like pattern", () => {
      const { text, redacted } = redactPii(
        "Patient SSN visible in old system: 412-XX-8891. DLT declared."
      );
      expect(redacted).toBe(true);
      expect(text).not.toContain("412-XX-8891");
      expect(text).toContain("DLT declared");
    });

    it("redacts an email address", () => {
      const { text, redacted } = redactPii(
        "Contact: sarah.johnson@site-b03.clinic"
      );
      expect(redacted).toBe(true);
      expect(text).not.toContain("sarah.johnson@site-b03.clinic");
    });

    it("does not flag ordinary clinical text as PII", () => {
      const { redacted } = redactPii("PSA 12.4 ng/mL, declining trend");
      expect(redacted).toBe(false);
    });
  });

  describe("runDataPipeline — quarantine cases", () => {
    it("quarantines a row with a missing patient_id", () => {
      const csv = csvOf(baseRow({ patient_id: "" }));
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(0);
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0]!.reasons).toContain("missing_patient_id");
    });

    it("quarantines a row with a missing age rather than imputing one", () => {
      const csv = csvOf(baseRow({ age: "" }));
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(0);
      expect(result.quarantined[0]!.reasons).toContain("missing_age");
    });

    it("quarantines implausible age values (negative and unrealistically high)", () => {
      const csv = csvOf(
        baseRow({ patient_id: "PT-101", age: "-3" }),
        baseRow({ patient_id: "PT-102", age: "155" })
      );
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(0);
      expect(result.quarantined).toHaveLength(2);
      for (const q of result.quarantined) {
        expect(q.reasons).toContain("implausible_age");
      }
    });

    it("accepts age=0 as a valid infant age (nothing in this codebase restricts trials to adults)", () => {
      const csv = csvOf(baseRow({ age: "0" }));
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(1);
      expect(result.clean[0]!.age).toBe(0);
    });

    it("quarantines a zero weight (impossible for a living patient)", () => {
      const csv = csvOf(baseRow({ weight_kg: "0" }));
      const result = runDataPipeline(csv);
      expect(result.quarantined[0]!.reasons).toContain("implausible_weight");
    });

    it("quarantines a row whose dates are unparseable/ambiguous", () => {
      const csv = csvOf(baseRow({ enrollment_date: "03/04/2024" }));
      const result = runDataPipeline(csv);
      expect(result.quarantined[0]!.reasons).toContain(
        "unparseable_enrollment_date"
      );
    });

    it("quarantines a row with missing lab_notes rather than accepting an empty string", () => {
      const csv = csvOf(baseRow({ lab_notes: "" }));
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(0);
      expect(result.quarantined[0]!.reasons).toContain("missing_lab_notes");
    });

    it("quarantines a row with an unrecognized sex value", () => {
      const csv = csvOf(baseRow({ sex: "Unknown" }));
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(0);
      expect(result.quarantined[0]!.reasons).toContain("unrecognized_sex");
    });

    it("quarantines a malformed row (unquoted comma) with an accurate reason, not misleading per-field errors", () => {
      const csv = [
        HEADER,
        'PT-201,NCT-001,SITE-A01,2023-01-01,50,M,80.0,400mg BID,fatigue,PSA 12.4 ng/mL at baseline, declining trend,stable_disease,2023-06-01,active',
      ].join("\n");
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(0);
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0]!.reasons).toHaveLength(1);
      expect(result.quarantined[0]!.reasons[0]).toMatch(
        /^malformed_row_field_count:/
      );
      // The internal marker key shouldn't leak into the quarantine record
      // a human reviewer sees.
      expect(result.quarantined[0]!.record[FIELD_COUNT_MISMATCH_KEY]).toBeUndefined();
    });

    it("never silently drops a row — every row ends up clean or quarantined", () => {
      const csv = csvOf(
        baseRow({ patient_id: "PT-101" }),
        baseRow({ patient_id: "", age: "-5" }),
        baseRow({ patient_id: "PT-102", weight_kg: "0" })
      );
      const result = runDataPipeline(csv);
      expect(result.summary.totalDropped).toBe(0);
      expect(
        result.summary.totalClean + result.summary.totalQuarantined
      ).toBe(result.summary.totalInput);
    });
  });

  describe("runDataPipeline — accept-with-normalization cases", () => {
    it("treats an empty adverse_events field as an empty array, not a quarantine reason", () => {
      const csv = csvOf(baseRow({ adverse_events: "" }));
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(1);
      expect(result.clean[0]!.adverseEvents).toEqual([]);
      expect(result.summary.issuesFound["empty_adverse_events_assumed_none"]).toBe(
        1
      );
    });

    it("normalizes sex to M/F and keeps the row clean", () => {
      const csv = csvOf(
        baseRow({ patient_id: "PT-101", sex: "Male" }),
        baseRow({ patient_id: "PT-102", sex: "Female" })
      );
      const result = runDataPipeline(csv);
      expect(result.clean.map((r) => r.sex).sort()).toEqual(["F", "M"]);
    });

    it("redacts PII in lab_notes but keeps the row in the clean set", () => {
      const csv = csvOf(
        baseRow({
          lab_notes: "Contact: sarah.johnson@site-b03.clinic for details",
        })
      );
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(1);
      expect(result.clean[0]!.labNotes).not.toContain("sarah.johnson");
      expect(result.summary.issuesFound["pii_redacted"]).toBe(1);
    });
  });

  describe("runDataPipeline — duplicate resolution", () => {
    it("keeps the most recent duplicate as clean and quarantines the superseded one", () => {
      const csv = csvOf(
        baseRow({
          patient_id: "PT-003",
          last_visit_date: "2024-01-22",
          response_assessment: "partial_response",
        }),
        baseRow({
          patient_id: "PT-003",
          last_visit_date: "2024-03-15",
          response_assessment: "confirmed_response",
          lab_notes: "UPDATE: confirmed PR by RECIST",
        })
      );
      const result = runDataPipeline(csv);
      expect(result.clean).toHaveLength(1);
      expect(result.clean[0]!.lastVisitDate).toBe("2024-03-15");
      expect(result.clean[0]!.responseAssessment).toBe("partial_response");
      expect(result.quarantined).toHaveLength(1);
      expect(result.quarantined[0]!.reasons).toContain("duplicate_superseded");
      expect(result.quarantined[0]!.record["last_visit_date"]).toBe(
        "2024-01-22"
      );
    });
  });

  describe("runDataPipelineFromFile — real dataset", () => {
    it("processes the real CSV with every row accounted for and known-bad rows quarantined", () => {
      const result = runDataPipelineFromFile(
        new URL(
          "../../data/incoming_patient_data.csv",
          import.meta.url
        ).pathname
      );

      expect(
        result.summary.totalClean +
          result.summary.totalQuarantined +
          result.summary.totalDropped
      ).toBe(result.summary.totalInput);
      expect(result.summary.totalDropped).toBe(0);

      const quarantinedIds = result.quarantined.map(
        (q) => q.record["patient_id"]
      );
      expect(quarantinedIds).toContain("PT-004"); // implausible age
      expect(quarantinedIds).toContain("PT-011"); // missing age
      expect(quarantinedIds).toContain("PT-014"); // implausible weight
      expect(quarantinedIds).toContain("PT-016"); // implausible age
      expect(quarantinedIds).toContain(""); // row 31, missing patient_id

      const pt003 = result.clean.filter((r) => r.patientId === "PT-003");
      expect(pt003).toHaveLength(1);
      expect(pt003[0]!.responseAssessment).toBe("partial_response");

      const pt040 = result.clean.find((r) => r.patientId === "PT-040");
      expect(pt040?.sex).toBe("M");
    });

    it("throws a clear error instead of silently corrupting data when the file isn't valid UTF-8", () => {
      const badPath = join(
        mkdtempSync(join(tmpdir(), "pipeline-encoding-test-")),
        "bad-encoding.csv"
      );
      const header = Buffer.from(HEADER + "\n");
      // 0x80 is never valid as the first byte of a UTF-8 sequence.
      const invalidUtf8 = Buffer.from([0x80, 0x81, 0x82, 0x0a]);
      writeFileSync(badPath, Buffer.concat([header, invalidUtf8]));

      expect(() => runDataPipelineFromFile(badPath)).toThrow(/not valid UTF-8/);
    });
  });
});
