import type { BillingType } from "@paperclipai/shared";

export function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = typeof value === "string" && value.trim().length > 0 ? value : null;
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

export function isSubscriptionIncluded(value: unknown): boolean {
  return normalizeLedgerBillingType(value) === "subscription_included";
}
