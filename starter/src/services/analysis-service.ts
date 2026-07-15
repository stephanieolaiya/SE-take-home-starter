import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { ClinicalTrial, AnalysisFocus } from "../types.js";

function buildPrompt(trial: ClinicalTrial, focus: AnalysisFocus): string {
  const focusInstructions: Record<AnalysisFocus, string> = {
    safety: `Focus your analysis on:
1. The nature and severity of adverse events (AE rate: ${trial.adverseEventRate}%)
2. Whether the safety profile is acceptable for this patient population
3. What additional safety monitoring you would recommend`,
    efficacy: `Focus your analysis on:
1. The response rate (${trial.responseRate ?? "not yet available"}) relative to standard of care
2. Whether the primary endpoint (${trial.primaryEndpoint}) is clinically meaningful
3. How these results compare to competing therapies in the same indication`,
    competitive: `Focus your analysis on:
1. How this trial's results position the therapy competitively
2. What differentiates this therapy from existing treatments for ${trial.indication}
3. Market implications and potential for regulatory success`,
  };

  return `You are a pharmaceutical clinical analyst at Pathos Therapeutics.

Analyze the following clinical trial:

Trial: ${trial.name} (${trial.id})
Sponsor: ${trial.sponsor}
Phase: ${trial.phase} | Status: ${trial.status}
Indication: ${trial.indication}
Primary Endpoint: ${trial.primaryEndpoint}
Enrollment: ${trial.enrollment}
Adverse Event Rate: ${trial.adverseEventRate}%
Response Rate: ${trial.responseRate !== null ? trial.responseRate + "%" : "Not yet available"}
Key Findings:
${trial.keyFindings.map((f) => `- ${f}`).join("\n")}

${focusInstructions[focus]}

Write a 3-paragraph analysis. Be specific to the data above. Do not use generic language.`;
}

export async function streamAnalysis(
  trial: ClinicalTrial,
  focus: AnalysisFocus,
  response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    write: (chunk: string) => boolean;
    end: () => void;
  }
): Promise<void> {
  const prompt = buildPrompt(trial, focus);

  // streamText never throws for provider/auth errors, by design ("errors
  // become part of the stream and are not thrown to prevent servers from
  // crashing" per the AI SDK docs). onError is the only way to observe
  // them; without it, an invalid key or a mid-stream failure completes
  // silently with zero chunks and no exception.
  let streamError: unknown = null;
  const result = streamText({
    model: openai("gpt-4o-mini"),
    prompt,
    onError: ({ error }) => {
      streamError = error;
    },
  });

  const reader = result.textStream;
  let headersSent = false;

  for await (const chunk of reader) {
    if (!headersSent) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      headersSent = true;
    }
    response.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  }

  if (streamError) {
    const message =
      streamError instanceof Error ? streamError.message : "Analysis failed";
    if (!headersSent) {
      // Nothing sent yet, so throw and let the route's existing catch
      // block send a real 500 instead of a fake 200.
      throw new Error(message);
    }
    // Already committed to 200, the status can't change now, but the
    // client gets an explicit error instead of a silently truncated stream.
    response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  }

  response.write("data: [DONE]\n\n");
  response.end();
}

export function getTrialSummary(trial: ClinicalTrial): {
  id: string;
  name: string;
  riskScore: number;
  summary: string;
} {
  const riskScore = calculateRiskScore(trial);

  const summary = [
    `${trial.name} is a Phase ${trial.phase} ${trial.status} trial`,
    `studying ${trial.indication}.`,
    `Current response rate: ${trial.responseRate !== null ? `${trial.responseRate.toFixed(1)}%` : "not yet available"}.`,
    `Adverse event rate: ${trial.adverseEventRate}%.`,
    `Key findings: ${trial.keyFindings.join("; ")}`,
  ].join(" ");

  return { id: trial.id, name: trial.name, riskScore, summary };
}

function calculateRiskScore(trial: ClinicalTrial): number {
  let score = 0;

  // Higher AE rate = higher risk
  if (trial.adverseEventRate > 50) score += 3;
  else if (trial.adverseEventRate > 30) score += 2;
  else score += 1;

  // Terminated trials are highest risk
  if (trial.status === "terminated") score += 3;

  // Phase I = higher uncertainty
  if (trial.phase === "I") score += 1;

  if (trial.responseRate !== null && trial.responseRate > 30) {
    score += 2;
  }

  return score;
}
