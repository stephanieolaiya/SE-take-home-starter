# Data Pipeline Decisions

`src/services/data-pipeline.ts` reads `data/incoming_patient_data.csv` (51 rows) and produces a `PipelineResult`: a clean, validated, normalized `PatientRecord[]`; a quarantine list of raw rows with reasons; and a summary tally. This document explains what was found in the data, the decision made for each category, why, the alternatives considered, and the assumptions made about what a downstream consumer needs.

**Assumed downstream consumer:** this feeds the same internal Pathos analyst platform the rest of this codebase serves (trial dashboards, risk scoring, dose/response analysis) — not a public data release. That assumption drives several of the calls below, especially around PII handling.

**Design invariant, applied throughout:** In current pipeline, every input row ends up in either `clean` or `quarantined` — nothing is silently dropped. `summary.totalDropped` should always compute to `0`; it's kept as a sanity-check field, not a real code path. Verified by a dedicated test (`never silently drops a row`).

---

## Mixed date formats (`enrollment_date`, `last_visit_date`)

**Found:** four distinct formats in the file — ISO `YYYY-MM-DD` (majority), `MM/DD/YYYY` (`PT-003`), `DD/MM/YYYY` (`PT-028`, `15/05/2024` — same slash format as `PT-003` but the opposite field order), `Mon DD YYYY` (`PT-009`), and `YYYY/MM/DD` (`PT-019`).

**Decision:** parse against an ordered list of known formats and normalize everything to ISO `YYYY-MM-DD` in the output. For `##/##/YYYY`, disambiguate MM/DD vs. DD/MM using "only one side can validly be a month (1–12)" — if both or neither qualify, treat it as genuinely ambiguous and quarantine rather than guess. This resolved every date actually present in the file deterministically, including the `PT-003`/`PT-028` trap (same slash format, opposite field order) that a naive single-convention parser would silently misparse.

**Why:** a naive parser (e.g. always assuming `MM/DD/YYYY`) would silently produce a wrong date for `PT-028` while looking successful. The "only one side is a valid month" rule is deterministic and auditable. When elimination doesn't produce a unique answer, guessing would fabricate data so quarantining is the honest response. The reason this isn't handled more conservatively (e.g. quarantining every non-ISO date on sight) is that most of them are recoverable with certainty: there's a clear, deterministic way to resolve `MM/DD/YYYY`, `DD/MM/YYYY`, `Mon DD YYYY`, and `YYYY/MM/DD` down to a single correct ISO date, so treating any non-ISO format as automatically suspect would quarantine rows that don't actually need a human at all. Quarantine is reserved for the narrow case where the format itself doesn't resolve to one answer, not for every row that simply isn't already ISO.

**Alternatives considered:**  Ask a human for every non-ISO date: rejected as unnecessarily conservative; the disambiguation rule resolves the vast majority of cases correctly and auditably.

**Precision — kept full dates, not generalized to year-only:** a stricter de-identification standard (see HIPAA section below) would generalize dates to year-only as a quasi-identifier reduction. Not applied here: `ClinicalTrial.startDate`/`estimatedCompletionDate` are already exact dates elsewhere in this same app, and full precision is needed for trial-timeline analysis (time-on-study, visit cadence). This is a documented assumption, not a fact — it would need revisiting if this dataset were ever headed for public release rather than internal analyst use.

---

## Missing required fields

**Found:** `patient_id` blank (row 31), `age` blank (`PT-011`), `lab_notes` blank (`PT-048`), `adverse_events` blank (`PT-003` ×2, `PT-010`, `PT-024`).

**Decision — general rule:** every `PatientRecord` field is required (non-nullable) *except* the two fields whose type explicitly declares tolerance for emptiness: `responseAssessment: string | null` and `adverseEvents: string[]` (where `[]` is a legitimate, well-understood outcome in AE reporting — "no adverse events observed" — not just an omission). Any other field left blank in the source is quarantined, full stop — no per-field leniency beyond what the type itself already grants:

- `patient_id`, `age`, `lab_notes` missing → quarantine.Never fabricate a value for a field the type says must be present. This includes `lab_notes` — narrative text is lower-stakes than `age`/`patient_id`, but "assume no notes" is still an invented value the source data never actually confirmed, and `PatientRecord.labNotes: string` never declared tolerance for absence the way `responseAssessment`/`adverseEvents` do. (`PT-048` quarantined under `missing_lab_notes`.)
- `adverse_events` missing → accept as `[]`. The one exception, justified by the type itself. This is still a genuine assumption ("none reported" vs. "not collected" — the source has no separate "AE assessed: Y/N" flag to disambiguate the two), tracked via `empty_adverse_events_assumed_none` in the summary so it's visible, not silent.

