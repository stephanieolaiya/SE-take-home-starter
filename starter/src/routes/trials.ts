import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { listTrials, getTrialById } from "../services/trial-service.js";
import {
  streamAnalysis,
  getTrialSummary,
} from "../services/analysis-service.js";
import type { TrialListResponse, ErrorResponse } from "../types.js";

const router = Router();

// zod's `.optional()` fields are typed `T | undefined`, with the key still
// present when the value is `undefined`. `exactOptionalPropertyTypes` treats
// "key present with `undefined`" and "key absent" as different things, so
// this strips the former down to the latter before handing filters off to
// listTrials — fixing the construction site rather than loosening what
// TrialFilters is allowed to mean.
function omitUndefined<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}

const analyzeRequestSchema = z.object({
  focus: z.enum(["safety", "efficacy", "competitive"]),
});

// Only fields with a real case in listTrials's sort switch belong here.
// Adding a new sortable field is a product/API-surface decision, not a bug fix —
// don't add to this list without also adding the corresponding case in trial-service.ts.
const listTrialsQuerySchema = z.object({
  // Express turns repeated query keys (?phase=I&phase=II) into arrays, so every
  // field here must reject non-string shapes explicitly — a plain z.string()
  // does that; without it these silently misbehave or crash downstream.
  phase: z.string().optional(),
  status: z.string().optional(),
  sponsor: z.string().optional(),
  search: z.string().optional(),
  // Only fields with a real case in listTrials's sort switch belong here.
  // Adding a new sortable field is a product/API-surface decision, not a bug fix —
  // don't add to this list without also adding the corresponding case in trial-service.ts.
  sort: z.enum(["enrollment", "startDate", "adverseEventRate"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  minEnrollment: z.coerce.number().optional(),
});

router.get(
  "/",
  (req: Request, res: Response<TrialListResponse | ErrorResponse>) => {
    const parsed = listTrialsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Invalid query parameters: 'phase', 'status', 'sponsor', and 'search' must each be a single string value (not repeated); 'sort' must be one of 'enrollment', 'startDate', 'adverseEventRate'; 'order' must be 'asc' or 'desc'; 'minEnrollment' must be a number",
      });
      return;
    }

    const result = listTrials(omitUndefined(parsed.data));

    res.json(result);
  }
);

router.get("/:id", (req: Request<{ id: string }>, res: Response) => {
  const trial = getTrialById(req.params.id);
  if (!trial) {
    res.status(404).json({ error: "Trial not found" });
    return;
  }
  res.json(trial);
});

router.get("/:id/summary", (req: Request<{ id: string }>, res: Response) => {
  const trial = getTrialById(req.params.id);
  if (!trial) {
    res.status(404).json({ error: "Trial not found" });
    return;
  }

  const summary = getTrialSummary(trial);
  res.json(summary);
});

router.post(
  "/:id/analyze",
  async (
    req: Request<{ id: string }, unknown, { focus: string }>,
    res: Response<ErrorResponse>
  ) => {
    const trial = getTrialById(req.params.id);
    if (!trial) {
      res.status(404).json({ error: "Trial not found" });
      return;
    }

    const parsed = analyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "Invalid request body: 'focus' must be one of 'safety', 'efficacy', 'competitive'",
      });
      return;
    }

    try {
      await streamAnalysis(trial, parsed.data.focus, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : "Analysis failed",
        });
      }
    }
  }
);

export { router as trialsRouter };
