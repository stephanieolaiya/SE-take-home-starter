import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { streamText } from "ai";
import { getTrialSummary, streamAnalysis } from "../services/analysis-service.js";
import { getTrialById } from "../services/trial-service.js";

vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

function fakeResponse() {
  const writeHead = vi.fn();
  const writes: string[] = [];
  const end = vi.fn();
  return {
    response: {
      writeHead,
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      end,
    },
    writeHead,
    writes,
    end,
  };
}

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

  describe("streamAnalysis", () => {
    const trial = getTrialById("NCT-001")!;

    it("commits headers only once the first real chunk arrives, and streams normally on success", async () => {
      (streamText as Mock).mockImplementation(() => ({
        textStream: (async function* () {
          yield "Hello";
          yield " world";
        })(),
      }));

      const { response, writeHead, writes, end } = fakeResponse();
      await streamAnalysis(trial, "safety", response);

      expect(writeHead).toHaveBeenCalledTimes(1);
      expect(writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({ "Content-Type": "text/event-stream" })
      );
      expect(writes).toEqual([
        `data: ${JSON.stringify({ text: "Hello" })}\n\n`,
        `data: ${JSON.stringify({ text: " world" })}\n\n`,
        "data: [DONE]\n\n",
      ]);
      expect(end).toHaveBeenCalledTimes(1);
    });

    it("throws instead of silently completing when a failure happens before any chunk streams, so headers are never committed", async () => {
      // Regression test for the bug where response.writeHead(200) fired
      // before streamText() ran at all, so a pre-stream failure (e.g. an
      // invalid API key) still returned a fake 200 with an empty stream.
      // streamText itself never throws for provider errors, by design,
      // it only reports them via onError, so the mock has to model that.
      (streamText as Mock).mockImplementation(
        ({ onError }: { onError: (e: { error: unknown }) => void }) => ({
          textStream: (async function* () {
            onError({ error: new Error("Incorrect API key provided") });
          })(),
        })
      );

      const { response, writeHead } = fakeResponse();

      await expect(streamAnalysis(trial, "safety", response)).rejects.toThrow(
        "Incorrect API key provided"
      );
      expect(writeHead).not.toHaveBeenCalled();
    });

    it("writes an explicit error event instead of silently truncating when a failure happens mid-stream", async () => {
      (streamText as Mock).mockImplementation(
        ({ onError }: { onError: (e: { error: unknown }) => void }) => ({
          textStream: (async function* () {
            yield "partial";
            onError({ error: new Error("Connection lost") });
          })(),
        })
      );

      const { response, writeHead, writes, end } = fakeResponse();
      await expect(
        streamAnalysis(trial, "safety", response)
      ).resolves.toBeUndefined();

      expect(writeHead).toHaveBeenCalledTimes(1);
      expect(writes).toContain(
        `data: ${JSON.stringify({ error: "Connection lost" })}\n\n`
      );
      expect(writes[writes.length - 1]).toBe("data: [DONE]\n\n");
      expect(end).toHaveBeenCalledTimes(1);
    });
  });
});