**Why one rule instead of a per-field judgment call:** an earlier draft of this pipeline treated `lab_notes` as a softer case ("not safety-critical, accept as empty") but the type system already tells us which fields tolerate emptiness (`responseAssessment`, `adverseEvents`) and which don't (everything else); deviating from that per-field by feel just for `lab_notes` was a weaker, less auditable call than deriving the policy from the type itself. 

**Alternatives considered:** keep the softer `lab_notes` exception (accept as `""`) — rejected on reconsideration, per above. Impute a mean/default `age` — rejected outright; fabricating a core demographic value for clinical data is worse than the gap it's meant to fill.

---

## Clinically implausible values (syntactically valid, semantically wrong)

**Found:** `age = -3` (`PT-004`), `age = 155` (`PT-016`), `weight_kg = 0` (`PT-014`).

**Decision:** quarantine. Range: `age` must be `≥ 0` and `≤ 120` (anything above is unreasonable), `weight_kg` must be `> 0` and `≤ 300`. These deliberately treat zero differently: `weight_kg = 0` is a physical impossibility for a living enrolled patient, but `age = 0` is a legitimate, real value (a patient under one year old is conventionally recorded as age `0`) — nothing in this codebase (`data.ts`, `ARCHITECTURE_PROMPT.md`, or the README) restricts these trials to adult-only populations, so `age = 0` isn't implausible here, just unusual relative to this particular 51-row sample's *observed* range (44–77). Observed range in a sample isn't the same as an eligibility criterion, and quarantining on the former would be inventing a rule the data never actually states. Never auto-"correct" a value by guessing intent (e.g. assuming `-3` meant `3`, or `30`, or `43`) — there's no way to know, and fabricating a fix is worse than flagging it.

**Why:** this is the same principle as missing-required-fields: guessing invents data. A range check with a documented threshold is defensible and auditable; a "smart" correction isn't. Quarantine specifically (rather than dropping the row outright) is the right call because these values are recoverable by a human in a way a machine can't safely replicate: a human can confirm what `age = -3` was actually supposed to be, something an automated rule has no way to do. Dropping the row would throw away real clinical data (the rest of the row is presumably fine) to avoid a single bad field; quarantining keeps that data available once a human resolves the one field that's actually in question.

**Alternatives considered:** clamp out-of-range values to the nearest valid boundary (e.g. `age=155` → `120`) — rejected, this silently changes the record to a value that was never actually reported, which is worse than leaving it flagged for a human to resolve with the actual source (e.g. calling the site).

---

## Suspected PII in free-text fields (`lab_notes`)

**Found:** `PT-004` (patient name + MRN), `PT-037` (SSN-like pattern), `PT-017` (staff email), `PT-021`/`PT-050` (clinician/CRA names).

**Decision: redact in place, keep the row in the clean set.** `redactPii()` runs regex passes for MRN references, SSN-like digit-dash patterns, email addresses, and `(Dr.|Patient|CRA|PI|Investigator|Nurse|Coordinator) CapitalizedName` patterns — replacing just the name, not the title, so context survives (`"Dr. Michael Chen"` → `"Dr. [REDACTED]"`). Redaction is counted in `summary.issuesFound.pii_redacted` for auditability. Applied uniformly to both patient and staff name-patterns, since reliably distinguishing "whose name is this" from regex alone isn't possible — over-redacting a staff name is a safer default than under-redacting a patient name.

