import { z } from "zod";
import type { McpServer } from "skybridge/server";
import { jsonErr, flattenResult, flattenAggregateNode } from "./types.js";
import { execute } from "../data-layer/index.js";
import { rewriteQueryForVars } from "../data/dashboard-engine.js";
import { applyTransform } from "../data/transforms.js";
import { getMcpUser, getMcpSessionId } from "../data/mcp-context.js";
import { traceMcpTool } from "../utils/langfuse.js";




export function registerPresentDataTools(server: McpServer): void {
// ── present_data ─────────────────────────────────────────
server.registerTool(
  {
    name: "present_data",
    description: `Render structured data as a composable layout of visual blocks.

NOT for: SOP → show_sop_response | dashboards → get_kpi_dashboard | external API → query_external_api | maps → fleet_map

Read skill://present-data-layouts for full block reference, display options, and action patterns.

CHOOSE THE RIGHT LAYOUT — do NOT default to table:
  Oracle time-series (time + group + numeric metric)    → sparkline_table + metric_grid. NEVER plain table.
  Events/exceptions with a category field (e.g. exception_type, severity, status)
                                                        → stat_row + tab_table(tab_field:"<that field>")
  Rows grouped, all visible at once                     → grouped_table(group_by:"fieldName")
  Counts/averages by group: 2–4 → metric_grid | 5–20 → bar_chart | ratios → pie_chart(donut:true)
  Trend over time, single metric                        → line_chart
  Entity list ≤20 rows (vehicles, drivers, people)      → stat_row + cards or list
  Entity list many rows                                 → stat_row + table(searchable:true)
  Chronological events / history                        → timeline
  Expandable row detail                                 → accordion
  Single record                                         → detail or kv_grid
  Always lead with stat_row. Table alone is WRONG for event, exception, or metric data.

data_payload JSONB is auto-flattened — nested keys (exception_type, driver_name, etc.) work as direct field keys in layout.

TWO WORKFLOWS:
  A. graphql param — server fetches all rows. Pass graphql + result_path + layout. Do NOT pass rows.
  B. rows param — only for rows from a query_data preset. Pass rows + layout.

SCHEMA: Read oracle-catalog + oracle-graphql before oracle graphql. Read schema-pg for fleet field names.
Aggregation (fleet/pg only, NOT oracle): transform param — count_by | sum_by | avg_by | histogram | top_n.
Do NOT add arbitrary limits to raw row queries.`,
    inputSchema: {
      title: z.string().describe("Heading for the view"),
      subtitle: z.string().optional().describe("Optional context line shown under the heading"),
      graphql: z.string().optional().describe("GraphQL query to fetch rows server-side. When provided, the server fetches rows — do NOT pass rows too. Wrap oracle tables: query{oracle{metric_pd_02(...){...}}}"),
      result_path: z.string().optional().describe("Dot-path to extract rows when using graphql param. E.g. 'oracle.metric_pd_02', 'fleet_vehicles'. Required when graphql is set."),
      variables: z.record(z.string(), z.any()).optional().describe("Variables for the graphql query. Passed to rewriteQueryForVars — missing variables strip their WHERE clauses automatically."),
      rows: z.array(z.any()).optional().describe("Rows to render directly — use ONLY when rows come from a query_data preset (sop_search, openapi_catalog). Leave empty when using graphql param."),
      transform: z.enum(["count_by","avg_field","histogram","sum_by","top_n","avg_by"]).optional().describe("Server-side aggregation for fleet/pg data. NOT for oracle (oracle uses metric_xx_aggregate in graphql). count_by: group+count by transform_key. sum_by/avg_by: group+sum/avg with transform_key='groupField:valueField'. histogram: bucket numeric. top_n: keep top N by transform_key. Output always produces {label,value} rows."),
      transform_key: z.string().optional().describe("Field for transform. count_by/histogram: single field name. sum_by/avg_by: 'groupField:valueField'."),
      transform_bins: z.number().optional().describe("Histogram bin count (default 10)."),
      transform_n: z.number().optional().describe("top_n: how many rows to keep."),
      layout: z.array(z.discriminatedUnion("type", [
        z.object({
          type: z.literal("stat_row"),
          items: z.array(z.object({
            label: z.string(),
            field: z.string(),
            agg: z.enum(["count","sum","avg","max","min","first","last"]).optional(),
            unit: z.string().optional(),
            prefix: z.string().optional(),
            suffix: z.string().optional(),
            color: z.enum(["blue","green","amber","rose","violet","cyan"]).optional(),
          })),
        }),
        z.object({
          type: z.literal("cards"),
          title_field: z.string().optional().describe("Field to use as card heading"),
          subtitle_field: z.string().optional().describe("Field to use as card subheading"),
          fields: z.array(z.object({
            key: z.string(),
            label: z.string().optional(),
            display: z.enum(["text","number","badge","status_badge","fuel_bar","date","boolean","link","email","currency","percent","code","avatar","truncate"]).optional(),
            prefix: z.string().optional(),
            suffix: z.string().optional(),
          })),
          columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
          searchable: z.boolean().optional(),
          actions: z.array(z.object({
            label: z.string(),
            tool: z.string().describe("Exact MCP tool name to call (used for call_tool) or for labeling purposes (follow_up)"),
            args_template: z.record(z.string(), z.any()).describe("Args to pass — use {{fieldName}} to inject row values"),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            confirm: z.boolean().optional().describe("Show confirmation dialog before calling"),
            description: z.string().optional().describe("Text shown in confirmation dialog"),
            action_type: z.enum(["call_tool","follow_up"]).optional().describe("'call_tool' (default) calls the MCP tool directly — result data returned but no view rendered. 'follow_up' sends a chat message so the LLM handles it and renders the view. Use 'follow_up' for any action whose result should be shown as a view (location map, trip details, etc.)."),
            message: z.string().optional().describe("For action_type=follow_up: the chat message to send. Use {{fieldName}} to inject row values. Example: 'Show location for vehicle {{vin}}'"),
          })).optional(),
        }),
        z.object({
          type: z.literal("table"),
          fields: z.array(z.object({
            key: z.string(),
            label: z.string().optional(),
            display: z.enum(["text","number","badge","status_badge","date","boolean","link","email","currency","percent","code","avatar","truncate","fuel_bar"]).optional(),
            prefix: z.string().optional(),
            suffix: z.string().optional(),
          })).optional(),
          actions: z.array(z.object({
            label: z.string(),
            tool: z.string(),
            args_template: z.record(z.string(), z.any()),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            confirm: z.boolean().optional(),
            description: z.string().optional(),
            action_type: z.enum(["call_tool","follow_up"]).optional(),
            message: z.string().optional(),
          })).optional(),
          searchable: z.boolean().optional(),
          striped: z.boolean().optional(),
          collapsible: z.boolean().optional().describe("Wrap table in a collapsible panel — useful for long tables"),
          default_collapsed: z.boolean().optional().describe("Start the collapsible table in collapsed state (requires collapsible: true)"),
        }),
        z.object({
          type: z.literal("accordion"),
          title_field: z.string(),
          subtitle_field: z.string().optional(),
          badge_field: z.string().optional().describe("Field shown as status badge in the collapsed header"),
          fields: z.array(z.object({ key: z.string(), label: z.string().optional() })),
        }),
        z.object({
          type: z.literal("list"),
          title_field: z.string(),
          subtitle_field: z.string().optional(),
          badge_field: z.string().optional(),
          badge_display: z.enum(["status_badge","badge","text"]).optional(),
          meta_fields: z.array(z.object({
            key: z.string(),
            label: z.string().optional(),
            display: z.enum(["text","number","badge","status_badge","date","code","percent","currency"]).optional(),
          })).optional().describe("Extra fields shown inline under the subtitle"),
          actions: z.array(z.object({
            label: z.string(),
            tool: z.string(),
            args_template: z.record(z.string(), z.any()),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            confirm: z.boolean().optional(),
            description: z.string().optional(),
            action_type: z.enum(["call_tool","follow_up"]).optional(),
            message: z.string().optional(),
          })).optional(),
        }),
        z.object({
          type: z.literal("detail"),
          title_field: z.string().optional().describe("Field to use as the card heading"),
          fields: z.array(z.object({
            key: z.string(),
            label: z.string().optional(),
            display: z.enum(["text","number","badge","status_badge","date","boolean","link","email","currency","percent","code","avatar","truncate","fuel_bar"]).optional(),
            prefix: z.string().optional(),
            suffix: z.string().optional(),
          })).optional(),
          actions: z.array(z.object({
            label: z.string(),
            tool: z.string(),
            args_template: z.record(z.string(), z.any()),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            confirm: z.boolean().optional(),
            description: z.string().optional(),
            action_type: z.enum(["call_tool","follow_up"]).optional(),
            message: z.string().optional(),
          })).optional(),
        }),
        z.object({
          type: z.literal("gallery"),
          image_field: z.string().describe("Field containing the image URL"),
          title_field: z.string().optional(),
          subtitle_field: z.string().optional(),
          badge_field: z.string().optional(),
          actions: z.array(z.object({
            label: z.string(),
            tool: z.string(),
            args_template: z.record(z.string(), z.any()),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            action_type: z.enum(["call_tool","follow_up"]).optional(),
            message: z.string().optional(),
          })).optional(),
        }),
        z.object({
          type: z.literal("timeline"),
          time_field: z.string().describe("Field containing the ISO timestamp"),
          title_field: z.string(),
          subtitle_field: z.string().optional(),
          badge_field: z.string().optional(),
        }),
        z.object({
          type: z.literal("kv_grid"),
          pairs: z.array(z.object({
            label: z.string(),
            field: z.string(),
            display: z.enum(["text","number","badge","status_badge","date","boolean","link","email","currency","percent","code","fuel_bar"]).optional(),
          })).describe("Fixed key-value pairs to show (uses rows[0])"),
        }),
        z.object({
          type: z.literal("callout"),
          message: z.string(),
          variant: z.enum(["info","warning","success","error"]).optional(),
          icon: z.string().optional(),
        }),
        z.object({
          type: z.literal("sparkline_table"),
          group_field: z.string().describe("Field to group rows by — one row per group in the table. E.g. 'team_name', 'service_name', 'user_name'"),
          time_field: z.string().describe("Timestamp field used to order points within each group. E.g. 'time'"),
          value_field: z.string().describe("Numeric field plotted as the sparkline and shown as the latest value. E.g. 'mean_seconds_to_first_ack', 'burden_score'"),
          label: z.string().optional().describe("Column header for the value column. Defaults to value_field name."),
          unit: z.string().optional().describe("Unit suffix appended to the value. E.g. 's', 'min', '%'"),
          color: z.string().optional().describe("Sparkline color. Defaults to '#0561FC' (blue). Use '#C32D34' for error metrics, '#2DAB4E' for positive metrics."),
        }),
        z.object({
          type: z.literal("metric_grid"),
          label_field: z.string().describe("Field used as the tile label — the entity name. E.g. 'team_name', 'service_name', 'user_name'"),
          value_field: z.string().describe("Primary numeric field shown as the big number. E.g. 'total_incidents', 'burden_score', 'override_count'"),
          columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional().describe("Number of tile columns (default 3)"),
          unit: z.string().optional().describe("Unit suffix appended to the value. E.g. 'hrs', '%'"),
          color: z.enum(["blue","green","amber","rose","violet"]).optional().describe("Tile accent color (default 'blue')"),
          secondary_field: z.string().optional().describe("Optional second numeric field shown below the primary value"),
          secondary_label: z.string().optional().describe("Label for the secondary field"),
        }),
        z.object({
          type: z.literal("bar_chart"),
          label_field: z.string().describe("Field used as the category axis labels. E.g. 'oem', 'team_name', 'label' (after transform)."),
          value_field: z.string().describe("Numeric field used as bar length. E.g. 'success_rate_pct', 'total_incidents', 'value' (after transform)."),
          horizontal: z.boolean().optional().describe("True for horizontal bars (better for long category names). Default: vertical."),
          color: z.string().optional().describe("Optional single hex color override. Default: uses theme palette."),
        }),
        z.object({
          type: z.literal("line_chart"),
          x_field: z.string().describe("Field for the x-axis (usually a time/date field or category). E.g. 'time', 'date', 'oem'."),
          y_field: z.string().describe("Numeric field for the y-axis. E.g. 'success_rate_pct', 'mean_seconds_to_resolve'."),
          series_field: z.string().optional().describe("Field to group rows into multiple lines. E.g. 'oem', 'team_name'. Omit for a single line."),
        }),
        z.object({
          type: z.literal("pie_chart"),
          label_field: z.string().describe("Field used as slice labels. E.g. 'oem', 'status', 'label' (after transform)."),
          value_field: z.string().describe("Numeric field used as slice size. E.g. 'count', 'total_incidents', 'value' (after transform)."),
          donut: z.boolean().optional().describe("True to render as a donut chart."),
        }),
        z.object({
          type: z.literal("tab_table"),
          tab_field: z.string().describe("Field whose distinct values become tabs (e.g. 'exception_type', 'status', 'team_name'). An 'All' tab is always added. Each tab shows its row count."),
          fields: z.array(z.object({
            key: z.string(), label: z.string().optional(),
            display: z.enum(["text","number","badge","status_badge","date","boolean","link","email","currency","percent","code","avatar","truncate","fuel_bar"]).optional(),
            prefix: z.string().optional(), suffix: z.string().optional(),
          })).optional(),
          actions: z.array(z.object({
            label: z.string(), tool: z.string(), args_template: z.record(z.string(), z.any()),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            confirm: z.boolean().optional(), description: z.string().optional(),
            action_type: z.enum(["call_tool","follow_up"]).optional(), message: z.string().optional(),
          })).optional(),
          searchable: z.boolean().optional(),
        }),
        z.object({
          type: z.literal("grouped_table"),
          group_by: z.string().describe("Field to group rows by — rows with the same value get a shared section header (e.g. 'team_name', 'service', 'category'). Rows are sorted by this field automatically."),
          fields: z.array(z.object({
            key: z.string(), label: z.string().optional(),
            display: z.enum(["text","number","badge","status_badge","date","boolean","link","email","currency","percent","code","avatar","truncate","fuel_bar"]).optional(),
            prefix: z.string().optional(), suffix: z.string().optional(),
          })).optional(),
          actions: z.array(z.object({
            label: z.string(), tool: z.string(), args_template: z.record(z.string(), z.any()),
            variant: z.enum(["primary","secondary","destructive","tertiary"]).optional(),
            confirm: z.boolean().optional(), description: z.string().optional(),
            action_type: z.enum(["call_tool","follow_up"]).optional(), message: z.string().optional(),
          })).optional(),
          searchable: z.boolean().optional(),
        }),
      ])).describe("Ordered layout blocks to render top-to-bottom"),
    },
    view: {
      component: "data-presenter",
      description: "LLM-composed rich data view — stat_row, metric_grid, sparkline_table, bar/line/pie chart, tab_table, grouped_table, cards, list, accordion, timeline, detail, kv_grid, callout",
    },
  },
  async ({ title, subtitle, graphql, result_path, variables, rows: inputRows, layout, transform, transform_key, transform_bins, transform_n }) => {
    const mcpUser = getMcpUser();
    const layoutTypes = (layout ?? []).map((b: any) => b.type);
    return traceMcpTool("present_data", mcpUser?.email ?? null, getMcpSessionId(), { title, layoutTypes, graphql, result_path, transform }, async () => {
    try {
      let rows: any[] = inputRows ?? [];




      if (graphql) {
        const cleanVars: Record<string, any> = {};
        for (const [k, v] of Object.entries(variables ?? {})) {
          if (v !== null && v !== undefined && !(typeof v === "string" && /^\$\w+$/.test(v)) && v !== "auto") {
            cleanVars[k] = v;
          }
        }
        const rewritten = rewriteQueryForVars(graphql, cleanVars);
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
          return jsonErr(e instanceof Error ? e.message : "GraphQL fetch failed");
        }
        if (result_path) {
          const parts = result_path.split(".");
          let node: any = data;
          for (const part of parts) node = node?.[part];
          if (Array.isArray(node)) {
            rows = node;
          } else if (node && typeof node === "object") {
            // Multi-alias oracle response (e.g. result_path:"oracle" → {cost:[...], latency:[...]})
            const childArrays = Object.values(node).filter(Array.isArray) as any[][];
            if (childArrays.length >= 2) {
              rows = childArrays.flat();
            } else if ("aggregate" in (node as object)) {
              // Single aggregate object — flatten to synthetic row using last result_path segment as key
              const alias = result_path!.split(".").pop() ?? "value";
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
      }

      // Auto-flatten data_payload JSONB — applies regardless of whether rows came from
      // the graphql param or were passed directly. Spreads nested payload keys into
      // the top-level row so field keys like exception_type, driver_name work directly.
      rows = rows.map((row: any) => {
        if (row.data_payload && typeof row.data_payload === "object" && !Array.isArray(row.data_payload)) {
          const { data_payload, ...rest } = row;
          return { ...rest, ...data_payload };
        }
        return row;
      });

      if (transform) {
        rows = applyTransform(rows, { transform, transform_key, transform_bins, transform_n });
      }




      // Route full rows through _meta (view-only — never tokenized into LLM context).
      // structuredContent stays compact: title, layout spec, row count, column names.
      return {
        structuredContent: {
          title,
          subtitle,
          layout,
          row_count: rows.length,
          columns: rows[0] ? Object.keys(rows[0]) : [],
        },
        content: [{ type: "text" as const, text: `${title} — ${rows.length} row${rows.length !== 1 ? "s" : ""} rendered.` }],
        _meta: { rows },
        isError: false,
      };
    } catch (e) {
      return jsonErr(e instanceof Error ? e.message : "Unknown error");
    }
    }); // traceMcpTool
  },
);
}
