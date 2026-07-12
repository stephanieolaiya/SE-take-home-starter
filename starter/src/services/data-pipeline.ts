import { readFileSync } from "node:fs";
import type { PatientRecord, PipelineResult } from "../types.js";

type Status = "active" | "completed" | "withdrawn" | "screen_fail";

interface ValidRow {
  raw: Record<string, string>;
  record: PatientRecord;
  warnings: string[];
}

interface InvalidRow {
  raw: Record<string, string>;
  reasons: string[];
}

// --- CSV parsing -----------------------------------------------------------
// Hand-rolled rather than a naive split(",") because several lab_notes values
// contain commas inside quoted fields (e.g. "PSA 12.4 ng/mL at baseline,
// declining trend") — a naive split silently misaligns every column after it.

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const len = content.length;

  while (i < len) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }

    if (char === "\r") {
      i++;
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i++;
      continue;
    }

    field += char;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// Reserved key, unlikely to collide with a real CSV header. A field-count
// mismatch (e.g. an unquoted comma splitting one field into two) is a cheap,
// reliable signal that a row's columns are misaligned — flagging it here lets
// validateAndTransformRow short-circuit with an accurate diagnosis instead of
// letting shifted values cascade into misleading per-field errors downstream.
export const FIELD_COUNT_MISMATCH_KEY = "__fieldCountMismatch__";

// The columns validateAndTransformRow actually reads. If a file is missing
// any of these — wrong file entirely, or the source changed its export
// schema — every row would otherwise fail individually with a wall of
// confusing "missing_X" reasons that obscure the real problem: this isn't
// the expected file at all. Failing fast here gives one clear diagnosis
// instead of 51 misleading ones.
const EXPECTED_COLUMNS = [
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

export function parseCsv(content: string): Record<string, string>[] {
  const rows = parseCsvRows(content).filter(
    (r) => !(r.length === 1 && r[0] === "")
  );
  if (rows.length === 0) return [];
  const header = rows[0]!;

  const missingColumns = EXPECTED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length > 0) {
    throw new Error(
      `CSV does not match the expected patient data schema — missing column(s): ${missingColumns.join(", ")}. Found columns: ${header.join(", ")}.`
    );
  }

  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = row[idx] ?? "";
    });
    if (row.length !== header.length) {
      record[FIELD_COUNT_MISMATCH_KEY] =
        `expected ${header.length} fields, got ${row.length} (likely an unquoted comma or a missing value)`;
    }
    return record;
  });
}

// --- Date normalization ------------------------------------------------------

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// Tries, in order: ISO YYYY-MM-DD, YYYY/MM/DD, ##/##/YYYY (disambiguated via
// "only one side can validly be a month" — if both or neither qualify, this
// is genuinely ambiguous and returns null rather than guessing), "Mon D YYYY".
export function parseFlexibleDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const isoSlash = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (isoSlash) return `${isoSlash[1]}-${isoSlash[2]}-${isoSlash[3]}`;

  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const year = slash[3]!;
    const aIsMonth = a >= 1 && a <= 12;
    const bIsMonth = b >= 1 && b <= 12;
    if (aIsMonth && !bIsMonth) {
      if (b < 1 || b > 31) return null;
      return `${year}-${pad2(a)}-${pad2(b)}`; // MM/DD/YYYY
    }
    if (bIsMonth && !aIsMonth) {
      if (a < 1 || a > 31) return null;
      return `${year}-${pad2(b)}-${pad2(a)}`; // DD/MM/YYYY
    }
    return null; // genuinely ambiguous (or invalid) — don't guess
  }

  const monthName = value.match(/^([A-Za-z]{3,}) (\d{1,2}),? (\d{4})$/);
  if (monthName) {
    const mo = MONTH_NAMES[monthName[1]!.slice(0, 3).toLowerCase()];
    const day = Number(monthName[2]);
    if (!mo || day < 1 || day > 31) return null;
    return `${monthName[3]}-${pad2(mo)}-${pad2(day)}`;
  }

  return null;
}

// --- Field normalization -----------------------------------------------------

export function normalizeSex(raw: string): "M" | "F" | "Other" | null {
  const value = raw.trim().toLowerCase();
  if (value === "m" || value === "male") return "M";
  if (value === "f" || value === "female") return "F";
  if (value === "other") return "Other";
  return null;
}

const RESPONSE_ASSESSMENT_SYNONYMS: Record<string, string> = {
  confirmed_response: "partial_response",
};

export function normalizeResponseAssessment(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.toUpperCase() === "N/A") return null;
  return RESPONSE_ASSESSMENT_SYNONYMS[value] ?? value;
}

