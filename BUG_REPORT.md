# Bug Report

## Bug 1 — `.env` is never loaded, so `OPENAI_API_KEY` silently fails to reach the process

**How I found it:** Hit `POST /trials/:id/analyze` with curl. The request returned `200 OK` and a valid-looking SSE stream, but the only event was `data: [DONE]` — no actual analysis text, and no error surfaced anywhere. Checked `process.env.OPENAI_API_KEY` directly under the `dev`/`start` scripts and confirmed it was `undefined` even with `starter/.env` populated.

**Root cause:** `starter/package.json`'s `dev`/`start` scripts ran `tsx watch src/server.ts` / `tsx src/server.ts` with no mechanism to load `.env` — no `dotenv` dependency, no `import "dotenv/config"` in `src/server.ts`, and no `--env-file` flag. `.env` is pure convention until something reads it; nothing did. So the OpenAI client (`@ai-sdk/openai`) authenticated with no key, the request to OpenAI failed, and — compounding the problem — `src/services/analysis-service.ts` calls `response.writeHead(200, ...)` *before* invoking `streamText()` (line 52, vs. the call on line 58). By the time the auth failure happened, HTTP headers were already committed as `200`. The route's catch block in `src/routes/trials.ts` only sends an error response `if (!res.headersSent)`, so the failure was swallowed entirely — the client just saw an empty stream that looked successful.

**Real-world impact:** This is a silent-failure pattern that's easy to miss in production. Every analysis request would "succeed" with a `200` and an empty result, with nothing in logs or the HTTP response indicating the AI call never ran. An analyst using this endpoint would get no data and no error — just a blank card in the UI — and would have no way to tell whether the trial genuinely had nothing to say or the integration was broken.

**Fix:** `starter/package.json:8-9` — added Node's native `--env-file=.env` flag to both `dev` and `start` scripts:

```diff
- "dev": "tsx watch src/server.ts",
- "start": "tsx src/server.ts",
+ "dev": "tsx watch --env-file=.env src/server.ts",
+ "start": "tsx --env-file=.env src/server.ts",
```

Verified `process.env.OPENAI_API_KEY` now loads correctly and `POST /trials/:id/analyze` streams real text chunks end-to-end.

**Why this fix is correct and minimal:** Node 20.6+ supports `--env-file` natively, so this requires no new dependency (this repo runs on Node 24). It's a one-line change per script rather than adding a `dotenv` package and an import, which would touch application source for something that's purely a run-configuration concern.

**Alternatives considered:**

- Add the `dotenv` package and `import "dotenv/config"` at the top of `src/server.ts`. Rejected as the higher-footprint option — it adds a runtime dependency and a source-file change for a problem `--env-file` solves at the process level with zero added dependencies.
- Fix nothing here and instead fix the symptom (writeHead-before-streamText / swallowed error). That's a real, separate bug worth fixing on its own — it means *any* mid-stream failure (not just a missing key) currently returns a fake `200` — but it wouldn't have addressed the root cause of the key never loading. Flagging it here as a follow-up; not fixed yet since it wasn't the ask for this pass.

**Note on testing:** This is a process-startup/config bug, not application logic, so it doesn't fit a `vitest` unit test — there's no function to call. The nearest equivalent is a smoke test (e.g., a CI step that runs `npm run start` against a `.env` fixture and asserts `/health` responds, or a script that asserts `process.env.OPENAI_API_KEY` is defined before the server starts listening). I did not add one now since it would require process-spawning infra beyond `vitest`; recommending it as a follow-up.

---

## Bug 2 — No `.gitignore` anywhere in the repo (security gap)

**How I found it:** While debugging Bug 1, `cat starter/.env.example` — the file meant to be committed, per the README's setup instructions — returned a live-looking `sk-proj-...` OpenAI key instead of the placeholder `sk-...`. `git diff` showed the *tracked* file had been modified with a real secret, while the *untracked* `starter/.env` (holding the real credential and correctly ignored by git convention) still had the placeholder — the two files' contents had been swapped. Checked for a `.gitignore` to see why git wasn't already protecting `.env`, and there wasn't one anywhere in the repo — at either the root or in `starter/`.

**Root cause:** Nothing in the repository excludes `.env` (or `node_modules/`) from version control. Whether a secret ends up in git is left entirely to the developer remembering not to `git add` the wrong file — there's no safety net. This is what let the `.env`/`.env.example` swap become a real risk instead of a git-blocked no-op: `git add -A` or `git add .env` would have silently staged a live credential.

**Real-world impact:** H

**Fix:** Added `.gitignore` at the repo root:

```
node_modules/
.env
```

Also restored `starter/.env.example` to the placeholder key and moved the real key into `starter/.env` (now correctly untracked and ignored) — see the credential swap noted above.

**Why this fix is correct and minimal:** A root-level `.gitignore` is the standard, minimal mechanism for this — it requires no process changes, no new dependencies, and closes the gap for every future edit to `.env`, not just this one instance.

**Alternatives considered:**

