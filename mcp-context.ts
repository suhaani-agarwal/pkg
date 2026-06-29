import { AsyncLocalStorage } from "node:async_hooks";
import type { UserRecord } from "../domain/app/user/types.js";

interface McpContext {
  user: UserRecord | null;
  sessionId: string;
}

const als = new AsyncLocalStorage<McpContext>();

export function runWithMcpContext<T>(ctx: McpContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function getMcpUser(): UserRecord | null {
  return als.getStore()?.user ?? null;
}

export function getMcpSessionId(): string {
  return als.getStore()?.sessionId ?? "unknown";
}
