import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-claude-local/server", () => ({ fetchClaudeQuotaOverSsh: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ fetchCodexQuotaOverSsh: vi.fn() }));
vi.mock("../services/environments.js", () => ({ environmentService: vi.fn() }));
vi.mock("../services/environment-config.js", () => ({ resolveEnvironmentDriverConfigForRuntime: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/quota-windows.js", () => ({ withQuotaTimeout: (_provider: string, task: unknown) => task }));

import { fetchClaudeQuotaOverSsh } from "@paperclipai/adapter-claude-local/server";
import { fetchCodexQuotaOverSsh } from "@paperclipai/adapter-codex-local/server";
import { environmentService } from "../services/environments.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.js";
import { fetchAgentQuotaWindows } from "../services/agent-quota-windows.js";

const db = {} as never;
const weekly = (usedPercent: number, resetsAt: string) => ({
  label: "Weekly limit",
  usedPercent,
  resetsAt,
  valueLabel: null,
  detail: null,
});

function environmentAt(id: string, host: string, updatedAt: Date) {
  const environment = { id, driver: "ssh", config: {}, updatedAt };
  vi.mocked(environmentService).mockReturnValue({ getById: vi.fn().mockResolvedValue(environment) } as never);
  vi.mocked(resolveEnvironmentDriverConfigForRuntime).mockResolvedValue({
    driver: "ssh",
    config: {
      host,
      port: 22,
      username: "agent",
      remoteWorkspacePath: "/work",
      privateKey: "key",
      privateKeySecretRef: null,
      knownHosts: null,
      strictHostKeyChecking: true,
    },
  } as never);
}

const agent = (defaultEnvironmentId: string) => ({
  companyId: "company",
  adapterType: "codex_local",
  adapterConfig: {},
  defaultEnvironmentId,
});

const codexUsage = (results: number[], resetsAt: string) => {
  const usage = [...results];
  vi.mocked(fetchCodexQuotaOverSsh).mockImplementation(async () => ({
    provider: "openai",
    ok: true,
    windows: [weekly(usage.shift()!, resetsAt)],
  }));
};

describe("fetchAgentQuotaWindows", () => {
  beforeEach(() => {
    vi.mocked(fetchClaudeQuotaOverSsh).mockReset().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    vi.mocked(fetchCodexQuotaOverSsh).mockReset();
  });

  it("never answers for a changed SSH target with the previous target's cached quota", async () => {
    const nextWeek = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    codexUsage([20, 100], nextWeek);
    environmentAt("env-target", "host-a", new Date("2026-10-31T08:00:00.000Z"));
    const first = await fetchAgentQuotaWindows(db, agent("env-target"));
    environmentAt("env-target", "host-b", new Date("2026-10-31T09:00:00.000Z"));
    const second = await fetchAgentQuotaWindows(db, agent("env-target"));

    expect(first.find((result) => result.provider === "openai")!.windows[0]!.usedPercent).toBe(20);
    expect(second.find((result) => result.provider === "openai")!.windows[0]!.usedPercent).toBe(100);
    expect(vi.mocked(fetchCodexQuotaOverSsh).mock.calls.map(([spec]) => spec.host)).toEqual(["host-a", "host-b"]);
  });

  it("reads again instead of reusing an observation whose window has already reset", async () => {
    const reset = new Date(Date.now() - 1_000).toISOString();
    codexUsage([80, 3], reset);
    environmentAt("env-reset", "host-a", new Date("2026-10-31T08:00:00.000Z"));
    await fetchAgentQuotaWindows(db, agent("env-reset"));
    const again = await fetchAgentQuotaWindows(db, agent("env-reset"));

    expect(vi.mocked(fetchCodexQuotaOverSsh)).toHaveBeenCalledTimes(2);
    expect(again.find((result) => result.provider === "openai")!.windows[0]!.usedPercent).toBe(3);
  });
});
