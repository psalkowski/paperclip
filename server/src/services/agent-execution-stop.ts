import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

export type HostProcessProbe = {
  processStartedAt(pid: number): Promise<string | null>;
};

export const hostProcessProbe: HostProcessProbe = {
  processStartedAt: pid => readProcessStartedAt(pid).catch(() => null),
};

type RunProcess = Pick<typeof heartbeatRuns.$inferSelect, "processPid" | "processGroupId" | "processStartedAt" | "finishedAt">;

function absent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function localProcessAlive(run: RunProcess, host: HostProcessProbe) {
  let processAlive = Boolean(run.processPid && !absent(run.processPid));
  let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
  if (processAlive && run.processStartedAt) {
    const observed = await host.processStartedAt(run.processPid!);
    if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
      processAlive = false;
      if (run.processGroupId === run.processPid) groupAlive = false;
    }
  }
  if (groupAlive && !processAlive && run.finishedAt && !absent(run.processGroupId!)) {
    const leaderStartedAt = await host.processStartedAt(run.processGroupId!);
    if (leaderStartedAt && new Date(leaderStartedAt).getTime() > run.finishedAt.getTime()) groupAlive = false;
  }
  return processAlive || groupAlive;
}

function isReleasedSshLease(lease: typeof environmentLeases.$inferSelect) {
  return lease.provider === "ssh" && Boolean(lease.releasedAt) &&
    ["released", "expired", "failed"].includes(lease.status) && lease.cleanupStatus !== "failed";
}

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[], host: HostProcessProbe = hostProcessProbe) {
  if (!agentIds.length) return true;
  // Agents keep every historical run, and result_json/context_snapshot can be
  // megabytes each. Read only what the stop proof needs; the few cancelled runs
  // that need deeper evidence load their full row one at a time below.
  const runs = await db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    status: heartbeatRuns.status,
    startedAt: heartbeatRuns.startedAt,
    runtimeMode: heartbeatRuns.runtimeMode,
    executionStage: heartbeatRuns.executionStage,
    processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    controllerBootId: heartbeatRuns.controllerBootId,
    finishedAt: heartbeatRuns.finishedAt,
    executionCancellationState: sql<string | null>`${heartbeatRuns.resultJson}->'executionCancellation'->>'state'`,
  }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt) &&
          !(runLeases.every(lease => hasRemoteTerminationReceipt(lease) || isReleasedSshLease(lease)) &&
            !await localProcessAlive(run, host))) return false;
      continue;
    }
    if (await localProcessAlive(run, host)) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    let fullRun: HeartbeatRun | null | undefined;
    const loadFullRun = async () => fullRun === undefined
      ? fullRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0] ?? null
      : fullRun;
    // A vanished row is not stop proof; the next sweep re-reads the agent's runs.
    const usedConversationAdapter = async () => {
      const row = await loadFullRun();
      return !row || await runUsedConversationAdapter(db, row);
    };
    const cancelledNativeStartup = async () => {
      const row = await loadFullRun();
      return Boolean(row) && await isCancelledNativeStartup(db, row!, coordinators.find(coordinator => coordinator.runId === run.id));
    };
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await cancelledNativeStartup()) return false;
    const neverDispatched = run.runtimeMode === "legacy" && run.executionStage === "preparing" &&
      Boolean(run.controllerBootId && run.controllerBootId !== legacyControllerBootId &&
        run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt <= new Date());
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId && !neverDispatched &&
        run.executionCancellationState !== "acknowledged" &&
        !(run.executionStage === "settled" && !await usedConversationAdapter()) &&
        !await cancelledNativeStartup()) return false;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