**Why keep the row instead of quarantining it:** the clinical content around the PII (e.g. `PT-004`'s "elevated liver enzymes... requires close monitoring") is real safety-relevant information. Quarantining the whole row would withhold that content from analysis over a redactable leak in the same string, which is the wrong tradeoff for an internal safety-analysis platform.

**Documented limitation — this is not a complete solution.** Regex-based name detection has real false negatives (it won't catch every name format — only ones matching the specific title-prefix patterns checked). This dataset's confirmed PII was pattern-matched successfully, but that's not a guarantee for arbitrary future input. A production system handling PHI at scale would pair this with NER-based detection and/or a human review step before trusting redacted output, rather than relying on regex alone.

**Specific limitation — title-dependent name matching.** The name pattern in `redactPii()` (`src/services/data-pipeline.ts`) only redacts a name when it's immediately preceded by one of a fixed set of title words: `Dr.`, `Patient`, `CRA`, `PI`, `Investigator`, `Nurse`, `Coordinator`. A name appearing without one of those exact prefixes is invisible to it — e.g. `"Patient reported by Michael Chen"` or a bare `"Michael Chen noted elevated liver enzymes"` (no leading title at all) would pass through completely unredacted, even though the earlier, title-prefixed form (`"Dr. Michael Chen noted..."`) is caught. Every PII instance actually present in this dataset happens to use a title prefix, so nothing in the real file is currently affected — but this is a real, narrow failure mode, not a hypothetical one, and it's the clearest concrete example of why this approach isn't a substitute for real NER in a production system.

**Alternatives considered:**

- Quarantine the whole row instead of redacting. A more conservative option, but loses real clinical content for a compliance concern that redaction already resolves.
- NER-based (Named Entity Recognition) detection instead of regex. Would catch name formats the fixed title-prefix patterns miss (the exact gap noted above), and is the right long-term answer for PHI at scale. Not used here: it requires a trained model or an external NER service, a new dependency, and a review step to validate its output against clinical text, none of which is justified for this dataset's size and known PII patterns. Regex covers every actual instance present in this file.

---

## Duplicate records with conflicting data

**Found:** `PT-003` appears twice — identical on `trial_id`/`site_id`/`enrollment_date`/`age`/`sex`/`weight_kg`/`dose_level`, but the second row has a later `last_visit_date`, an updated `response_assessment` (`confirmed_response` vs. `partial_response`), and a note explicitly saying "UPDATE: confirmed PR by RECIST."

**Decision:** keep the row with the later `last_visit_date` as authoritative in `clean`; log the superseded row into `quarantined` with reason `duplicate_superseded` (not silently discarded).

**Why:** the evidence points to this being a later clinical update to the same patient, not two different patients — a real timestamp (`last_visit_date`) plus explicit note text ("UPDATE") both point the same direction. Logging the superseded version (rather than deleting it outright) preserves an audit trail — a human reviewing the clean dataset can still see that a conflict existed and how it was resolved, rather than that history silently vanishing.

**Alternatives considered:**  Quarantine both versions for manual review instead of auto-resolving. This is a more conservative, genuinely defensible option; not chosen because the evidence for recency here is strong enough (a real later timestamp, corroborated by explicit note text) that automatic resolution seems reasonable, but this is exactly the kind of case that would flip to manual-review-only if the conflicting fields were safety-critical (e.g. differing `adverse_events` lists) rather than a response-assessment update.

---

## Categorical value normalization (`sex`, `response_assessment`)

**Found:** `sex = "Male"` instead of `"M"` (`PT-040`); `response_assessment = "confirmed_response"` — a non-standard value appearing only on the newer `PT-003` duplicate, where the note text explicitly says "confirmed PR by RECIST" (PR = partial response).

**Decision:**

- `sex`: normalize case-insensitively — `M`/`Male` → `"M"`, `F`/`Female` → `"F"`, else quarantine as `unrecognized_sex`. `"Female"→"F"` is handled even though only `"Male"` was actually observed in this file, for robustness against future input using the same pattern.
- `response_assessment`: map `"confirmed_response"` → `"partial_response"` via a documented synonym table. The note text is the actual evidence for this mapping, not a guess.

**Why:** both are the same shape of problem — a human typed a synonym instead of the canonical vocabulary. Normalizing keeps the output's vocabulary consistent for downstream filtering/grouping, the same reason `Bug 7` in `BUG_REPORT.md` (Part 1) treats consistent categorical matching as correctness-relevant, not cosmetic. Normalizing here is justified, and different from the implausible-value case above, because there's an actual source of truth for the mapping rather than a guess: `"Male"` is unambiguously `"M"` with a spelling variant, not an inference, and `"confirmed_response"` maps to `"partial_response"` because the note text itself says so ("confirmed PR by RECIST"), not because the pipeline decided what it probably meant. Where that source of truth doesn't exist, the value is quarantined instead of normalized (see `status` below and the `unrecognized_sex` fallback above).

**Alternatives considered (for `response_assessment`):** pass the value through unchanged, since `PatientRecord.responseAssessment` isn't type-constrained to an enum — rejected as it would leave the output vocabulary inconsistent for no benefit. Quarantine any non-standard categorical value — rejected here specifically because the note text gives unambiguous evidence for the correct mapping; this is different from a genuinely unknown value with no supporting context, which would be quarantined instead (see `status` below).

---

## `status` validation

**Found:** all 51 rows use one of the four expected values (`active`, `completed`, `withdrawn`, `screen_fail`) — no bad values observed.

**Decision:** validate strictly against the enum anyway; quarantine (`unrecognized_status`) anything else. Unlike `sex`/`response_assessment`, there's no synonym-mapping here because no non-standard variant was ever observed to justify one — inventing a mapping without evidence would be a guess, not a documented decision.

---

## `dose_level` — heterogeneous values across trials (accepted as free text)

**Found:** heterogeneous values across trials — `"400mg BID"`/`"200mg QD"`-style dosing notation for `NCT-001`/`NCT-003`/`NCT-007`, vs. `"vemurafenib + cobimetinib"`/`"vemurafenib monotherapy"` for `NCT-002`.

**Decision:** accept as-is, only checking presence (non-empty). No enum/range constraint.

**Why:** this heterogeneity is expected, not an error — different trials use genuinely different drugs and dosing conventions. Constraining this field would require a per-trial dosing schema this dataset doesn't provide.

**Considered and rejected: pattern-validating `dose_level` to catch placeholder junk (`"N/A"`, `"TBD"`, `"unknown"`).** All 51 rows in this file fall into exactly 8 legitimate values, so nothing in the actual data is currently affected either way — this was a defensive-robustness question for future CRO drops, not a fix for an observed problem (same shape of question as the unquoted-comma CSV case above). Two stricter options were on the table: reject known placeholder strings while still accepting arbitrary drug-regimen text, or require an allowlist/mg-dose-regex match. Neither was applied — valid values here are either a numeric mg-dose pattern (`\d+mg BID/QD`) *or* an arbitrary drug-regimen name, and a real drug name can't be distinguished from garbage text without an external drug database. A placeholder-only denylist would catch the obvious cases (`"N/A"`) but not silently-wrong free text (`"asdf"`), so it would add validation surface without actually closing the gap it's aimed at — not worth the complexity for a risk that isn't observed in the data today.

---

## Encoding artifacts

**Found:** none. Verified at the byte level (`file`, `xxd` — valid UTF-8, no BOM, pure LF line endings), the Unicode-codepoint level (every non-ASCII character enumerated by name — only `U+2014 EM DASH`, used 12 times, all correctly encoded), and the structural level (no HTML entities, no percent-encoding remnants, no unbalanced CSV quotes, no stray control characters, no leading/trailing/double-space anomalies).

**Decision: no transformation applied, but two defensive checks added for future data drops.** The em-dashes are preserved as valid UTF-8 rather than stripped, since this app is Unicode-aware end-to-end (Node/Express/JSON) and there's no ASCII-only downstream consumer requiring transliteration. Nothing in this file needs fixing; the value here is guarding against what a *future* file could get wrong, not this one:

- **Strict encoding validation.** `runDataPipelineFromFile()` originally read the file with `readFileSync(path, "utf-8")`, which decodes leniently: Node silently substitutes `�` for invalid byte sequences instead of erroring. A future CRO export in a different encoding (Windows-1252 is common from Excel-on-Windows, especially once a file has em-dashes or smart quotes typed into it) would silently corrupt `lab_notes` and other free-text fields with zero indication anything went wrong: no error, no quarantine flag, just quietly wrong data in what looks like a normal clean row. Switched to `TextDecoder("utf-8", { fatal: true })`, which throws instead of substituting, so a wrong-encoding file now fails loudly at the file-read boundary rather than degrading silently downstream.
- **File schema validation.** `parseCsv()` now verifies the header contains every column `validateAndTransformRow` actually reads, throwing immediately if any are missing. Without this, pointing the pipeline at the wrong file (or a CRO export with a changed schema) wouldn't produce a clear error: every row would just individually fail with a wall of confusing `missing_patient_id`/`missing_trial_id`/etc. reasons, since none of the expected columns would exist. That looks like "51 rows are all broken" when the real diagnosis is "this isn't the expected file at all", the same principle as the field-count-mismatch check for the unquoted-comma case below: fail once, clearly, at the structural level, rather than let a structural problem cascade into misleading per-row noise.

Both checks are file/structural-level, not per-row: they `throw` rather than route through the `clean`/`quarantined` split, since "wrong file" and "wrong encoding" aren't data-quality issues about individual patients, they're a different failure class entirely (the caller gave the pipeline something other than what it expects).

---

## Considered but not applied: full HIPAA Safe Harbor / Expert Determination de-identification

A stricter formal de-identification standard was raised as a reference point during building. Evaluated point by point against what this assignment's existing types (`PatientRecord`, `PipelineResult` in `src/types.ts`) and stated use case (internal Pathos analyst platform, not public data release) actually call for:


| Checklist item                                                             | Applied? | Reasoning                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scrub direct identifiers (names, SSNs)                                     | **Yes**  | Covered by `redactPii()`, discussed above                                                                                                                                                                                                                             |
| Standardize formats (dates → ISO 8601)                                     | **Yes**  | Covered by `parseFlexibleDate()`, discussed above                                                                                                                                                                                                                     |
| Generalize quasi-identifiers (dates → year-only)                           | **No**   | Full date precision is needed for trial-timeline analysis, and this app already treats exact dates as normal elsewhere (`ClinicalTrial.startDate`)                                                                                                                    |
| One-hot/binary-encode categorical fields (e.g. `sex`)                      | **No**   | Would deviate from the assignment's own `PatientRecord` type (`sex: "M"                                                                                                                                                                                               |
| Statistical perturbation (jitter/Box-Cox) on numeric fields                | **No**   | This dataset feeds real clinical analysis (dose/response, safety signals); injecting noise would silently corrupt every calculation built on top of it. Perturbation is the right tool for public statistical release, not an internal analyst platform               |
| Separate demographic data into a firewalled store (pseudonymous-ID-linked) | **No**   | A legitimate production-scale pattern (this is essentially what OMOP CDM's `person`/`observation` split does), but a materially bigger architectural change than "a function returning `PatientRecord[]`" — would require redefining the assignment's own output type |


**What would change this call:** if this dataset's destination changed from "internal analyst platform" to "public research release" or "third-party data sharing," the calculus flips — full Safe Harbor-grade generalization (year-only dates, no exact quasi-identifiers, formal statistical disclosure control) would become the correct default rather than a documented exception. That's a product/legal decision about data destination, not a data-cleaning decision, which is why it's called out here rather than silently applied or silently ignored.

---

## Defensive case: an unquoted comma inside `lab_notes`

**Not present in the actual dataset** — every field containing a comma or semicolon in `data/incoming_patient_data.csv` is properly quoted throughout (verified). But it's a realistic risk for *future* CRO data drops, so it's handled defensively.

**The risk:** a comma inside `lab_notes` that isn't wrapped in quotes is invalid CSV — it silently splits one field into two, shifting every column after it by one position. Without a specific check, this doesn't fail cleanly: the shifted values still get *individually* validated (e.g. a shifted `status` value like `"2023-06-01"` fails `validateStatus`, a shifted `last_visit_date` like `"stable_disease"` fails `parseFlexibleDate`), so the row does correctly end up quarantined — but with misleading reasons (`unrecognized_status`, `unparseable_last_visit_date`) that point a reviewer at the wrong columns entirely, several fields away from the actual problem.

**Decision:** detect field-count mismatches during CSV parsing itself (`parseCsv` compares each row's field count against the header's) and short-circuit with an accurate `malformed_row_field_count` reason before any individual field validation runs — once the column count is wrong, no individual field's value can be trusted, so validating them further just produces noise.

**Why:** a field-count check is cheap, reliable in both directions (catches too many fields *and* too few, e.g. a truncated row), and turns a confusing multi-symptom failure into one clear diagnosis. This is the same principle as the rest of the pipeline — when something can't be safely interpreted, say so plainly rather than let a best-effort guess produce a misleading result.

---

## Testing

`src/__tests__/data-pipeline.test.ts` — 38 tests: unit tests for each helper (`parseCsv`'s comma-in-quotes handling, field-count-mismatch detection, and schema/header validation; `parseFlexibleDate`'s five format cases plus the ambiguous-date null case; `normalizeSex`; `normalizeResponseAssessment`; `validateStatus`; `redactPii`'s four PII patterns), integration tests against small inline CSV fixtures for each quarantine/accept-with-warning/duplicate-resolution scenario (including missing `lab_notes`, unrecognized `sex`, `age=0` being accepted, and the unquoted-comma malformed-row case all behaving correctly), and end-to-end tests against the real `data/incoming_patient_data.csv` — one asserting the known-bad rows land in quarantine and the invariant (`clean + quarantined + dropped === totalInput`, `dropped === 0`) holds, another asserting `runDataPipelineFromFile` throws a clear error on invalid UTF-8 rather than silently corrupting data.