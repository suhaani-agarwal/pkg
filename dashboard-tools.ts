import { z } from "zod";
import type { McpServer } from "skybridge/server";
import { getMcpUser, getMcpSessionId } from "../data/mcp-context.js";
import { traceMcpTool } from "../utils/langfuse.js";
import {
  getSharedDashboard,
  updateSharedDashboard,
} from "../data/data-service.js";
import { baseUrl as baseUrlStr } from "../utils/base-url.js";
import type { NewWidgetSpec, NewDashboardSpec, FilterDef } from "../types/dashboard-spec.js";
import { jsonErr, widgetSpecSchema, filterSpecSchema, persistSpec } from "./types.js";

// A FilterDef's `key` IS the GraphQL variable name a widget must declare ($key) AND
// actually reference inside a where clause for the filter to have any effect.
// Declaring $key without using it isn't just inert — Hasura hard-rejects the query
// ("unexpected variables in variableValues") the moment that filter becomes active,
// per the same usage-count rule as rewriteQueryForVars (>=2 occurrences = used: one
// for the declaration, one for a real reference).
function findOrphanFilters(filters: FilterDef[], widgets: NewWidgetSpec[]): string[] {
  const allGraphql = widgets.map((w) => (w as any).graphql ?? "").join("\n");
  return filters
    .map((f) => f.key)
    .filter((key) => {
      const occurrences = allGraphql.match(new RegExp(`\\$${key}\\b`, "g"))?.length ?? 0;
      return occurrences < 2;
    });
}

function buildFilterWarning(filters: FilterDef[], widgets: NewWidgetSpec[]): string {
  const orphans = findOrphanFilters(filters, widgets);
  return orphans.length > 0
    ? `⚠ Filter(s) ${orphans.map((k) => `"${k}"`).join(", ")} declared but no widget's graphql references $${orphans[0]} (etc.) — they will have no effect. The filter key must match a GraphQL variable name exactly.`
    : "";
}

