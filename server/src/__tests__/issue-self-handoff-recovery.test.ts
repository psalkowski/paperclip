import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping self-requested hand-off recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery after an approver's run hands the issue back and the issue returns to it", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children = new Map<string, ChildProcess>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-handoff-recovery-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (const [runId, child] of children) {
      runningProcesses.delete(runId);
      child.kill();
    }
    children.clear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string, agentActor?: { agentId: string; runId: string }) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: agentActor ? "agent" : "board",
        ...(agentActor ? { ...agentActor, companyId } : { userId: "board-user" }),
        source: "session",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedApprovalFlow() {
    const companyId = randomUUID();
    const approverId = randomUUID();
    const executorId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Test Company",
      issuePrefix: "APR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: "board-user",
      name: "Board",
      email: "board@fixture.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values(
      [approverId, executorId].map((id, index) => ({
        id,
        companyId,
        name: index === 0 ? "Approver" : "Executor",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        permissions: {},
      })),
    );
    for (const agentId of [approverId, executorId]) {
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: randomUUID() },
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "APR-1",
      issueNumber: 1,
      title: "Approval flow",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: executorId,
      executionPolicy: {
        mode: "normal",
        commentRequired: false,
        stages: [
          {
            id: randomUUID(),
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: approverId }],
          },
        ],
      } as any,
    });
    return { companyId, approverId, executorId, issueId };
  }

  async function startLiveRun(
    seeded: Awaited<ReturnType<typeof seedApprovalFlow>>,
    agentId: string,
    queuedRunId?: string,
  ) {
    let runId = queuedRunId;
    if (!runId) {
      const [created] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: seeded.companyId,
          agentId,
          status: "queued",
          invocationSource: "assignment",
          triggerDetail: "system",
          contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId },
        })
        .returning();
      runId = created.id;
    }
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.set(runId, child);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
    await db
      .update(heartbeatRuns)
      .set({ status: "running", runtimeMode: "legacy", startedAt: new Date(), processPid: child.pid })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(issues)
      .set({ executionRunId: runId, checkoutRunId: runId })
      .where(eq(issues.id, seeded.issueId));
    return runId;
  }

  async function queuedRunOf(seeded: Awaited<ReturnType<typeof seedApprovalFlow>>, agentId: string) {
    return vi.waitFor(async () => {
      const [queued] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${seeded.issueId}`,
          ),
        );
      expect(queued).toBeDefined();
      return queued.id;
    });
  }

  it.each<{ stoppedBy: "its own run" | "the board"; holds: boolean }>([
    { stoppedBy: "its own run", holds: false },
    { stoppedBy: "the board", holds: true },
  ])(
    "approver stopped by $stoppedBy, wake lost while paused: hold opened = $holds",
    async ({ stoppedBy, holds }) => {
      const seeded = await seedApprovalFlow();
      const { companyId, approverId, executorId, issueId } = seeded;
      const heartbeat = heartbeatService(db);

      const executorRun = await startLiveRun(seeded, executorId);
      await request(app(companyId, { agentId: executorId, runId: executorRun }))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" })
        .expect(200);

      const approverRun = await startLiveRun(seeded, approverId, await queuedRunOf(seeded, approverId));
      const stopApprover =
        stoppedBy === "its own run"
          ? request(app(companyId, { agentId: approverId, runId: approverRun }))
          : request(app(companyId));
      await stopApprover
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_progress", assigneeAgentId: executorId, comment: "Changes requested." })
        .expect(200);

      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, approverRun));
      expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
      expect(stopped.resultJson).toMatchObject({
        reassignmentStopConfirmed: true,
        executionCancellation: { state: "acknowledged" },
      });

      const resubmittingRun = await startLiveRun(seeded, executorId, await queuedRunOf(seeded, executorId));
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, approverId));
      await request(app(companyId, { agentId: executorId, runId: resubmittingRun }))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" })
        .expect(200);

      await heartbeat.reconcileStrandedAssignedIssues();
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, approverId));
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.wakeup(approverId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      });

      const activeHolds = await db
        .select()
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.sourceIssueId, issueId),
            eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
          ),
        );
      expect(activeHolds).toHaveLength(holds ? 1 : 0);
      expect(!!(await getExecutionBlocker(db, companyId, issueId))).toBe(holds);

      const approverWakeReasons = (
        await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, approverId))
      ).map((wake) => wake.reason);
      expect(approverWakeReasons.includes("execution_reconciliation_required")).toBe(holds);

      const approverLiveRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, approverId),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
            inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
          ),
        );
      expect(approverLiveRuns.length > 0).toBe(!holds);
      expect(stopped.resultJson?.reassignmentRequestedByRun === true).toBe(!holds);
    },
    90_000,
  );
});