export function validateStatus(raw: string): Status | null {
  const value = raw.trim();
  if (
    value === "active" ||
    value === "completed" ||
    value === "withdrawn" ||
    value === "screen_fail"
  ) {
    return value;
  }
  return null;
}

// --- PII redaction ------------------------------------------------------------
// Regex-based, so it will not catch every real-world name format (documented
// limitation — see DECISIONS.md). Applied uniformly to patient and staff
// name-patterns since distinguishing "whose name is this" isn't reliable from
// regex alone; over-redacting a staff name is a safer default than
// under-redacting a patient name.

export function redactPii(text: string): { text: string; redacted: boolean } {
  let result = text;
  result = result.replace(/MRN[:\s]*\d+/gi, "MRN: [REDACTED]");
  result = result.replace(/\b\d{3}-?(?:\d{2}|[Xx]{2})-?\d{4}\b/g, "[REDACTED]");
  result = result.replace(/[\w.-]+@[\w.-]+\.\w+/g, "[REDACTED]");
  result = result.replace(
    /\b(Dr\.|Patient|CRA|PI|Investigator|Nurse|Coordinator)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    "$1 [REDACTED]"
  );
  return { text: result, redacted: result !== text };
}

// --- Row validation & transform ------------------------------------------------

function validateAndTransformRow(raw: Record<string, string>): ValidRow | InvalidRow {
  const fieldCountMismatch = raw[FIELD_COUNT_MISMATCH_KEY];
  if (fieldCountMismatch) {
    // Column values are unreliable once the field count is wrong — don't
    // attempt to validate individual fields, since any "error" reported
    // would actually just be a symptom of the misalignment, not the real
    // problem. Strip the internal marker so quarantine shows the raw row
    // as it was actually parsed, not an implementation detail.
    const { [FIELD_COUNT_MISMATCH_KEY]: _mismatch, ...cleanRaw } = raw;
    return {
      raw: cleanRaw,
      reasons: [`malformed_row_field_count: ${fieldCountMismatch}`],
    };
  }

  const reasons: string[] = [];
  const warnings: string[] = [];

  const patientId = (raw["patient_id"] ?? "").trim();
  if (!patientId) reasons.push("missing_patient_id");

  const trialId = (raw["trial_id"] ?? "").trim();
  if (!trialId) reasons.push("missing_trial_id");

  const siteId = (raw["site_id"] ?? "").trim();
  if (!siteId) reasons.push("missing_site_id");

  const enrollmentDate = parseFlexibleDate(raw["enrollment_date"] ?? "");
  if (enrollmentDate === null) reasons.push("unparseable_enrollment_date");

  const ageRaw = (raw["age"] ?? "").trim();
  let age: number | null = null;
  if (!ageRaw) {
    reasons.push("missing_age");
  } else {
    const parsed = Number(ageRaw);
    if (!Number.isFinite(parsed)) reasons.push("unparseable_age");
    else if (parsed < 0 || parsed > 120) reasons.push("implausible_age");
    else age = parsed;
  }

  const sexRaw = (raw["sex"] ?? "").trim();
  const sex = normalizeSex(sexRaw);
  if (sex === null) reasons.push("unrecognized_sex");
  else if (sexRaw !== sex) warnings.push("normalized_sex");

  const weightRaw = (raw["weight_kg"] ?? "").trim();
  let weight: number | null = null;
  if (!weightRaw) {
    reasons.push("missing_weight");
  } else {
    const parsed = Number(weightRaw);
    if (!Number.isFinite(parsed)) reasons.push("unparseable_weight");
    else if (parsed <= 0 || parsed > 300) reasons.push("implausible_weight");
    else weight = parsed;
  }

  const doseLevel = (raw["dose_level"] ?? "").trim();
  if (!doseLevel) reasons.push("missing_dose_level");

  const adverseEventsRaw = (raw["adverse_events"] ?? "").trim();
  const adverseEvents = adverseEventsRaw
    ? adverseEventsRaw
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (!adverseEventsRaw) warnings.push("empty_adverse_events_assumed_none");

  const labNotesRaw = (raw["lab_notes"] ?? "").trim();
  if (!labNotesRaw) reasons.push("missing_lab_notes");
  const { text: labNotes, redacted } = redactPii(labNotesRaw);
  if (redacted) warnings.push("pii_redacted");

  const responseAssessmentRaw = (raw["response_assessment"] ?? "").trim();
  const responseAssessment = normalizeResponseAssessment(responseAssessmentRaw);
  if (responseAssessmentRaw in RESPONSE_ASSESSMENT_SYNONYMS) {
    warnings.push("normalized_response_assessment");
  }

  const lastVisitDate = parseFlexibleDate(raw["last_visit_date"] ?? "");
  if (lastVisitDate === null) reasons.push("unparseable_last_visit_date");

  const status = validateStatus(raw["status"] ?? "");
  if (status === null) reasons.push("unrecognized_status");

  if (
    enrollmentDate !== null &&
    lastVisitDate !== null &&
    enrollmentDate > lastVisitDate
  ) {
    reasons.push("enrollment_after_last_visit");
  }

  if (reasons.length > 0) {
    return { raw, reasons };
  }

  // Safe: every field that could be null here would have pushed a reason
  // above, and reasons is empty at this point — so none of these are
  // actually null. Unlike an unguarded `!`, this one is proven by the
  // preceding validation, not assumed.
  const record: PatientRecord = {
    patientId,
    trialId,
    siteId,
    enrollmentDate: enrollmentDate!,
    age: age!,
    sex: sex!,
    weight: weight!,
    doseLevel,
    adverseEvents,
    labNotes,
    responseAssessment,
    lastVisitDate: lastVisitDate!,
    status: status!,
  };

  return { raw, record, warnings };
}

