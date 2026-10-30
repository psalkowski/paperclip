import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { priceCodexReceipt } from "../services/codex-pricing.js";
import { createRunUsageRecorder } from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";

function codexReceipt(overrides: Partial<AdapterUsageCheckpoint> = {}): AdapterUsageCheckpoint {
  return {
    complete: true, usageBasis: "per_run", provider: "openai", biller: "chatgpt", billingType: "subscription",
    model: "gpt-6.1-sol", costUsd: null,
    usage: { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 100_000 },
    ...overrides,
  };
}

describe("Codex subscription pricing", () => {
  it("prices a subscription run at the API list price as an estimate", () => {
    const priced = priceCodexReceipt(codexReceipt());
    expect(priced.costStatus).toBe("estimated");
    expect(Number(priced.costUsdExact)).toBeCloseTo(3.1, 9);
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: "openai-standard-2026-10-30" });
    expect(priced.pricingProvenance?.evidence).toContain("subscription run priced at the API list-price equivalent");
  });

  it("prices the API path as before, without the subscription note", () => {
    const priced = priceCodexReceipt(codexReceipt({ biller: "openai", billingType: "api" }));
    expect(Number(priced.costUsdExact)).toBeCloseTo(3.1, 9);
    expect(priced.pricingProvenance?.evidence).not.toContain("subscription");
  });

  it("prices gpt-6.1-terra from the current rate card", () => {
    expect(Number(priceCodexReceipt(codexReceipt({ model: "gpt-6.1-terra" })).costUsdExact)).toBeCloseTo(1.55, 9);
  });

  it.each([
    ["an unknown model", { model: "gpt-unknown" }],
    ["subscription overage, which is real spend", { billingType: "subscription_overage" }],
    ["a third-party biller", { biller: "openrouter" }],
    ["an incomplete receipt", { complete: false }],
  ])("leaves %s unpriced", (_case, overrides) => {
    const receipt = codexReceipt(overrides);
    expect(priceCodexReceipt(receipt)).toBe(receipt);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Codex subscription estimate accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("codex-subscription-pricing-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function codexRun() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Codex pricing", issuePrefix: "CDXP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-subscription-pricing-"));
    directories.push(directory);
    const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "codex_local" }, directory);
    return { recorder, runId };
  }
  async function usageOf(runId: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.usageJson as Record<string, unknown>;
  }

  it("keeps the estimate on the run and records no subscription spend", async () => {
    const { recorder, runId } = await codexRun();
    await recorder.capture(codexReceipt());
    expect(await usageOf(runId)).toMatchObject({ billingType: "subscription_included", costStatus: "estimated" });
    expect(Number((await usageOf(runId)).costUsdExact)).toBeCloseTo(3.1, 9);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ billingType: "subscription_included", costStatus: "estimated", costCents: 0 });
  });

  async function settle(runId: string) {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    return db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
  }

  it("sums the estimates of attempts that are all subscription runs, whichever alias they report", async () => {
    const { recorder, runId } = await codexRun();
    await recorder.capture(codexReceipt({ attemptId: randomUUID(), billingType: "subscription_included" }));
    const total = await recorder.capture(codexReceipt({ attemptId: randomUUID(), model: "gpt-6.1-terra" }));
    expect(total.costStatus).toBe("estimated");
    expect(total.billingType).not.toBe("unknown");
    expect(Number(total.costUsdExact)).toBeCloseTo(4.65, 9);
    const events = await settle(runId);
    expect(events.reduce((sum, event) => sum + event.costCents, 0)).toBe(0);
    expect(events.every(event => event.billingType === "subscription_included")).toBe(true);
  });

  it("charges only the API attempt when a run mixes API and subscription attempts", async () => {
    const { recorder, runId } = await codexRun();
    await recorder.capture(codexReceipt({ attemptId: randomUUID() }));
    const total = await recorder.capture(codexReceipt({ attemptId: randomUUID(), biller: "openai", billingType: "api", costUsd: 1 }));
    expect(total.billingType).toBe("unknown");
    expect(total.costStatus).toBe("reported");
    expect(Number(total.costUsdExact)).toBeCloseTo(1, 9);
    const events = await settle(runId);
    expect(events.reduce((sum, event) => sum + event.costCents, 0)).toBe(100);
  });
});
