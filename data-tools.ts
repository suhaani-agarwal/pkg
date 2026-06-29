import { z } from "zod";
import type { McpServer } from "skybridge/server";
import { getMcpUser, getMcpSessionId } from "../data/mcp-context.js";
import { execute } from "../data-layer/index.js";
import { getTenantOpenApiSpecs } from "../domain/subgraph/repository.js";
import { buildSopSearchGql } from "../domain/subgraph/queries.js";
import { rewriteQueryForVars } from "../data/dashboard-engine.js";
import { jsonErr, flattenResult, flattenAggregateNode, computeQuerySchema } from "./types.js";
import { traceMcpTool } from "../utils/langfuse.js";




// ── GQL normalizer: repair common LLM mistakes in SOP queries ──
function normalizeSopGql(gql: string, tenantId: string, vars: Record<string, any>): { gql: string; vars: Record<string, any> } {
// Already using the correct function+args form — just ensure tenant_id is injected
if (/search_sop_policies\s*\(\s*args\s*:/.test(gql)) {
  if (!vars["tenant_id"]) vars["tenant_id"] = tenantId;
  return { gql, vars };
}
// Used search_sop_policies but without args: wrapper — extract any search_text and rebuild
if (/search_sop_policies/.test(gql)) {
  const stMatch = gql.match(/search_text\s*:\s*["']([^"']+)["']/);
  const st = stMatch?.[1] ?? vars["search_text"] ?? "fuel exception";
  return buildSopSearchGql(st, tenantId);
}
// Queried sop_policies directly with text filters — redirect to the search function
if (/\bsop_policies\b/.test(gql) && /(_ilike|_tsquery|search_text)/.test(gql)) {
  const stMatch = gql.match(/["']%?([^%"']+)%?["']/);
  const st = stMatch?.[1]?.replace(/%/g, "").trim() ?? vars["search_text"] ?? "fuel exception";
  return buildSopSearchGql(st, tenantId);
}
return { gql, vars };
}




export function registerDataTools(server: McpServer): void {
// ── query_data ────────────────────────────────────────────
server.registerTool(
  {
    name: "query_data",
    description: `THE ENTRY POINT for all data. Call FIRST — before any view tool — to confirm exact field names from Hasura.

Rules:
1. Always call query_data before tools that require a \`rows\` parameter.
2. EXCEPTION: show_sop_response does NOT need query_data — call it directly with search_text.
3. Run all needed queries in one call — queries[] executes them in parallel.
4. Use EXACT field names from the schema resource — wrong names cause validation errors.
5. result_path extracts the right node (e.g. "fleet_vehicles", "oracle.metric_si_01"). For multi-alias oracle queries, set result_path to the alias you primarily care about — the server reports all aliases automatically.

Schema resources (open the one you need — can open multiple simultaneously):
  hasura://schema        → routing guide (read first when topic is ambiguous)
  hasura://schema/pg     → fleet tables: vehicles, trips, telemetry_events, drivers; also Fleet Map query patterns
  hasura://schema/oracle → oracle metrics: metric_si_*, metric_pd_*, metric_ana_*, metric_app_*, metric_langfuse_*, metric_status_*, metric_ops_*, langfuse_traces
  hasura://schema/sop    → SOP policies, steps, search function (tenant-scoped)
  hasura://schema/openapi → openapi_specs table

WHAT TO DO WITH RESULTS:
  fleet/oracle/event tables → (1) read_skill("present-data-layouts") to choose blocks and layout → (2) present_data(graphql, result_path, layout) — pass the SAME graphql string, present_data re-fetches all rows. Never copy rows from query_data output for raw graphql.
  fleet map / vehicle location / congestion → fleet_map (read skill://schema-pg for query patterns per mode)
  dashboards with filters → get_kpi_dashboard (only when user explicitly says "dashboard")
  SOP → show_sop_response(search_text) directly — no query_data needed

query_data returns {count, schema, sample[0]} only — NOT full rows. sample[0] is for understanding field names only; never copy rows into present_data.
⚠ "0 rows, columns: none" → wrong table or field name. Fix the GQL before proceeding to any view tool.`,
    inputSchema: {
      queries: z.array(z.object({
        id: z.string().describe("Key to identify this query result"),
        preset: z.enum(["sop_search", "openapi_catalog", "openapi_search"]).optional().describe("Server-built preset queries. 'sop_search' does a full-text SOP policy search with correct tenant isolation — set search_text. 'openapi_catalog' returns compact endpoint catalog (no spec_json) for all registered APIs — use before query_external_api to discover endpoints. 'openapi_search' does FTS over endpoint descriptions — set search_text."),
        search_text: z.string().optional().describe("Required when preset='sop_search' or 'openapi_search'. Keywords to search. Ignored for other presets."),
        graphql: z.string().describe("Full Hasura GraphQL query string. Set to '' when using a preset."),
        variables: z.record(z.string(), z.any()).optional(),
        result_path: z.string().optional().describe("Dot-path to extract rows: 'vehicles', 'oracle.metric_si_01'. Not needed when using a preset."),
        limit: z.number().optional().describe("Max rows to slice after fetch. Omit unless user asked for a specific count. The GraphQL query itself controls row count via its own limit clause."),
      })).describe("One or more GraphQL queries to run in parallel"),
    },
  },
  async ({ queries }) => {
    const mcpUser = getMcpUser();
    const tables = queries.flatMap(q =>
      [...(q.graphql ?? "").matchAll(/\b(vehicles|trips|drivers|telemetry_events|oracle)\b/g)].map(m => m[1])
    );
    return traceMcpTool("query_data", mcpUser?.email ?? null, getMcpSessionId(), { queries, tables }, async () => {
    try {
      const SOP_TABLE_RE = /sop_policies|sop_steps|sop_trigger_conditions|search_sop_policies/;
      const results = await Promise.all(queries.map(async (q) => {
        const mcpUser = getMcpUser();
        const tenantId = mcpUser?.tenant_id ?? mcpUser?.id ?? "default";
        // ── Preset resolution ──────────────────────────────
        if (q.preset === "sop_search") {
          const searchText = q.search_text?.trim() || "fuel exception";
          const { gql, vars } = buildSopSearchGql(searchText, tenantId);
          let data: any;
          try {
            data = await execute(gql, vars);
          } catch (e) {
            return { id: q.id, error: e instanceof Error ? e.message : String(e), rows: [] };
          }
          const node = data?.search_sop_policies;
          const rows = Array.isArray(node) ? node : [];
          return { id: q.id, rows: q.limit ? rows.slice(0, q.limit) : rows };
        }
        // ── openapi_catalog: compact endpoint index, no spec_json ──
        if (q.preset === "openapi_catalog") {
          try {
            const specs = await getTenantOpenApiSpecs(tenantId);
            return { id: q.id, rows: q.limit ? specs.slice(0, q.limit) : specs };
          } catch (e) {
            return { id: q.id, error: e instanceof Error ? e.message : String(e), rows: [] };
          }
        }




        // ── openapi_search: FTS over endpoint descriptions ──────────
        if (q.preset === "openapi_search") {
          const searchText = q.search_text?.trim() || "";
          if (!searchText) return { id: q.id, rows: [] };
          const lim = q.limit ?? 10;
          const gql = `query SearchOpenApiEndpoints($search_text: String!, $p_tenant_id: String!, $lim: Int!) {
            search_openapi_endpoints(args: { search_text: $search_text, p_tenant_id: $p_tenant_id, lim: $lim }) {
              id title spec_summary endpoints_index target_base_url
            }
          }`;
          try {
            const data = await execute(gql, { search_text: searchText, p_tenant_id: tenantId, lim });
            const rows = Array.isArray((data as any).search_openapi_endpoints)
              ? (data as any).search_openapi_endpoints
              : [];
            return { id: q.id, rows };
          } catch (e) {
            return { id: q.id, error: e instanceof Error ? e.message : String(e), rows: [] };
          }
        }




        // ── Raw GQL path (with normalization + tenant injection) ──
        const cleanVars: Record<string, any> = {};
        for (const [k, v] of Object.entries(q.variables ?? {})) {
          // Drop un-interpolated placeholder values like "$tenant_id" or "auto" that the LLM passed literally
          if (v !== null && v !== undefined && !(typeof v === "string" && /^\$\w+$/.test(v)) && v !== "auto") {
            cleanVars[k] = v;
          }
        }
        // Enforce tenant isolation: inject tenant_id for any query touching SOP tables
        if (SOP_TABLE_RE.test(q.graphql) && !cleanVars["tenant_id"]) {
          cleanVars["tenant_id"] = tenantId;
        }
        // Normalize malformed SOP GQL as a final safety net
        let finalGql = q.graphql;
        if (SOP_TABLE_RE.test(q.graphql)) {
          const normalized = normalizeSopGql(q.graphql, tenantId, cleanVars);
          finalGql = normalized.gql;
          Object.assign(cleanVars, normalized.vars);
        }
        const rewritten = rewriteQueryForVars(finalGql, cleanVars);
        // Only pass variables still referenced in the rewritten query — prevents "unexpected variables" Hasura errors
        const rewrittenVarSet = new Set([...rewritten.matchAll(/\$(\w+)/g)].map(m => m[1]));
        const finalVars: Record<string, any> = {};
        for (const [k, v] of Object.entries(cleanVars)) {
          if (rewrittenVarSet.has(k)) finalVars[k] = v;
        }
        let data: any;
        try {
          data = await execute(rewritten, finalVars);
        } catch (e) {
          return { id: q.id, error: e instanceof Error ? e.message : String(e), rows: [] };
        }
        let rows: any[];
        // Multi-alias oracle detection: result_path resolves to a plain object whose values are arrays
        // (e.g. result_path:"oracle" → {cost:[...], latency:[...]})
        type AliasEntry = { path: string; count: number; schema: ReturnType<typeof computeQuerySchema> };
        let aliases: AliasEntry[] | undefined;
        if (q.result_path) {
          const parts = q.result_path.split(".");
          let node: any = data;
          for (const part of parts) node = node?.[part];
          if (Array.isArray(node)) {
            rows = node;
          } else if (node && typeof node === "object") {
            const entries = Object.entries(node) as [string, any][];
            const arrayEntries = entries.filter(([, v]) => Array.isArray(v));
            if (arrayEntries.length >= 2) {
              // Multi-alias response: report each child alias with its own result_path
              aliases = arrayEntries.map(([key, arr]) => ({
                path: `${q.result_path}.${key}`,
                count: (arr as any[]).length,
                schema: computeQuerySchema(arr as any[]),
              }));
              const firstNonEmpty = arrayEntries.find(([, v]) => (v as any[]).length > 0);
              rows = firstNonEmpty ? firstNonEmpty[1] : [];
            } else if ("aggregate" in node) {
              // Single aggregate object — flatten using last result_path segment as key
              const alias = q.result_path!.split(".").pop() ?? "value";
              rows = [flattenAggregateNode(alias, node)];
            } else {
              rows = [node];
            }
          } else {
            rows = [];
          }
        } else {
          rows = flattenResult(data);
        }
        if (q.limit) rows = rows.slice(0, q.limit);
        // Flatten data_payload JSONB before computing schema so inner keys (exception_type,
        // amount_paid, driver_name, etc.) appear as top-level columns — the LLM uses these
        // as direct field keys in layout; "data_payload" itself is never a valid field key.
        const schemaRows = rows.map((row: any) => {
          if (row.data_payload && typeof row.data_payload === "object" && !Array.isArray(row.data_payload)) {
            const { data_payload, ...rest } = row;
            return { ...rest, ...data_payload };
          }
          return row;
        });
        const schema = computeQuerySchema(schemaRows);
        return { id: q.id, count: rows.length, schema, aliases };
      }));




      // Strip sample rows from structuredContent — the LLM must not treat them as usable data to
      // pass to present_data. Column names and types (kept here) are sufficient for writing layout.
      const output = Object.fromEntries(results.map((r: any) => {
        const { schema, ...rest } = r;
        const { sample: _s, ...schemaNoSample } = schema ?? {};
        return [r.id, { ...rest, schema: schemaNoSample }];
      }));
      const summary = results.map((r) => {
        const err = (r as any).error;
        if (err) return `${r.id}: FAILED — ${String(err).slice(0, 200)} (check column names against hasura://schema)`;
        const aliases: Array<{ path: string; count: number; schema: any }> | undefined = (r as any).aliases;
        if (aliases) {
          // Multi-alias oracle result — report each alias with correct result_path hint
          const aliasLines = aliases.map((a) => {
            const s = a.schema;
            const catVals = s?.categorical_values ? Object.entries(s.categorical_values).map(([k, v]: [string, any]) => `${k}:[${(v as string[]).slice(0,3).join(",")}${v.length > 3 ? "…" : ""}]`).join(", ") : "";
            const sampleStr = s?.sample?.[0] ? `\n      sample[0]: ${JSON.stringify(s.sample[0]).slice(0, 200)}` : "";
            return `  result_path:"${a.path}" → ${a.count} rows, columns: ${s?.columns?.map((c: string) => `${c}(${s.types?.[c] ?? "?"}${s.nullable?.[c] ? "|null" : ""})`).join(", ") || "none"}${catVals ? `, categorical: {${catVals}}` : ""}${sampleStr}`;
          }).join("\n");
          return `${r.id}: multi-alias oracle response — use specific result_path per alias:\n${aliasLines}`;
        }
        const s = (r as any).schema;
        const catVals = s?.categorical_values ? Object.entries(s.categorical_values).map(([k, v]: [string, any]) => `${k}:[${(v as string[]).slice(0,4).join(",")}${v.length > 4 ? "…" : ""}]`).join(", ") : "";
        const count = (r as any).count ?? r.rows?.length ?? 0;
        const q = queries.find((qq) => qq.id === r.id);
        // Suggest tab_table when a categorical field exists (strong layout hint)
        const catFields = s?.categorical_values ? Object.keys(s.categorical_values) : [];
        const layoutHint = catFields.length > 0
          ? `stat_row + tab_table(tab_field:"${catFields[0]}")`
          : `stat_row + best block per skill`;
        const nextStep = q?.graphql
          ? `\n  → NEXT STEPS: (1) read_skill("present-data-layouts") (2) present_data(graphql:"<same graphql>", result_path:"${q.result_path ?? r.id}", layout:[${layoutHint}]) — server re-fetches all ${count} rows, do NOT pass rows param.`
          : "";
        return `${r.id}: ${count} rows\n  columns: ${s?.columns?.map((c: string) => `${c}(${s.types?.[c] ?? "?"}${s.nullable?.[c] ? "|null" : ""})`).join(", ") || "none"}${catVals ? `\n  categorical_values: {${catVals}}` : ""}${s?.sample?.[0] ? `\n  sample[0]: ${JSON.stringify(s.sample[0]).slice(0, 400)}` : ""}${nextStep}`;
      }).join("\n\n");
      return {
        structuredContent: { results: output },
        content: [{ type: "text" as const, text: `Query results:\n${summary}` }],
        isError: false,
      };
    } catch (e) {
      return jsonErr(e instanceof Error ? e.message : "Unknown error");
    }
    }); // traceMcpTool
  },
);
}