// --- Duplicate resolution ------------------------------------------------------
// Multiple valid rows sharing a patientId are treated as updates to the same
// patient, not distinct patients — keep the one with the latest
// lastVisitDate as authoritative; supersede the rest (they go to quarantine
// with an audit trail, not silently dropped).

export function resolveDuplicates(rows: ValidRow[]): {
  kept: ValidRow[];
  superseded: ValidRow[];
} {
  const byId = new Map<string, ValidRow[]>();
  for (const row of rows) {
    const list = byId.get(row.record.patientId) ?? [];
    list.push(row);
    byId.set(row.record.patientId, list);
  }

  const kept: ValidRow[] = [];
  const superseded: ValidRow[] = [];

  for (const group of byId.values()) {
    if (group.length === 1) {
      kept.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort((a, b) =>
      b.record.lastVisitDate.localeCompare(a.record.lastVisitDate)
    );
    kept.push(sorted[0]!);
    superseded.push(...sorted.slice(1));
  }

  return { kept, superseded };
}

// --- Pipeline entry points ------------------------------------------------------

export function runDataPipeline(csvContent: string): PipelineResult {
  const rawRows = parseCsv(csvContent);
  const totalInput = rawRows.length;

  const results = rawRows.map(validateAndTransformRow);
  const validRows = results.filter((r): r is ValidRow => "record" in r);
  const invalidRows = results.filter((r): r is InvalidRow => "reasons" in r);

  const { kept, superseded } = resolveDuplicates(validRows);
  const supersededInvalid: InvalidRow[] = superseded.map((row) => ({
    raw: row.raw,
    reasons: ["duplicate_superseded"],
  }));

  const issuesFound: Record<string, number> = {};
  const tally = (reason: string): void => {
    issuesFound[reason] = (issuesFound[reason] ?? 0) + 1;
  };
  for (const row of kept) {
    for (const warning of row.warnings) tally(warning);
  }
  for (const row of [...invalidRows, ...supersededInvalid]) {
    for (const reason of row.reasons) tally(reason);
  }

  const clean = kept.map((r) => r.record);
  const quarantined = [...invalidRows, ...supersededInvalid].map((r) => ({
    record: r.raw,
    reasons: r.reasons,
  }));

  return {
    clean,
    quarantined,
    summary: {
      totalInput,
      totalClean: clean.length,
      totalQuarantined: quarantined.length,
      totalDropped: totalInput - clean.length - quarantined.length,
      issuesFound,
    },
  };
}

export function runDataPipelineFromFile(filePath: string): PipelineResult {
  // readFileSync(path, "utf-8") decodes leniently — invalid byte sequences
  // (e.g. a Windows-1252 export misread as UTF-8, common from Excel-on-
  // Windows CRO exports) get silently replaced with "�" and the corrupted
  // text just flows through as if nothing happened. TextDecoder with
  // fatal: true throws instead, so a wrong-encoding file fails loudly here
  // rather than silently degrading lab_notes and other free-text fields.
  const buffer = readFileSync(filePath);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(
      `${filePath} is not valid UTF-8 — check the source export's encoding (e.g. Windows-1252 from Excel) before re-running the pipeline.`
    );
  }
  return runDataPipeline(content);
}
