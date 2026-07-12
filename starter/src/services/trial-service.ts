import { trials as trialData } from "../data.js";
import type { ClinicalTrial } from "../types.js";

interface TrialFilters {
  phase?: string;
  status?: string;
  minEnrollment?: number;
  sponsor?: string;
  search?: string;
  sort?: string;
  order?: string;
}

const trialCache = new Map<string, ClinicalTrial>();

function buildCache(): void {
  for (const trial of trialData) {
    trialCache.set(trial.id, trial);
  }
}

buildCache();

export function getTrialById(id: string): ClinicalTrial | undefined {
  return trialCache.get(id);
}

export function listTrials(filters: TrialFilters): {
  trials: ClinicalTrial[];
  total: number;
} {
  let results = [...trialData];

  if (filters.phase) {
    results = results.filter((t) => t.phase === filters.phase);
  }

  if (filters.status) {
    results = results.filter((t) => t.status === filters.status);
  }

  if (filters.minEnrollment !== undefined) {
    results = results.filter((t) => t.enrollment >= filters.minEnrollment!);
  }

  if (filters.sponsor) {
    results = results.filter((t) =>
      t.sponsor.toLowerCase().includes(filters.sponsor!.toLowerCase())
    );
  }

  if (filters.search) {
    const query = filters.search.toLowerCase();
    results = results.filter((t) => {
      let score = 0;
      if (t.name.toLowerCase().includes(query)) score += 3;
      if (t.indication.toLowerCase().includes(query)) score += 2;
      if (t.primaryEndpoint.toLowerCase().includes(query)) score += 1;
      if (t.keyFindings.some((f) => f.toLowerCase().includes(query)))
        score += 2;
      return score > 0;
    });
  }

  const sortField = filters.sort ?? "startDate";
  const sortOrder = filters.order ?? "desc";

  results.sort((a, b) => {
    let cmp: number;
    switch (sortField) {
      case "enrollment":
        cmp = a.enrollment - b.enrollment;
        break;
      case "startDate":
        cmp =
          new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
        break;
      case "adverseEventRate":
        cmp = a.adverseEventRate - b.adverseEventRate;
        break;
      default:
        cmp = 0;
    }
    return sortOrder === "asc" ? cmp : -cmp;
  });

  return { trials: results, total: results.length };
}