- A pre-commit hook (e.g., `gitleaks` or a simple grep for `sk-` patterns) to scan staged changes for secrets. This is a more robust, defense-in-depth solution used in real production repos, but it's meaningfully more setup (new dependency or hook infra) for a take-home-scale repo. `.gitignore` addresses the specific, observed gap; a scanning hook would be the natural next step if this were a real production repo.
- Do nothing and just fix the swapped file contents. Rejected — that only fixes the symptom for this one secret; the underlying gap (no `.gitignore`) would still let the same mistake recur on the next edit.

**Note on testing:** Like Bug 1, this isn't application logic, so there's no `vitest` unit test for it. The equivalent regression check is a CI step (e.g., `git check-ignore starter/.env` exits `0`, or `git ls-files | grep -q '^starter/\.env$'` exits nonzero) that fails the build if `.env` is ever tracked. Not added now for the same reason as Bug 1 — it's process/CI infra rather than something `vitest` covers — but recommended as a follow-up.

---

## Bug 3 — `focus` in `POST /trials/:id/analyze` is never validated (type-safety hole)

**How I found it:** Tested edge cases against the (now-working) analyze endpoint:

```bash
curl -i -X POST http://localhost:3000/trials/NCT-001/analyze \
  -H "Content-Type: application/json" -d '{"focus": "bogus"}'

curl -i -X POST http://localhost:3000/trials/NCT-001/analyze \
  -H "Content-Type: application/json" -d '{}'
```

Both returned `200 OK` and a full streamed AI analysis, instead of rejecting the request. Neither `"bogus"` nor a missing `focus` is a valid `AnalysisFocus` (`"safety" | "efficacy" | "competitive"` per `src/types.ts:17`).

**Root cause:** `src/routes/trials.ts` destructured `req.body.focus` and passed it straight to `streamAnalysis` with an explicit `focus as any` cast (previously line 64) — bypassing TypeScript entirely at the one point where external, untrusted input enters the type system. Downstream, `buildPrompt()` in `src/services/analysis-service.ts` does `focusInstructions[focus]` on a plain object keyed by the three valid literals; an unrecognized key (or `undefined`) just silently evaluates to `undefined`, which gets interpolated into the LLM prompt as the literal string `"undefined"`. Nothing ever throws or rejects — the request degrades quietly into a malformed prompt and still returns `200`. Notably, `zod` was already a `package.json` dependency (`starter/package.json:18`) and completely unused anywhere in `src/` — a strong signal validation was intended here and simply never wired up.

**Real-world impact:** Every malformed or missing `focus` silently consumes a real OpenAI API call (cost, and against the 500 req/min rate limit noted in `ARCHITECTURE_PROMPT.md`) and returns a `200` with an analysis built from a corrupted prompt containing the literal text `"undefined"` — the client has no way to know the request was invalid. This is the same "looks successful, isn't" failure class as Bug 1, but caused by unvalidated input instead of a config/env gap. A frontend with a typo in a focus value, or an old client sending a since-removed focus option, would fail silently in production with no error to alert anyone.

**Fix:** `src/routes/trials.ts` — added a `zod` schema and validated `req.body` before calling `streamAnalysis`, returning `400` with a descriptive error on failure:

```diff
+ import { z } from "zod";
  ...
+ const analyzeRequestSchema = z.object({
+   focus: z.enum(["safety", "efficacy", "competitive"]),
+ });
  ...
-   const { focus } = req.body;
+   const parsed = analyzeRequestSchema.safeParse(req.body);
+   if (!parsed.success) {
+     res.status(400).json({
+       error:
+         "Invalid request body: 'focus' must be one of 'safety', 'efficacy', 'competitive'",
+     });
+     return;
+   }

    try {
-     await streamAnalysis(trial, focus as any, res);
+     await streamAnalysis(trial, parsed.data.focus, res);
```

This also removes the `as any` cast — `parsed.data.focus` is properly typed as `AnalysisFocus` by `zod` inference, so the type system is actually enforced end-to-end now, not just declared in `types.ts` and ignored at the boundary.

**Why this fix is correct and minimal:** `zod` was already a dependency, so this adds zero new packages — just wires up what was already there. Validating at the route boundary (before any OpenAI call is made) means invalid requests fail fast with a clear `400` and never reach `streamAnalysis`, so no wasted API cost and no more `writeHead(200, ...)` being committed for a request that was never going to produce a real result.

**Alternatives considered:**

