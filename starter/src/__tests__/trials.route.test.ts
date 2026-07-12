import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { trialsRouter } from "../routes/trials.js";

describe("trialsRouter", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/trials", trialsRouter);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  describe("GET /trials — sort/order validation", () => {
    it("rejects an unrecognized sort field with 400 instead of silently returning unsorted results", async () => {
      const res = await fetch(`${baseUrl}/trials?sort=bogus`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/sort/i);
    });

    it("rejects sort=responseRate with 400 (not currently an implemented sort field)", async () => {
      const res = await fetch(`${baseUrl}/trials?sort=responseRate`);
      expect(res.status).toBe(400);
    });

    it("rejects an invalid order value with 400 instead of silently defaulting to desc", async () => {
      const res = await fetch(`${baseUrl}/trials?order=bogus`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/order/i);
    });

    it("still returns 200 for a supported sort field and order", async () => {
      const res = await fetch(`${baseUrl}/trials?sort=enrollment&order=asc`);
      expect(res.status).toBe(200);
    });

    it("still returns 200 when sort/order are omitted", async () => {
      const res = await fetch(`${baseUrl}/trials`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /trials — minEnrollment validation", () => {
    it("rejects a non-numeric minEnrollment with 400 instead of silently ignoring the filter", async () => {
      const res = await fetch(`${baseUrl}/trials?minEnrollment=abc`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/minEnrollment/i);
    });

    it("still returns 200 and applies the filter for a valid minEnrollment", async () => {
      const res = await fetch(`${baseUrl}/trials?minEnrollment=99999`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
    });

    it("applies the filter (not skips it) for minEnrollment=0", async () => {
      const res = await fetch(`${baseUrl}/trials?minEnrollment=0`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(body.trials.length);
    });
  });

  describe("GET /trials — repeated (array-valued) query params", () => {
    it("rejects a repeated phase param with 400 instead of silently returning zero results", async () => {
      const res = await fetch(`${baseUrl}/trials?phase=I&phase=II`);
      expect(res.status).toBe(400);
    });

    it("rejects a repeated status param with 400", async () => {
      const res = await fetch(`${baseUrl}/trials?status=recruiting&status=completed`);
      expect(res.status).toBe(400);
    });

    it("rejects a repeated sponsor param with 400 instead of crashing with a 500", async () => {
      const res = await fetch(`${baseUrl}/trials?sponsor=Pathos&sponsor=Merck`);
      expect(res.status).toBe(400);
    });

    it("rejects a repeated search param with 400 instead of crashing with a 500", async () => {
      const res = await fetch(`${baseUrl}/trials?search=melanoma&search=cancer`);
      expect(res.status).toBe(400);
    });

    it("still returns 200 for normal single-value filters", async () => {
      const res = await fetch(`${baseUrl}/trials?phase=III&sponsor=Pathos`);
      expect(res.status).toBe(200);
    });
  });

  describe("POST /trials/:id/analyze — input validation", () => {
    it("rejects an invalid focus value with 400 instead of silently proceeding", async () => {
      const res = await fetch(`${baseUrl}/trials/NCT-001/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ focus: "bogus" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/focus/i);
    });

    it("rejects a request with a missing focus field with 400 instead of silently proceeding", async () => {
      const res = await fetch(`${baseUrl}/trials/NCT-001/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/focus/i);
    });
  });
});
