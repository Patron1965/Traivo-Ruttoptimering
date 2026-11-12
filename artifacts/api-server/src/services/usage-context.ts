import { AsyncLocalStorage } from "node:async_hooks";
import type { OrganizationServicePolicy } from "./organization-service-policy";

export interface UsageContext {
  organizationId: string;
  jobId?: string;
  servicePolicy?: Readonly<OrganizationServicePolicy>;
}

const usageContext = new AsyncLocalStorage<UsageContext>();

export function runWithUsageContext<T>(
  context: UsageContext,
  fn: () => T,
): T {
  return usageContext.run(context, fn);
}

export function getUsageContext(): UsageContext | undefined {
  return usageContext.getStore();
}