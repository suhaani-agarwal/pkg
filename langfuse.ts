/**
 * Optional Langfuse tracing for MCP tool calls.
 * No-op when LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY env vars are not set.
 *
 * Usage in a tool handler:
 *   import { traceMcpTool } from "../utils/langfuse.js";
 *   import { getMcpSessionId } from "../data/mcp-context.js";
 *
 *   const mcpUser = getMcpUser();
 *   return traceMcpTool("query_data", mcpUser?.email ?? null, getMcpSessionId(), args, async () => {
 *     // ... your handler logic ...
 *   });
 */
import { Langfuse } from "langfuse";

let _client: Langfuse | null = null;
let _initialized = false;

function getClient(): Langfuse | null {
  if (_initialized) return _client;
  _initialized = true;

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  if (!secretKey || !publicKey) return (_client = null);

  try {
    // SDK auto-reads LANGFUSE_BASEURL from env; no need to pass baseUrl explicitly
    // unless using a non-default host.
    _client = new Langfuse({
      secretKey,
      publicKey,
      flushAt: 10,
      flushInterval: 5000,
    });
  } catch {
    _client = null;
  }

  return _client;
}

/**
 * Compute an hourly session ID so all tool calls from the same user
 * within the same hour appear in one Langfuse session.
 * MCP tool calls are separate HTTP requests so we can't share
 * AsyncLocalStorage across them — time-window grouping is the next best thing.
 */
export function buildSessionId(email: string | null): string {
  const hour = new Date().toISOString().slice(0, 13); // "2026-06-29T15"
  return `${email ?? "anon"}:${hour}`;
}

/**
 * Wraps a tool handler with an optional Langfuse span.
 * Each MCP tool call becomes one Langfuse trace named after the tool.
 * The sessionId groups all tool calls from the same user within the same hour
 * into one session, so the read_skill → query_data → present_data flow is
 * visible as a session in Langfuse.
 *
 * @param toolName   MCP tool name (e.g. "query_data") — becomes the trace name
 * @param userId     User email or ID (null = anonymous)
 * @param sessionId  Hourly session bucket — pass getMcpSessionId() from mcp-context
 * @param input      Compact tool arguments (logged as span input)
 * @param fn         The actual handler to run
 */
export async function traceMcpTool<T>(
  toolName: string,
  userId: string | null,
  sessionId: string | null,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const lf = getClient();
  if (!lf) return fn();

  // Each tool call is its own trace; sessionId groups them in the Sessions view.
  const trace = lf.trace({
    name: toolName,
    userId: userId ?? "anonymous",
    sessionId: sessionId ?? undefined,
    input,
  });
  const span = trace.span({ name: toolName, input });

  try {
    const result = await fn();
    // Log compact text output only — avoids sending large row payloads to Langfuse.
    const output = extractTextOutput(result);
    span.end({ output });
    trace.update({ output });
    return result;
  } catch (err: any) {
    span.end({ level: "ERROR", statusMessage: String(err?.message ?? err) });
    trace.update({ output: `ERROR: ${String(err?.message ?? err)}` });
    throw err;
  }
}

/** Extract the human-readable text from a tool result without sending row data. */
function extractTextOutput(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as any;
  // MCP tool result: content[] array of text blocks
  const textBlocks: string[] = (r.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => String(c.text ?? ""));
  if (textBlocks.length > 0) return textBlocks.join("\n").slice(0, 2000);
  // Fallback: stringify but cap size
  return JSON.stringify(result).slice(0, 500);
}
