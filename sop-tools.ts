import { z } from "zod";
import type { McpServer } from "skybridge/server";
import { getMcpUser, getMcpSessionId } from "../data/mcp-context.js";
import { traceMcpTool } from "../utils/langfuse.js";
import { execute } from "../data-layer/index.js";
import {
  getTenantOpenApiSpecs,
  getTenantPolicies,
  insertSopDocument,
  insertSopPolicies,
  insertSopSteps,
  insertSopTriggerConditions,
  insertOpenApiSpec,
  updateOpenApiPostProcess,
  upsertSopPolicyApiLinks,
} from "../domain/subgraph/repository.js";
import { linkPoliciesToApiEndpoints } from "../domain/subgraph/pipeline.js";
import { buildEndpointIndex, buildEndpointsText } from "../domain/subgraph/openapi-indexer.js";
import { buildSopSearchGql } from "../domain/subgraph/queries.js";
import { jsonOk, jsonErr } from "./types.js";

export function registerSopTools(server: McpServer): void {
  // ── show_sop_response ─────────────────────────────────────
  server.registerTool(
    {
      name: "show_sop_response",
      description: `Render SOP policies as rich cards and surface the correct API endpoint to execute.

Call with ONLY search_text — everything is fetched server-side. Never pass raw policy arrays.

MANDATORY — in the SAME response turn:
  Step 1: call show_sop_response(search_text="...") — renders the SOP cards.
  Step 2: read the result — it names the top endpoint as "ACTION REQUIRED: Call query_external_api(mode="execute", spec_id="...", path="...", method="...") NOW". Call query_external_api with EXACTLY those values in the SAME turn. mode MUST be "execute". Never call mode="discover" or present_data after show_sop_response.

If no API endpoints linked yet: tell user to register a spec via register_openapi_spec. Do NOT call present_data.`,
      inputSchema: {
        search_text: z.string().describe("Keywords describing the SOP topic — e.g. 'low fuel alert', 'fuel fraud', 'maintenance escalation'"),
      },
      view: {
        component: "sop-response",
        description: "SOP policy cards with steps, trigger conditions, live fleet cross-data, and suggested API actions",
      },
    },
    async ({ search_text }) => {
      const mcpUser = getMcpUser();
      return traceMcpTool("show_sop_response", mcpUser?.email ?? null, getMcpSessionId(), { search_text }, async () => {
      try {
        const tenantId = mcpUser?.tenant_id ?? mcpUser?.id ?? "default";

        // ── 1. Fetch SOP policies with pre-computed api_links ──
        const { gql: sopGql, vars: sopVars } = buildSopSearchGql(search_text, tenantId, 3);
        let policies: any[] = [];
        try {
          const data = await execute(sopGql, sopVars) as any;
          policies = Array.isArray(data?.search_sop_policies) ? data.search_sop_policies : [];
        } catch {
          policies = [];
        }

        // Vehicle cross-query removed: the caller already has the specific vehicles they found.
        // Auto-querying by SOP trigger threshold returns a different (often larger) set and confuses things.
        const matchedVehicles: any[] = [];

        // ── 3. Ranked API endpoints: pre-computed links first, keyword fallback ──
        let rankedEndpoints: any[] = [];

        // Primary: extract pre-computed links from sop_policy_api_links (joined in query above)
        const precomputedLinks: any[] = [];
        for (const p of policies) {
          for (const link of (p.api_links ?? [])) {
            precomputedLinks.push({
              spec_id: link.spec_id,
              spec_title: link.spec?.title ?? "",
              base_url: link.spec?.target_base_url ?? "",
              path: link.path,
              method: link.method,
              summary: link.relevance_reason,
              score: link.relevance_score ?? 1,
            });
          }
        }

        if (precomputedLinks.length > 0) {
          const seen = new Set<string>();
          for (const ep of precomputedLinks.sort((a, b) => b.score - a.score)) {
            const key = `${ep.spec_id}|${ep.method}|${ep.path}`;
            if (!seen.has(key)) { seen.add(key); rankedEndpoints.push(ep); }
            if (rankedEndpoints.length >= 3) break;
          }
        } else {
          // Fallback: keyword scoring against endpoints_index from registered specs
          // Runs server-side — zero tokens, zero LLM
          try {
            const specs = await getTenantOpenApiSpecs(tenantId);
            const policyKeywords = policies.flatMap((p: any) =>
              [...(p.keywords ?? []), ...String(p.title ?? "").toLowerCase().split(/\s+/), ...String(p.summary ?? "").toLowerCase().split(/\s+/)]
            ).filter((k: string) => k.length > 3);
            const queryWords = search_text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
            const allKeywords = [...new Set([...policyKeywords, ...queryWords])];

            type ScoredEp = { spec_id: string; spec_title: string; base_url: string; path: string; method: string; summary: string | null; score: number };
            const scored: ScoredEp[] = [];
            for (const spec of specs) {
              for (const ep of ((spec as any).endpoints_index ?? [])) {
                const epText = `${ep.path} ${ep.method} ${ep.summary ?? ""} ${ep.description ?? ""} ${(ep.tags ?? []).join(" ")}`.toLowerCase();
                let score = 0;
                for (const kw of allKeywords) { if (epText.includes(kw)) score++; }
                if (score > 0) {
                  scored.push({ spec_id: spec.id, spec_title: spec.title, base_url: (spec as any).target_base_url ?? "", path: ep.path, method: ep.method, summary: ep.summary ?? null, score });
                }
              }
            }
            scored.sort((a, b) => b.score - a.score);
            const seen = new Set<string>();
            for (const ep of scored) {
              const key = `${ep.spec_id}|${ep.method}|${ep.path}`;
              if (!seen.has(key)) { seen.add(key); rankedEndpoints.push(ep); }
              if (rankedEndpoints.length >= 3) break;
            }
          } catch {
            rankedEndpoints = [];
          }
        }

        const policyCount = policies.length;
        const endpointCount = rankedEndpoints.length;

        const lines: string[] = [
          `${policyCount} SOP polic${policyCount === 1 ? "y" : "ies"} rendered.`,
        ];

        if (endpointCount > 0) {
          lines.push(`\n${endpointCount} relevant API endpoint${endpointCount === 1 ? "" : "s"} identified:`);
          for (const ep of rankedEndpoints) {
            lines.push(
              `  ${ep.method} ${ep.path}  [spec_id: ${ep.spec_id}]  ${ep.base_url ?? ep.spec_title}${ep.summary ? ` — ${ep.summary}` : ""}`,
            );
          }
          const top = rankedEndpoints[0];

          // Generic "check before create/update" guidance — applies to any API, not just one vendor.
          // If the top endpoint's path has a templated ID (e.g. {caseNumber}) you don't already have,
          // the FIRST action must be resolving it, not calling the write endpoint with the literal
          // {placeholder} text still in the path (that 404s on the real API and looks like "not found").
          const pathParams = [...top.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
          if (pathParams.length > 0) {
            const lookupEp = rankedEndpoints.find(
              (ep) => ep.spec_id === top.spec_id && ep.method === "GET" && [...ep.path.matchAll(/\{(\w+)\}/g)].length === 0,
            );
            const exampleResolvedPath = top.path.replace(/\{(\w+)\}/g, "<real-id>");
            if (lookupEp) {
              lines.push(
                `\n${top.path} needs a real ${pathParams.join(", ")} substituted in before it can be called — never call it with the literal {placeholder} still in the path.`,
                `\nACTION REQUIRED: Call query_external_api(mode="execute", spec_id="${lookupEp.spec_id}", path="${lookupEp.path}", method="GET") NOW to look up the record (e.g. by VIN or name).`,
                `Then, in your NEXT turn: if a record was found, call query_external_api(mode="execute", spec_id="${top.spec_id}", method="${top.method}", path="${exampleResolvedPath}") with its real ID substituted in place of <real-id> — never pass "${top.path}" with the literal {placeholder} still in it. If nothing was found, look for a POST endpoint on this same spec that creates a new record first, then act on the ID it returns.`,
              );
            } else {
              lines.push(
                `\n${top.path} needs a real ${pathParams.join(", ")} substituted in before it can be called — never call it with the literal {placeholder} still in the path.`,
                `\nACTION REQUIRED: Call query_external_api(mode="discover", spec_id="${top.spec_id}") NOW to find a lookup/list/create endpoint on this same spec, resolve or create the real record, then call ${top.method} ${exampleResolvedPath} with its real ID substituted in.`,
              );
            }
          } else {
            lines.push(
              `\nACTION REQUIRED: Call query_external_api(mode="execute", spec_id="${top.spec_id}", path="${top.path}", method="${top.method}") NOW in this same response to show the execution confirmation form.`,
            );
          }
        } else {
          lines.push("No registered API endpoints linked to these policies yet.");
        }

        return {
          structuredContent: { policies, matched_vehicles: matchedVehicles, ranked_endpoints: rankedEndpoints },
          content: [{ type: "text" as const, text: lines.join("\n") }],
          isError: false,
        };
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
      }); // traceMcpTool
    },
  );

  // ── create_sop_policies ───────────────────────────────────
  server.registerTool(
    {
      name: "create_sop_policies",
      description:
        "Store SOP policies that the user provides in chat. " +
        "Read the user's SOP text, extract every distinct policy/procedure as a separate item, fill in the structured fields, then call this tool. " +
        "Returns a sop_doc_id you can pass to register_openapi_spec to link an API spec to this SOP. " +
        "After saving, policies become searchable via query_data(preset='sop_search').",
      inputSchema: {
        title: z.string().describe("SOP document title, e.g. 'Vehicle Fuel Management SOP'"),
        raw_text: z.string().describe("The full original SOP text as provided by the user — preserve verbatim for the document record"),
        policies: z.array(z.object({
          category: z.enum(["incident_response", "escalation", "compliance", "maintenance", "safety", "communication", "general"])
            .describe("Best-fit category slug for this policy item"),
          subcategory: z.string()
            .describe("More specific slug, e.g. 'low_fuel_alert', or empty string if none"),
          title: z.string()
            .describe("5–10 word imperative headline, e.g. 'Notify dispatcher when fuel falls below 15%'"),
          summary: z.string()
            .describe("EXACTLY 1 sentence (max 20 words) stating WHEN this policy applies and what it governs"),
          description: z.string()
            .describe("2–4 sentences explaining what this policy covers and why it exists"),
          keywords: z.array(z.string())
            .describe("5–12 lowercase keywords a user might search, e.g. ['fuel', 'low fuel', 'refuel', 'fuel exception']"),
          severity: z.enum(["critical", "high", "medium", "low", "info"])
            .describe("Consequence of non-compliance: critical=safety risk, high=major ops impact, medium=moderate, low=minor, info=informational"),
          applies_to: z.array(z.string())
            .describe("Roles this policy applies to, e.g. ['fleet_manager', 'driver', 'dispatcher']"),
          steps: z.array(z.object({
            step_number: z.number().int().positive(),
            title: z.string().describe("3–8 word imperative action title, e.g. 'Notify insurance carrier within 2 hours'"),
            description: z.string().describe("Full detail, sub-steps, conditions, and context for this action"),
            action_required: z.boolean().describe("true if mandatory; false if conditional or optional"),
            responsible_role: z.string().describe("Snake_case role who performs this step, e.g. 'fleet_manager', 'driver'"),
          })).describe("Ordered steps to execute this policy, numbered from 1"),
          trigger_conditions: z.array(z.object({
            entity: z.enum(["vehicles", "telemetry_events", "trips"])
              .describe("Hasura table this condition checks"),
            field: z.string()
              .describe("Exact column — vehicles: vin|status|fuel_level_pct|odometer | telemetry_events: event_type|vin | trips: status|distance_mi|delay_minutes|duration_min"),
            operator: z.enum(["<", ">", "<=", ">=", "=", "!="]),
            threshold_value: z.string().describe("Threshold as string, e.g. '15', 'maintenance', 'fuel_exception'"),
            threshold_unit: z.string().describe("Unit or empty string, e.g. '%', 'miles', 'minutes', ''"),
          })).describe("ONLY populate for measurable numeric or enum thresholds. Leave [] if no clear trigger threshold exists."),
        })).describe("Extract EVERY distinct policy/procedure item from the SOP as a separate entry. Do not merge distinct items."),
      },
      view: {
        component: "sop-creator",
        description: "Confirmation card showing the created SOP with policy summary, step counts, and trigger conditions",
      },
    },
    async ({ title, raw_text, policies }) => {
      const mcpUser = getMcpUser();
      if (!mcpUser) return jsonErr("Not authenticated. Send API key via: Authorization: Bearer <key> | x-api-key: <key> | ?api_key=<key>");
      const tenantId = mcpUser?.tenant_id ?? mcpUser?.id ?? "default";

      if (policies.length === 0) return jsonErr("No policies provided — extract policy items from the SOP text and supply them in the 'policies' array");

      try {
        const sopTitle = title.trim().slice(0, 200);

        const sop = await insertSopDocument({ user_id: mcpUser.id, tenant_id: tenantId, title: sopTitle, raw_text: raw_text.trim() });

        const result = await insertSopPolicies(policies.map((p) => ({
          sop_doc_id: sop.id,
          user_id: mcpUser.id,
          tenant_id: tenantId,
          category: p.category,
          subcategory: p.subcategory,
          title: p.title,
          summary: p.summary,
          description: p.description,
          content: p.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.description}`).join("\n"),
          keywords: p.keywords,
          severity: p.severity,
          applies_to: p.applies_to,
        })));

        const allSteps = result.returning.flatMap((row, idx) =>
          (policies[idx]?.steps ?? []).map((s) => ({
            policy_id: row.id, tenant_id: tenantId,
            step_number: s.step_number, title: s.title,
            description: s.description, action_required: s.action_required,
            responsible_role: s.responsible_role,
          }))
        );
        const allTriggers = result.returning.flatMap((row, idx) =>
          (policies[idx]?.trigger_conditions ?? []).map((t) => ({
            policy_id: row.id, tenant_id: tenantId,
            entity: t.entity, field: t.field,
            operator: t.operator, threshold_value: t.threshold_value,
            threshold_unit: t.threshold_unit,
          }))
        );

        const [stepsResult, triggersResult] = await Promise.all([
          insertSopSteps(allSteps),
          insertSopTriggerConditions(allTriggers),
        ]);

        const policyStubs = result.returning.map((row, idx) => ({
          id: row.id,
          title: row.title,
          summary: policies[idx]?.summary ?? "",
        }));

        setImmediate(async () => {
          try {
            const specs = await getTenantOpenApiSpecs(tenantId);
            if (specs.length === 0) return;
            const links = await linkPoliciesToApiEndpoints(policyStubs, specs, tenantId);
            if (links.length > 0) await upsertSopPolicyApiLinks(links.map((l) => ({ ...l, tenant_id: tenantId })));
          } catch (e) { console.error("[create_sop_policies] link error:", e); }
        });

        return jsonOk({
          sop_doc_id: sop.id,
          title: sopTitle,
          policies_created: result.affected_rows,
          steps_created: stepsResult.affected_rows,
          triggers_created: triggersResult.affected_rows,
          policy_preview: result.returning.slice(0, 5).map((p) => ({ id: p.id, title: p.title, category: p.category })),
          trigger_summary: allTriggers.slice(0, 5).map((t) => `${t.entity}.${t.field} ${t.operator} ${t.threshold_value}${t.threshold_unit}`),
        });
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Failed to create SOP policies");
      }
    },
  );

  // ── register_openapi_spec ─────────────────────────────────
  server.registerTool(
    {
      name: "register_openapi_spec",
      description:
        "Register an OpenAPI spec so it becomes available to query_external_api. " +
        "Use this when the user pastes an OpenAPI JSON, shares a URL you fetched via fetch_url_content, or asks you to build a spec from their API description. " +
        "Optionally link to an existing SOP by passing sop_doc_id from create_sop_policies. " +
        "After registering, call query_external_api(mode='discover') to confirm the spec appears.",
      inputSchema: {
        title: z.string().describe("Human-readable API title, e.g. 'Fleet Fuel Management API'"),
        base_url: z.string().describe("Base URL where this API is hosted, e.g. 'https://api.fleet.example.com/v1'"),
        spec_json: z.record(z.string(), z.unknown()).describe(
          "Valid OpenAPI 3.0.0 JSON. Must contain: 'openapi' (string starting with '3'), 'info' (object with title+version), 'paths' (object with at least one endpoint). " +
          "If the user pasted raw JSON, use it as-is. If they described their API, construct a complete valid spec. " +
          "If you fetched a URL via fetch_url_content, pass the returned JSON content here."
        ),
        description: z.string().optional().describe("Optional description of what this API does (supplements spec_json.info.description)"),
        sop_doc_id: z.string().optional().describe("UUID of an existing SOP document to link this spec to — use the sop_doc_id returned by create_sop_policies"),
      },
      view: {
        component: "openapi-creator",
        description: "Confirmation card showing the registered spec with endpoint list and linking status",
      },
    },
    async ({ title, base_url, spec_json, description, sop_doc_id }) => {
      const mcpUser = getMcpUser();
      if (!mcpUser) return jsonErr("Not authenticated. Send API key via: Authorization: Bearer <key> | x-api-key: <key> | ?api_key=<key>");
      const tenantId = mcpUser?.tenant_id ?? mcpUser?.id ?? "default";

      const s = spec_json as Record<string, any>;
      if (!s.openapi || !s.info || !s.paths) {
        return jsonErr("spec_json must be a valid OpenAPI 3.x document — requires 'openapi', 'info', and 'paths' fields");
      }
      if (!base_url.trim()) return jsonErr("base_url is required");

      try {
        const specTitle = title.trim() || (s.info?.title as string) || "Untitled Spec";
        const specSummary = ((s.info?.description as string) ?? "").trim();

        const index = buildEndpointIndex(s);
        const endpointsText = buildEndpointsText(index);

        const spec = await insertOpenApiSpec({
          user_id: mcpUser.id,
          tenant_id: tenantId,
          sop_doc_id: sop_doc_id ?? null,
          title: specTitle,
          description: description?.trim() || specSummary,
          spec_json: s,
          target_base_url: base_url.trim(),
          source_type: sop_doc_id ? "sop_converted" : "raw_upload",
          registration_status: "processing",
        });

        await updateOpenApiPostProcess(spec.id, {
          endpoints_index: index,
          endpoints_text: endpointsText,
          spec_summary: specSummary,
          registration_status: "registered",
        });

        setImmediate(async () => {
          try {
            const allPolicies = await getTenantPolicies(tenantId);
            if (allPolicies.length === 0) return;
            const policyStubs = allPolicies.map((p) => ({ id: p.id, title: p.title, summary: p.summary }));
            const links = await linkPoliciesToApiEndpoints(
              policyStubs,
              [{ id: spec.id, title: specTitle, endpoints_index: index }],
              tenantId,
            );
            if (links.length > 0) await upsertSopPolicyApiLinks(links.map((l) => ({ ...l, tenant_id: tenantId })));
          } catch (e) { console.error("[register_openapi_spec] link error:", e); }
        });

        return jsonOk({
          spec_id: spec.id,
          title: specTitle,
          target_base_url: base_url.trim(),
          sop_doc_id: sop_doc_id ?? null,
          endpoint_count: index.length,
          endpoints: index.slice(0, 20).map((ep) => ({ method: ep.method, path: ep.path, summary: ep.summary })),
          registration_status: "registered",
        });
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Failed to register OpenAPI spec");
      }
    },
  );

  // ── fetch_url_content ─────────────────────────────────────
  server.registerTool(
    {
      name: "fetch_url_content",
      description:
        "Fetch the content of a URL so you can process it. " +
        "Use this when the user shares a link to an OpenAPI spec (e.g. https://api.example.com/openapi.json) or API documentation page. " +
        "For JSON responses (OpenAPI specs), pass the returned content directly to register_openapi_spec. " +
        "For HTML/text documentation pages, read the content and extract the information you need.",
      inputSchema: {
        url: z.string().url().describe(
          "URL to fetch. Examples: 'https://api.example.com/openapi.json' for a spec file, 'https://docs.example.com/api' for a docs page. " +
          "Must be a public HTTPS URL — internal/private network addresses are blocked."
        ),
      },
    },
    async ({ url }) => {
      const mcpUser = getMcpUser();
      if (!mcpUser) return jsonErr("Not authenticated. Send API key via: Authorization: Bearer <key> | x-api-key: <key> | ?api_key=<key>");

      try {
        const { hostname } = new URL(url);
        const privatePatterns = [
          /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./,
        ];
        if (privatePatterns.some((p) => p.test(hostname))) {
          return jsonErr("Cannot fetch internal/private network URLs");
        }
      } catch {
        return jsonErr("Invalid URL");
      }

      try {
        const response = await fetch(url, {
          headers: { "Accept": "application/json, text/html, text/plain, */*", "User-Agent": "ctrl-mcp/1.0" },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) return jsonErr(`Failed to fetch ${url}: HTTP ${response.status}`);

        const contentType = response.headers.get("content-type") ?? "";

        if (contentType.includes("application/json") || url.endsWith(".json") || url.endsWith(".yaml") || url.endsWith(".yml")) {
          const json = await response.json();
          return jsonOk({ type: "json", url, content: json });
        } else {
          const text = await response.text();
          return jsonOk({ type: "text", url, content: text.slice(0, 50000) });
        }
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : `Failed to fetch ${url}`);
      }
    },
  );

}
