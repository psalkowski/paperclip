import type { Agent, ProviderQuotaResult, SshEnvironmentConfig } from "@paperclipai/shared";

type QuotaAgent = Pick<Agent, "companyId" | "adapterType" | "defaultEnvironmentId"> & { adapterConfig: unknown };
import type { Db } from "@paperclipai/db";
import { fetchClaudeQuotaOverSsh } from "@paperclipai/adapter-claude-local/server";
import { fetchCodexQuotaOverSsh } from "@paperclipai/adapter-codex-local/server";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import { environmentService } from "./environments.js";
import { withQuotaTimeout } from "./quota-windows.js";
import { logger } from "../middleware/logger.js";

const CACHE_TTL_MS = 5 * 60_000;
const SOURCE = "ssh-environment";
const PROVIDER_ADAPTERS = [
  { provider: "anthropic", adapterType: "claude_local", defaultCommand: "claude" },
  { provider: "openai", adapterType: "codex_local", defaultCommand: "codex" },
] as const;

type Provider = (typeof PROVIDER_ADAPTERS)[number]["provider"];

const cache = new Map<string, { expires: number; result: Promise<ProviderQuotaResult> }>();

const unavailable = (provider: string, errorFamily: string, error: string): ProviderQuotaResult => ({
  provider,
  source: SOURCE,
  ok: false,
  errorFamily,
  error,
  windows: [],
});

function cacheExpiry(result: ProviderQuotaResult, now: number): number {
  const resets = result.windows
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN))
    .filter((time) => Number.isFinite(time) && time > now);
  return Math.min(now + CACHE_TTL_MS, ...resets);
}

function commandFor(agent: QuotaAgent, provider: Provider): string {
  const entry = PROVIDER_ADAPTERS.find((candidate) => candidate.provider === provider)!;
  const configured = (agent.adapterConfig as { command?: unknown } | null)?.command;
  return agent.adapterType === entry.adapterType && typeof configured === "string" && configured.trim()
    ? configured.trim()
    : entry.defaultCommand;
}

async function probe(config: SshEnvironmentConfig, provider: Provider, command: string): Promise<ProviderQuotaResult> {
  try {
    return provider === "anthropic"
      ? await fetchClaudeQuotaOverSsh(config, command)
      : await fetchCodexQuotaOverSsh({ ...config, remoteCwd: config.remoteWorkspacePath }, command);
  } catch (error) {
    const errorFamily =
      typeof (error as { errorFamily?: unknown })?.errorFamily === "string"
        ? (error as { errorFamily: string }).errorFamily
        : "provider_unavailable";
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ provider, errorFamily }, "Agent environment quota unavailable");
    return unavailable(provider, errorFamily, message.slice(0, 500));
  }
}

function cachedProbe(environmentId: string, config: SshEnvironmentConfig, provider: Provider, command: string) {
  const key = `${environmentId}:${provider}:${command}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.result;
  const result = withQuotaTimeout(provider, probe(config, provider, command)).then((value) => {
    const settled = { ...value, source: value.source ?? SOURCE };
    if (cache.get(key)?.result === result) {
      if (settled.ok) cache.set(key, { result, expires: cacheExpiry(settled, Date.now()) });
      else cache.delete(key);
    }
    return settled;
  });
  cache.set(key, { result, expires: now + CACHE_TTL_MS });
  return result;
}

export async function fetchAgentQuotaWindows(db: Db, agent: QuotaAgent): Promise<ProviderQuotaResult[]> {
  const environment = agent.defaultEnvironmentId
    ? await environmentService(db).getById(agent.defaultEnvironmentId)
    : null;
  if (!environment || environment.driver !== "ssh") {
    return PROVIDER_ADAPTERS.map(({ provider }) =>
      unavailable(provider, "unsupported_environment", "Quota is read only on an agent's SSH environment."),
    );
  }
  const resolved = await resolveEnvironmentDriverConfigForRuntime(db, agent.companyId, environment);
  if (resolved.driver !== "ssh") {
    return PROVIDER_ADAPTERS.map(({ provider }) =>
      unavailable(provider, "unsupported_environment", "Quota is read only on an agent's SSH environment."),
    );
  }
  return Promise.all(
    PROVIDER_ADAPTERS.map(({ provider }) =>
      cachedProbe(environment.id, resolved.config, provider, commandFor(agent, provider)),
    ),
  );
}