export function registerDashboardTools(server: McpServer): void {
  // ── get_kpi_dashboard ─────────────────────────────────────
  server.registerTool(
    {
      name: "get_kpi_dashboard",
      description: `Build a multi-widget KPI dashboard with interactive filters and a persistent share link.

WHEN TO CALL: Only when the user explicitly asks for a "dashboard". For any other request ("show X", "count Y by Z", "chart A") — use present_data instead. present_data renders inline without a share link.

BEFORE CALLING: Run query_data against every table you plan to use. Use ONLY exact column names from schema.columns — wrong field names produce blank widgets.

Read skill://kpi-dashboard for: widget recipes, oracle/fleet/telemetry GQL patterns, stat_row alias pattern, filter wiring, row_actions.

Widget requirements: id + title + graphql (REQUIRED on every widget — enables live filter re-fetch).
  - type: "auto" unless you have a strong preference; set subtitle as a hint ("trend over time", "distribution by status")
  - stat_items: stat_row only — field must be the exact GQL alias name
  - Do NOT send inline_rows — server fetches all data from graphql

MAP widget: type:"map", span:3, graphql must select lat, lon, vin, status.
ORACLE widget: wrap in oracle{}: query{oracle{metric_si_01(...){time success_rate_pct}}} result_path:"oracle.metric_si_01"
DATES: compute dynamically — new Date(Date.now()-30*86400000).toISOString() — never hardcode.
UPDATE: use update_dashboard to modify existing dashboards (preserves share URL).`,
      inputSchema: {
        title: z.string().describe("Dashboard title"),
        description: z.string().optional(),
        theme_color: z.string().optional().describe("Color theme: indigo, violet, blue, amber, rose, red"),
        widgets: z.array(widgetSpecSchema).describe("Widget specs — graphql is required on every widget. Server fetches all data from graphql; do not send inline_rows."),
        filters: z.array(filterSpecSchema).optional().describe("Interactive filter controls shown above the dashboard"),
        base_token: z.string().optional().describe("Existing dashboard token to update instead of creating new"),
      },
    },
    async ({ title, description, theme_color, widgets, filters, base_token }) => {
      const mcpUser = getMcpUser();
      return traceMcpTool("get_kpi_dashboard", mcpUser?.email ?? null, getMcpSessionId(),
        { title, widget_count: (widgets as any[]).length }, async () => {
      try {
        // Collect filters: merge top-level filters with any widget-level filters (deduplicated by key)
        const widgetFilters = (widgets as any[]).flatMap((w) => w.filters ?? []);
        const topFilters = filters ?? [];
        const seenKeys = new Set(topFilters.map((f: any) => f.key));
        const mergedFilters = [
          ...topFilters,
          ...widgetFilters.filter((f: any) => !seenKeys.has(f.key)),
        ] as FilterDef[];

        const spec: NewDashboardSpec = {
          title,
          description,
          theme_color: theme_color ?? "indigo",
          widgets: widgets as NewWidgetSpec[],
          filters: mergedFilters,
        };

        let shareToken: string | undefined;
        let shareUrl: string | undefined;
        try {
          const mcpUser = getMcpUser();
          const result = await persistSpec(spec, base_token, mcpUser);
          shareToken = result.share_token;
          shareUrl = result.share_url;
        } catch (shareErr) {
          console.error("[share] write failed:", shareErr instanceof Error ? shareErr.message : shareErr);
        }

        const noGqlWidgets = spec.widgets.filter((w) => !(w as any).graphql?.trim());
        const gqlWarning = noGqlWidgets.length > 0
          ? `⚠ ${noGqlWidgets.length} widget(s) missing graphql (${noGqlWidgets.map((w) => w.id).join(", ")}) — filters won't work and share link will be static. Add graphql to every widget.`
          : "";
        const filterWarning = buildFilterWarning(mergedFilters, spec.widgets);

        const cliText = [
          `# ${title}`,
          description ?? "",
          ``,
          shareUrl ? `Interactive dashboard: ${shareUrl}` : "",
          ``,
          `(${spec.widgets.length} widgets)`,
          gqlWarning,
          filterWarning,
        ].filter(Boolean).join("\n");

        return {
          structuredContent: { title, share_url: shareUrl, share_token: shareToken, widget_count: spec.widgets.length },
          content: [{ type: "text" as const, text: cliText }],
          isError: false,
        };
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
      }); // traceMcpTool
    },
  );

  // ── update_dashboard ──────────────────────────────────────
  server.registerTool(
    {
      name: "update_dashboard",
      description: `Modify an existing dashboard in-place. The same share URL is preserved. Only works with dashboards created by get_kpi_dashboard.

WHEN TO CALL: When user asks to "change [chart title] to [new type]", "add a widget", "remove", or "update" a chart.

HOW TO CALL:
1. base_token — the share_token returned by the most recent get_kpi_dashboard call in this conversation
2. update_widgets — list of widgets to patch by ID. Each must have:
   - id: EXACT same id string used in get_kpi_dashboard (e.g. "w-failure-pie", "w-success-trend")
   - type: new chart type ("auto" or specific type)
   - field mappings for the new type (label_field, value_field, bar_keys, etc.) — or omit for auto
   - graphql: SAME graphql string as the original widget (keeps live data working)
3. All other widgets not in update_widgets are preserved unchanged

EXAMPLE — change bar chart widget "w-failure-bar" to a pie chart:
  base_token: "<token from previous get_kpi_dashboard>",
  update_widgets: [{ id: "w-failure-bar", type: "pie_chart", label_field: "error_type", value_field: "failure_count", donut: true, graphql: "<same graphql string>" }]`,
      inputSchema: {
        base_token: z.string().describe("Token of the dashboard to update (from share_token field)."),
        add_widgets: z.array(widgetSpecSchema).optional().describe("New widgets to append"),
        update_widgets: z.array(widgetSpecSchema.partial().extend({ id: z.string() })).optional().describe("Widgets to update by id — merged with existing"),
        remove_widget_ids: z.array(z.string()).optional().describe("Widget IDs to remove"),
        update_filters: z.array(filterSpecSchema).optional().describe("Replace all filters with these (omit to keep existing)"),
        title: z.string().optional(),
        description: z.string().optional(),
        theme_color: z.string().optional(),
      },
    },
    async ({ base_token, add_widgets, update_widgets, remove_widget_ids, update_filters, title, description, theme_color }) => {
      try {
        const existing = await getSharedDashboard(base_token);
        if (!existing) return jsonErr(`Dashboard ${base_token} not found`);

        // Load spec — prefer widget_spec (new format), fall back to widget_json
        const rawSpec = existing.widget_spec?.widgets
          ? existing.widget_spec
          : existing.widget_json?.widgets
            ? existing.widget_json
            : null;

        if (!rawSpec?.widgets?.length) {
          return jsonErr(`Dashboard ${base_token} has no editable spec. Create it with get_kpi_dashboard first.`);
        }

        const spec: NewDashboardSpec = rawSpec as NewDashboardSpec;

        // Apply patches
        if (title) spec.title = title;
        if (description) spec.description = description;
        if (theme_color) spec.theme_color = theme_color;

        if (remove_widget_ids?.length) {
          const removeSet = new Set(remove_widget_ids);
          spec.widgets = spec.widgets.filter((w) => !removeSet.has(w.id));
        }

        if (update_widgets?.length) {
          const widgetMap = new Map(spec.widgets.map((w) => [w.id, w]));
          for (const patch of update_widgets) {
            if (widgetMap.has(patch.id)) {
              widgetMap.set(patch.id, { ...widgetMap.get(patch.id)!, ...patch } as NewWidgetSpec);
            }
          }
          spec.widgets = Array.from(widgetMap.values());
        }

        if (add_widgets?.length) {
          spec.widgets = [...spec.widgets, ...(add_widgets as NewWidgetSpec[])];
        }

        if (update_filters) {
          spec.filters = update_filters as FilterDef[];
        }

        const shareUrl = `${baseUrlStr()}/share/s/${base_token}`;

        try {
          await updateSharedDashboard(base_token, {
            title: spec.title,
            description: spec.description,
            widget_json: spec as any,
            widget_spec: spec as any,
            theme_color: spec.theme_color,
          });
        } catch (shareErr) {
          console.error("[share] update failed:", shareErr instanceof Error ? shareErr.message : shareErr);
        }

        const filterWarning = buildFilterWarning(spec.filters ?? [], spec.widgets);
        const cliText = [
          `Dashboard updated.`,
          ``,
          `Share link: ${shareUrl}`,
          `${spec.widgets.length} widgets`,
          filterWarning,
        ].filter(Boolean).join("\n");

        return {
          structuredContent: { title: spec.title, share_url: shareUrl, share_token: base_token, widget_count: spec.widgets.length },
          content: [{ type: "text" as const, text: cliText }],
          isError: false,
        };
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );
}