- Validate inside `buildPrompt()` or `streamAnalysis()` instead of at the route. Rejected — by that point `response.writeHead(200, ...)` has already run (see Bug 1's discussion of that same line), so an error there can't be surfaced as a proper HTTP status. Validating at the route, before any response writing starts, is the only point where a `400` is still possible.
- Return a generic `500` for invalid focus instead of a `400`. Rejected — this is a client error (bad request shape), not a server failure; `400` is the correct HTTP semantics and gives the caller an actionable signal to fix their request.

**Tests added:** `src/__tests__/trials.route.test.ts` (`POST /trials/:id/analyze — input validation`) — spins up the `trialsRouter` on an ephemeral local port (no need to import `src/server.ts`, which has its own top-level `app.listen()` side effect) and asserts:

- `POST /trials/NCT-001/analyze` with `{"focus": "bogus"}` returns `400`.
- `POST /trials/NCT-001/analyze` with `{}` (missing `focus`) returns `400`.

Both tests run without needing a real `OPENAI_API_KEY` or network access, since validation now short-circuits before `streamAnalysis` (and thus before any OpenAI call) is ever reached — confirmed via `npm test`.

---

## Bug 4 — `sort=startDate` returns results in the wrong order (asc/desc inverted)

**How I found it:** The existing test suite was already failing before I touched this file: `sorts by startDate` in `src/__tests__/trials.test.ts` (asserts non-increasing dates for the default sort) failed with `expected false to be true`. Ran `listTrials({ sort: "startDate" })` directly and printed the result — it came back **oldest-first** (`2012-03-01` → `2024-01-10`), the opposite of what the default `order` (`"desc"`, i.e. newest-first) should produce.

**Root cause:** `src/services/trial-service.ts:65-84`. The sort comparator has three cases that each compute a `cmp` value, then a shared line applies the direction:

```js
case "enrollment":
  cmp = a.enrollment - b.enrollment;              // a − b
  break;
case "startDate":
  cmp = new Date(b.startDate).getTime() -
        new Date(a.startDate).getTime();           // b − a  (reversed!)
  break;
case "adverseEventRate":
  cmp = a.adverseEventRate - b.adverseEventRate;   // a − b
  break;
...
return sortOrder === "asc" ? cmp : -cmp;
```

`enrollment` and `adverseEventRate` both compute `a − b`, matching the convention the shared `asc`/`desc` flip below assumes. `startDate` alone computes `b − a` — pre-reversed relative to the other two fields. The shared flip then negates it again for `desc` (the default), which cancels the field-level reversal and leaves `startDate` sorting as if `order` were `"asc"` when it's actually `"desc"`, and vice versa. It's the only one of the three sortable fields with this inversion.

**Real-world impact:** Any caller relying on the documented/expected default (`GET /trials` with no explicit `order`, or `sort=startDate` with no `order`) to show trials newest-first — the natural default for a "recent trials" view — would silently get the list backwards, with the oldest, least-relevant trials surfacing first. This is a data-integrity bug: the API returns a well-formed but semantically wrong response with no error or indication anything is off, exactly the kind of thing that's easy to ship and only get noticed when a user complains the dashboard "looks wrong."

**Fix:** `src/services/trial-service.ts:74-77` — made `startDate` consistent with the other two cases by computing `a − b`:

```diff
  case "startDate":
    cmp =
-     new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
+     new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
    break;
```

Verified directly: `listTrials({ sort: "startDate" })` now returns newest-first (`2024-01-10` → `2012-03-01`), and `listTrials({ sort: "startDate", order: "asc" })` returns oldest-first — both directions correct.

**Why this fix is correct and minimal:** A one-line sign flip that brings `startDate` in line with the exact pattern already used by `enrollment` and `adverseEventRate` in the same switch statement — no change to the shared `asc`/`desc` flip logic, which is correct and shouldn't be touched (that would have broken the two fields that already work).

**Alternatives considered:**

- Fix it at the shared flip line instead (e.g., special-case `startDate` there). Rejected — that would make the shared logic field-aware for no reason, when the actual bug is a one-line inconsistency inside the `startDate` case itself. Matching the existing convention is the smaller, more obviously-correct diff.

**Tests added:** `src/__tests__/trials.test.ts` — renamed the existing (previously failing) `sorts by startDate` test to `sorts by startDate descending by default (newest first)` for clarity, and added `sorts by startDate ascending when order=asc (oldest first)` alongside it. Testing both directions explicitly (rather than only the default) ensures a future regression that re-inverts either direction gets caught, not just one. Confirmed both pass via `npm test` (11/11 passing overall, no regressions in the other sort fields).

---

## Bug 5 — `sort`/`order` accept any value silently instead of rejecting unsupported ones

**How I found it:** `curl "http://localhost:3000/trials?sort=responseRate"` returned `200` with all 8 trials, but not sorted by `responseRate` at all — results came back in raw insertion order (`NCT-001`…`NCT-008`), matching neither ascending nor descending `responseRate`.

**Root cause:** `src/services/trial-service.ts:70-83`. The `switch (sortField)` only has cases for `"enrollment"`, `"startDate"`, and `"adverseEventRate"` — the three fields actually implemented. Any other value for `sort` (or, separately, any value for `order` other than exactly `"asc"`) falls through to `default: cmp = 0`, and since `Array.prototype.sort` is stable, a constant `cmp` of `0` just preserves the original array order. Nothing validates `sort`/`order` anywhere, so the client gets a `200` and a full trial list back — it looks like a valid response, it just wasn't sorted by what was asked for.

I initially framed this as "`responseRate` is missing a sort case" and started implementing sort support for it. That was scope creep: `responseRate` sorting never existed as working functionality before this investigation — it's not a regression, it's a feature that was never built, and it's no different from any of the *other* unlisted fields (`sponsor`, `phase`, `name`, `estimatedCompletionDate`, etc.), all of which have the identical gap. Deciding which fields should be sortable is a product/API-surface decision, not a bug fix. The actual, minimal-scope bug is narrower: **the endpoint accepts unsupported `sort`/`order` values and silently no-ops instead of telling the caller their request wasn't honored.**

**Real-world impact:** Same silent-degradation shape as Bugs 1 and 3: a caller passing any unsupported `sort` (or a typo'd `order`) gets back a well-formed, plausible-looking `200` response that silently isn't sorted the way they asked. This is the kind of bug that survives in production for a long time, because nothing about the response looks wrong until someone manually checks the ordering.

**Fix:** `src/routes/trials.ts` — added a `zod` schema validating `sort` against exactly the fields that have a real case in `trial-service.ts`'s switch, and `order` against `"asc" | "desc"`, returning `400` for anything else:

```ts
// Only fields with a real case in listTrials's sort switch belong here.
// Adding a new sortable field is a product/API-surface decision, not a bug fix —
// don't add to this list without also adding the corresponding case in trial-service.ts.
const listTrialsQuerySchema = z.object({
  sort: z.enum(["enrollment", "startDate", "adverseEventRate"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});
```

Verified: `sort=bogus`, `sort=estimatedCompletionDate`, `sort=responseRate`, and `order=bogus` all now return `400`; `sort=enrollment&order=asc` and requests with no `sort`/`order` at all still return `200` as before.

**Why this fix is correct and minimal:** It validates exactly against what's already implemented — no new sortable fields added, no behavior change for any request that was already correctly handled. The comment on the schema exists specifically to stop this list from silently drifting out of sync with the switch statement in `trial-service.ts` in the future.

**Alternatives considered:**

- Implement `responseRate` (and/or other fields) as newly-sortable to "fix" the gap the user found it through. Rejected after reconsidering scope — this is a feature addition dressed up as a bug fix. `responseRate` sorting was never a working feature that regressed; treating it as in-scope here isn't meaningfully different from also adding sorting for `estimatedCompletionDate`, `sponsor`, or any other field nobody reported. If the product wants more sortable fields, that's a legitimate follow-up, but it should be a deliberate, separately-reviewed decision — including handling `responseRate`'s `null` case, which has real judgment-call implications (e.g., should trials with no results yet sort first or last?) that deserve their own discussion, not a decision buried inside a bug fix.
- Leave `sort`/`order` permissive like the other filters (`phase`, `status`, `sponsor`, which return zero matches rather than erroring on an unrecognized value). Rejected — that analogy doesn't hold: an unmatched filter value has a coherent meaning ("no trials match"), while an unrecognized `sort` value has no coherent meaning other than "the server doesn't know what you're asking for." Silently ignoring it while still returning `200` is the same failure class as Bug 3's unvalidated `focus`, not a legitimate default.

**Tests added:** `src/__tests__/trials.route.test.ts` (`GET /trials — sort/order validation`) — asserts `sort=bogus`, `sort=responseRate` (explicitly not currently supported), and `order=bogus` all return `400`; `sort=enrollment&order=asc` and no `sort`/`order` at all still return `200`. Confirmed via `npm test`.

---

## Bug 6 — `GET /trials/:id/summary` crashes (500) for any trial with a null `responseRate`

**How I found it:** `curl -i http://localhost:3000/trials/NCT-003/summary` returned `500` with an unhandled `TypeError: Cannot read properties of null (reading 'toFixed')`, thrown from `src/services/analysis-service.ts:84`. `NCT-003` is a real seed trial in `src/data.ts` (Phase I, `responseRate: null` — no results yet) — this isn't a constructed edge case, it's live data already in the dataset.

**Root cause:** `src/services/analysis-service.ts:84` (in `getTrialSummary`):

```ts
`Current response rate: ${trial.responseRate!.toFixed(1)}%.`,
```

`responseRate` is typed `number | null` in `src/types.ts:13`, but the `!` non-null assertion tells TypeScript to trust that it's never `null` — which is false for any trial without results yet. The type system had the right information; the assertion threw it away. Compounding it, Express's default error handler catches the crash and returns a raw HTML stack trace in the response body (visible in the earlier reproduction) — leaking internal file paths, which is a secondary information-disclosure issue on top of the crash itself.

**Real-world impact:** Any analyst viewing a summary for an in-progress trial with no results yet — a completely normal state for e.g. early Phase I trials — gets a `500` instead of a summary, with no way to know it's a null-handling bug versus a real outage. It's also the second occurrence in this codebase of the exact same mistake: `buildPrompt()` in the same file already handles this correctly a few lines up (`trial.responseRate ?? "not yet available"`, line 12) — the fix for this bug already existed as a pattern in the same file, just wasn't applied consistently.

**Fix:** `src/services/analysis-service.ts:84` — replaced the non-null assertion with an explicit null check, matching the existing pattern from `buildPrompt()`:

```diff
- `Current response rate: ${trial.responseRate!.toFixed(1)}%.`,
+ `Current response rate: ${trial.responseRate !== null ? `${trial.responseRate.toFixed(1)}%` : "not yet available"}.`,
```

Verified: `GET /trials/NCT-003/summary` now returns `200` with `"Current response rate: not yet available."`, and `GET /trials/NCT-001/summary` (non-null case) is unchanged, still returning `"38.5%"`.

**Why this fix is correct and minimal:** One line, no behavior change for trials that already have a response rate, and it reuses the exact convention (`"not yet available"`) already established elsewhere in the same file — no new pattern introduced.

**Alternatives considered:**

- Add a global Express error-handling middleware so any future unhandled exception returns a clean JSON `500` instead of leaking a stack trace. This is a real, valid production concern (the secondary info-disclosure issue noted above) and worth doing, but it treats the symptom (crashes leak stack traces) rather than this bug's actual cause (a false non-null assertion on data the type system already flagged as nullable). Fixing the null check directly is the minimal, targeted fix; a global error handler is a good follow-up for defense-in-depth against *other*, not-yet-found crashes, but out of scope here.

**Tests added:** `src/__tests__/analysis-service.test.ts` (new file) — `getTrialSummary` called directly with `NCT-003` (null `responseRate`) asserts it doesn't throw and the summary text contains `"not yet available"`; a second test asserts `NCT-001` (non-null) still includes the formatted `"38.5%"`. Confirmed via `npm test`.

---

## Bug 7 — `search` filter never matches text inside `keyFindings` (wrong `.includes` semantics)

**How I found it:** `NCT-001`'s `keyFindings` array contains the sentence `"Interim analysis at 6 months shows 38.5% PSA50 response rate"`. `listTrials({ search: "psa50" })` should match on that text, but returned zero results — while `listTrials({ search: "melanoma" })`, matching against `indication` (a string field), correctly returned `NCT-002`. Confirmed directly:

```
search='psa50' matched: []
search='melanoma' matched: [ 'NCT-002' ]
```

**Root cause:** `src/services/trial-service.ts:52-63`, inside the `search` filter's scoring block:

```js
if (t.name.toLowerCase().includes(query)) score += 3;
if (t.indication.toLowerCase().includes(query)) score += 2;
if (t.primaryEndpoint.toLowerCase().includes(query)) score += 1;
if (t.keyFindings.includes(query)) score += 2;   // bug
```

The first three lines call `.includes()` on a `string` — `String.prototype.includes`, substring containment, with both sides correctly lowercased. `keyFindings` is `string[]`, so the fourth line's `.includes()` resolves to `Array.prototype.includes` instead — which checks for an *exact element match*, not substring containment inside any element. Since `query` is lowercased and the `keyFindings` sentences are full, original-case prose, this condition is essentially never true: it would require one entire `keyFindings` string to equal the lowercased search term verbatim. Same method name, silently different semantics depending on the receiver's type — an easy copy-paste-style mistake, and exactly the "type-safety hole" category called out in the assignment.

**Real-world impact:** The "search key findings" capability is effectively dead — it contributes to the relevance score in name only and never actually fires. An analyst searching for a term that appears only in a trial's findings text (not its name, indication, or primary endpoint — plausible for a lot of real searches, e.g. a specific biomarker, dosage, or adverse event mentioned only in the findings) gets zero results, with nothing indicating the search silently failed to check that field.

**Fix:** `src/services/trial-service.ts:59` — replaced the array `.includes()` with `.some()` doing the same substring check used by the other three fields:

```diff
- if (t.keyFindings.includes(query)) score += 2;
+ if (t.keyFindings.some((f) => f.toLowerCase().includes(query)))
+   score += 2;
```

Verified: `search=psa50` now correctly matches `NCT-001` and `NCT-007` (both mention PSA50 in their findings); `search=melanoma` is unaffected (still matches `NCT-002`).

**Why this fix is correct and minimal:** One line, changes only the `keyFindings` clause, and mirrors the exact substring-matching convention (`.toLowerCase().includes(query)`) already used by the three field checks directly above it — no new pattern, no change to scoring weights or the rest of the filter/sort pipeline.

**Alternatives considered:**

- Leave `keyFindings` out of `search` scoring entirely (since it never worked, arguably no one depends on it). Rejected — the scoring weight (`+2`) and the field's presence in the code make it clear this was an intended part of the search feature that regressed to non-functional via a typo-class bug, not a feature that was deliberately left out. Fixing the actual bug is more correct than removing the attempt.

**Tests added:** `src/__tests__/trials.test.ts` — `matches a search term that only appears inside keyFindings text` (asserts `search=psa50` returns `NCT-001` and `NCT-007`) and a regression check that string-field search (`search=melanoma`) is unaffected. Confirmed via `npm test`.

---

## Bug 8 — `search` mutates shared trial objects, leaking an internal `_score` field into unrelated API responses

**How I found it:** While fixing Bug 7, noticed the same block ends with `(t as any)._score = score;`. `results = [...trialData]` (`trial-service.ts:32`) only shallow-copies the *array* — each `ClinicalTrial` element inside it is still the exact same object reference as the one held in the module-level `trialData` array and `trialCache` (built from that same array at startup, `trial-service.ts:14-22`). Writing `t._score = score` inside the `search` filter therefore doesn't touch a request-local copy — it mutates the actual, permanently-cached trial objects that every future request reads from.

Reproduced directly:

```bash
curl http://localhost:3000/trials/NCT-001        # no _score field
curl "http://localhost:3000/trials?search=AURORA" > /dev/null   # unrelated search request
curl http://localhost:3000/trials/NCT-001        # now includes "_score":3
```

An entirely unrelated `GET /trials/:id` request picked up a field that only ever should have existed (if at all) as a transient value inside one specific search request.

**Root cause:** `src/services/trial-service.ts:61` (before this fix), inside the `search` filter's scoring block: `(t as any)._score = score;`. The `as any` cast bypasses TypeScript entirely to write an undeclared property directly onto a shared, cached domain object — there is no type-level signal that this smuggles internal implementation state (a search-relevance score) into objects that are also serialized directly as public API responses elsewhere (`res.json(trial)` in the `GET /trials/:id` and `GET /trials` handlers).

**Real-world impact:** This is a straightforward information leak and a correctness bug at once. It leaks internal implementation details (an unstable, request-dependent relevance score) into the public API response shape for an endpoint (`GET /trials/:id`) that has nothing to do with search. Worse, the leaked value is stale and misleading outside the request that produced it: `_score` reflects whatever the *last* search happened to compute for that trial, not anything meaningful to the current request. In a real production system, mutating shared cached/singleton state from inside a request handler is a classic source of hard-to-reproduce bugs — the behavior of one request silently depends on what some earlier, unrelated request happened to do.

**Fix:** `src/services/trial-service.ts` — removed the mutation entirely:

```diff
      if (t.keyFindings.some((f) => f.toLowerCase().includes(query)))
        score += 2;
-     (t as any)._score = score;
      return score > 0;
```

`_score` was never read anywhere else in the codebase (confirmed via a full-codebase grep before removing it), so this deletes dead weight along with the leak — there's no value being lost.

**Why this fix is correct and minimal:** The safest fix for a value that's both harmful and unused is to stop producing it. No new abstraction, no defensive copying introduced elsewhere — just removing the one line that caused the problem.

**Alternatives considered:**

- Track scores in a request-local `Map<string, number>` (or an array of `{ trial, score }` pairs) instead of writing onto `t`, so that even a *future* re-introduction of relevance data couldn't repeat this exact mistake. This is the more defensive, "prevents the whole bug class" fix. Not applied, for two reasons: (1) nothing in the codebase currently needs the score past the `score > 0` filter check on the same line — there's no relevance-sort feature today to build the extra plumbing for, and adding it now would be solving a hypothetical rather than the reported bug; (2) I checked, and this is the *only* place in `src/services/` or `src/routes/` that mutates a trial object or the results array at all (`grep` for `.push(`, `.splice(`, bracket/dot assignment, `Object.assign`, `delete` turned up nothing else) — so the shared-mutable-object risk isn't a pervasive pattern here needing a structural fix, just this one now-deleted line. If a future change reintroduces per-trial scoring, the `Map`-based approach is the right call at that point.
- Deep-clone every trial object at the top of `listTrials` (e.g. `trialData.map(t => ({ ...t }))`) so nothing downstream could ever mutate shared state, regardless of what future code does. Rejected as broader than this bug warrants — it adds a clone on every single request (including the very common case of no filters at all) to guard against a mutation pattern that, per the grep above, doesn't currently exist anywhere else in the codebase.

**Tests added:** `src/__tests__/trials.test.ts` — `does not mutate shared trial objects when searching`: runs a search, then fetches the same trial via `getTrialById` (a separate, unrelated call) and asserts no `_score` property is present, catching a regression of the exact leak reproduced above. Confirmed via `npm test`.

---

## Bug 9 — `minEnrollment` accepts non-numeric values and silently disables the filter instead of erroring

**How I found it:** Same "unvalidated input degrades silently" pattern as Bugs 3 and 5, so I checked whether `minEnrollment` had the same gap:

```bash
curl "http://localhost:3000/trials?minEnrollment=abc"   # → 200, total: 8 — identical to no filter at all
curl "http://localhost:3000/trials?minEnrollment=99999" # → 200, total: 0 — filter genuinely works for valid input
curl "http://localhost:3000/trials"                      # → 200, total: 8 — no filter applied
```

`minEnrollment=abc` returns exactly the same result as omitting the filter entirely — not an error, and not the "correct" outcome either (a numeric comparison against garbage should logically match nothing, not everything).

**Root cause:** Two compounding issues:

1. `src/routes/trials.ts` (before this fix): `minEnrollment: minEnrollment ? Number(minEnrollment) : undefined`. `Number("abc")` is `NaN`, so `filters.minEnrollment` becomes `NaN` — no validation ever rejects it.
2. `src/services/trial-service.ts:42` (before this fix): `if (filters.minEnrollment) { ... }`. `NaN` is falsy in JavaScript, so this truthy check silently skips the entire filter block whenever the value is `NaN` — the request behaves as if `minEnrollment` was never passed at all, rather than correctly filtering everything out (which is what `t.enrollment >= NaN` — always `false` — would actually produce if the comparison ran).

The same truthy check also means `minEnrollment=0` gets silently skipped (`if (0)` is falsy too) — harmless today since all real `enrollment` values are positive (skipping produces the same result as correctly applying `>= 0`), but it's the same latent pattern and worth fixing at the root rather than leaving a second, currently-dormant instance of it.

**Real-world impact:** A client (or a UI form) that sends a malformed or empty `minEnrollment` value gets back an unfiltered `200` response with no indication their filter didn't apply. For a threshold filter specifically, this is worse than it sounds: the caller has no way to distinguish "no trials met your threshold" from "your threshold was silently ignored" — both look identical (a full or partial list with no error).

**Fix:** `src/routes/trials.ts` — added `minEnrollment` to the existing `zod` query schema (already validating `sort`/`order` from Bug 5), using `z.coerce.number()` so it's parsed and validated in one step:

```diff
  const listTrialsQuerySchema = z.object({
    sort: z.enum(["enrollment", "startDate", "adverseEventRate"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
+   minEnrollment: z.coerce.number().optional(),
  });
```

```diff
-   const parsed = listTrialsQuerySchema.safeParse({ sort, order });
+   const parsed = listTrialsQuerySchema.safeParse({ sort, order, minEnrollment });
    ...
-   minEnrollment: minEnrollment ? Number(minEnrollment) : undefined,
+   minEnrollment: parsed.data.minEnrollment,
```

And `src/services/trial-service.ts:42` — fixed the truthy check so `minEnrollment=0` is no longer conflated with "not provided":

```diff
- if (filters.minEnrollment) {
+ if (filters.minEnrollment !== undefined) {
    results = results.filter((t) => t.enrollment >= filters.minEnrollment!);
  }
```

Verified: `minEnrollment=abc` now returns `400`; `minEnrollment=99999` still correctly returns `total: 0`; `minEnrollment=0` now correctly applies the filter (returns all 8, same result as before, but now for the right reason — actually running the comparison rather than skipping it); no filter at all still returns `200`.

**Why this fix is correct and minimal:** Reuses the exact `zod` validation pattern and schema already introduced for `sort`/`order` in Bug 5 — no new validation approach, just extending the existing one. `z.coerce.number()` handles both the "is this actually numeric" check and the string→number conversion in one place, replacing the manual `Number(...)` cast that had no validation attached to it. The `trial-service.ts` truthy-check fix is a one-word change (`!== undefined`) addressing the root pattern rather than just the symptom that was actually observed.

**Alternatives considered:**

- Fix only the route-level validation (reject non-numeric input) and leave the `trial-service.ts` truthy check as-is, since `NaN` can no longer reach it once the route rejects it first. Rejected — that leaves the `minEnrollment=0` edge case unfixed at its actual root, relying entirely on the route layer to never again pass a falsy-but-valid value through. Fixing both layers means the service function is correct on its own terms too, not just correct because of what currently calls it.

**Tests added:** `src/__tests__/trials.route.test.ts` — three new tests under `GET /trials — minEnrollment validation`: `minEnrollment=abc` returns `400`; `minEnrollment=99999` still returns `200` with the filter correctly applied (`total: 0`); `minEnrollment=0` returns `200` with the filter applied rather than skipped. Confirmed via `npm test`.

---

## Bug 10 — `phase`, `status`, `sponsor`, and `search` crash or silently misbehave on repeated (array-valued) query params

**How I found it:** Express turns repeated query keys into arrays (e.g. `?phase=I&phase=II` → `req.query.phase === ["I", "II"]`) — a very ordinary shape in practice, since any multi-select filter UI (checkboxes, a `<select multiple>`) naturally produces exactly this. Every string-typed filter in `GET /trials` casts `req.query.*` to `string | undefined` with an unchecked `as` assertion, so I checked what actually happens when the runtime value doesn't match that claimed type:

```bash
curl "http://localhost:3000/trials?phase=I&phase=II"                 # → 200, total: 0 (silently wrong — matches neither)
curl "http://localhost:3000/trials?status=recruiting&status=completed" # → 200, total: 0 (same)
curl "http://localhost:3000/trials?sponsor=Pathos&sponsor=Merck"       # → 500, TypeError: filters.sponsor.toLowerCase is not a function
curl "http://localhost:3000/trials?search=melanoma&search=cancer"      # → 500, TypeError: filters.search.toLowerCase is not a function
```
Two different failure modes from the same root cause, depending on which field: `phase`/`status` use `===` exact comparison, so an array never equals a string and the filter silently matches nothing; `sponsor`/`search` call `.toLowerCase()` directly on the value, and `Array.prototype` has no such method, so it throws — an unhandled `500` with a leaked stack trace (the same secondary information-disclosure pattern as Bug 6).

**Root cause:** `src/routes/trials.ts`, in the `GET /trials` handler (before this fix): `phase: phase as string | undefined`, `status: status as string | undefined`, `sponsor: sponsor as string | undefined`, `search: search as string | undefined`. Express's actual type for a query value is `string | string[] | ParsedQs | ParsedQs[] | undefined` (`req.query`'s real shape) — the `as string | undefined` cast doesn't check or convert anything, it just tells TypeScript to trust a claim that's false whenever a key is repeated. This is the same class of bug as the `req.params.id` typing gap noted in the TypeScript-strictness pass: an unchecked cast lying about the real runtime shape of external input, one of the "type-safety holes" the assignment specifically calls out. `minEnrollment` had an identical exposure (`Number([...])` coerces an array to `NaN`) until Bug 9's fix already closed it via `zod`; `sort`/`order` were already protected by Bug 5's `zod` schema (a `z.enum()` correctly rejects an array). `phase`, `status`, `sponsor`, and `search` were the remaining fields with no such validation.

**Real-world impact:** This is the most severe of the query-validation gaps found so far — two of the four affected fields don't just return wrong results, they crash the request entirely with a `500` and leak internal file paths in the response body. And unlike a deliberately malicious query, the trigger (`?field=a&field=b`) is what an ordinary multi-select filter control produces by default — a frontend engineer wiring up a "filter by sponsor" multi-select to this API would hit this immediately in normal use, not as an edge case.

**Fix:** `src/routes/trials.ts` — extended the existing `zod` query schema (already validating `sort`/`order`/`minEnrollment`) to cover all four string fields with a plain `z.string().optional()`, which rejects arrays outright, and simplified the handler to validate the whole `req.query` object at once rather than picking fields out individually:
```diff
  const listTrialsQuerySchema = z.object({
+   // Express turns repeated query keys (?phase=I&phase=II) into arrays, so every
+   // field here must reject non-string shapes explicitly — a plain z.string()
+   // does that; without it these silently misbehave or crash downstream.
+   phase: z.string().optional(),
+   status: z.string().optional(),
+   sponsor: z.string().optional(),
+   search: z.string().optional(),
    sort: z.enum(["enrollment", "startDate", "adverseEventRate"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    minEnrollment: z.coerce.number().optional(),
  });
```
```diff
- const { phase, status, minEnrollment, sponsor, search, sort, order } = req.query;
- const parsed = listTrialsQuerySchema.safeParse({ sort, order, minEnrollment });
+ const parsed = listTrialsQuerySchema.safeParse(req.query);
  if (!parsed.success) { ... }
- const result = listTrials({
-   phase: phase as string | undefined,
-   status: status as string | undefined,
-   minEnrollment: parsed.data.minEnrollment,
-   sponsor: sponsor as string | undefined,
-   search: search as string | undefined,
-   sort: parsed.data.sort,
-   order: parsed.data.order,
- });
+ const result = listTrials(parsed.data);
```
Verified: all four repeated-param cases now return `400` instead of a `500` or a silently-wrong `200`; normal single-value filters (`?phase=III&sponsor=Pathos`, etc.) are unaffected and still return `200` with correct results.

**Why this fix is correct and minimal:** Reuses the exact `zod` pattern already established for `sort`/`order` (Bug 5) and `minEnrollment` (Bug 9) — no new validation approach introduced. Validating the whole `req.query` object in one `safeParse` call (rather than destructuring individual fields first) is also a simplification, not just a fix: `zod`'s default "strip unknown keys" behavior means any query params outside the schema are silently ignored exactly as before, so there's no behavior change for unrelated query params, and the handler body is shorter because `listTrials(parsed.data)` can be passed directly — `parsed.data`'s shape already matches `TrialFilters`.

**Alternatives considered:**
- Keep destructuring individual fields and only add `.optional()` string checks for `sponsor`/`search` (the two that crash), leaving `phase`/`status` as unchecked casts since they "only" produce wrong-but-non-crashing results. Rejected — silently returning zero results for a valid-looking filter request is still a real bug (Bug 5's reasoning applies equally here: a filter that matches nothing looks identical to "no trials matched," which is misleading), and fixing all four with the same one schema is no more code than fixing two.
- Validate that `phase`/`status` also match their actual enum values (`"I" | "II" | "III"` / `"recruiting" | "completed" | "terminated"`) while touching this code anyway. Rejected as scope creep beyond this specific bug, same reasoning as Bug 5's decision not to expand the sortable-field set: an unrecognized-but-well-typed `phase` value (e.g. `phase=IV`) has coherent filter semantics today (zero matches, which is correct — there's no Phase IV in this dataset), so it isn't broken the way array-typed input is. Enum-validating those fields is a reasonable future enhancement, not a fix for a reported defect.

**Tests added:** `src/__tests__/trials.route.test.ts` — five new tests under `GET /trials — repeated (array-valued) query params`: repeated `phase`, `status`, `sponsor`, and `search` each assert `400`; a fifth confirms normal single-value filters (`?phase=III&sponsor=Pathos`) still return `200`. Confirmed via `npm test` (29/29 passing).