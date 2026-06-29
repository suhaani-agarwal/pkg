---
name: present-data-layouts
description: Layout block reference for present_data — block types, field display options, button variants, action types, and natural-language-to-block mapping. Read before constructing a layout array.
metadata:
  type: reference
---

# present_data Layout Reference

Read this before building a `layout[]` array for `present_data`. All blocks stack top-to-bottom.

---

## Transform → Output Column Names

**IMPORTANT:** When you use `transform` on `present_data`, the raw GQL columns are replaced by these canonical output columns. Use these names in `label_field`/`value_field`:

| transform | transform_key | Output columns | Use in layout |
|---|---|---|---|
| `"count_by"` | categorical field | `"label"`, `"value"` | `bar_chart label_field:"label" value_field:"value"` or `pie_chart` |
| `"sum_by"` | `"groupField:sumField"` | `"label"`, `"value"` | `bar_chart label_field:"label" value_field:"value"` |
| `"avg_by"` | `"groupField:avgField"` | `"label"`, `"value"` | `bar_chart label_field:"label" value_field:"value"` |
| `"avg_field"` | numeric field | `"value"` | `stat_row` or `number_card` |
| `"histogram"` | numeric field | `"label"`, `"value"` | `bar_chart label_field:"label" value_field:"value"` |
| `"top_n"` | numeric field | same as input | filter only |

**Pattern: category distribution** (e.g., vehicles by status, incidents by team):
```
present_data(graphql: "query { vehicles { status } }", transform: "count_by", transform_key: "status",
  layout: [{ type: "bar_chart", label_field: "label", value_field: "value" }])
```

---

## Decision Guide — What to Build

**Do not default to `table`. Pick by data shape:**

| Data shape | Best blocks |
|---|---|
| Metrics with a grouping key (team, service, oem) — no time dimension | `stat_row` + `metric_grid` OR `bar_chart` |
| Metrics grouped by entity over time | `stat_row` + `sparkline_table` |
| Trend for a single metric over time | `line_chart` |
| Proportional breakdown (2–5 categories) | `pie_chart` (donut) |
| Events/alerts that have a category field | `stat_row` + `tab_table` (tabs = category values) |
| Events/alerts grouped visually but all visible | `grouped_table` |
| Entity list (vehicles, drivers) — 5–20 rows | `stat_row` + `list` OR `cards` |
| Entity list — many rows / needs filtering | `stat_row` + `table, searchable: true` |
| Single record detail | `detail` OR `kv_grid` |
| Chronological event history | `timeline` |

**Oracle data rule:** oracle metrics almost always have a `time` field and a group field (team_name, service_name, oem, user_name). NEVER show these as a plain table — use `sparkline_table` for trend-per-entity, `metric_grid` for current-state tiles, `line_chart` when showing a single metric over time.

**Event/exception data rule (telemetry_events, alerts, incidents):** when rows have a category field (exception_type, severity, status) — always use `tab_table` with that field as `tab_field`. Add a `follow_up` action button per row so the user can drill into any event.

---

## Layout Block Types

### stat_row
KPI summary tiles. Always lead with this when showing any summary or entity list.
Required: `items[]` each with `label` + `field`. Optional per item: `agg`, `unit`, `prefix`, `suffix`, `color`.
```
{ type: "stat_row", items: [
    { label: "Total", field: "vin", agg: "count", color: "blue" },
    { label: "Avg Fuel", field: "fuel_level_pct", agg: "avg", unit: "%", color: "amber" },
    { label: "Critical", field: "severity", agg: "count", color: "rose" }
]}
```
Colors: `blue` | `green` | `amber` | `rose` | `violet` | `cyan`
Aggregations: `count` | `sum` | `avg` | `max` | `min` | `first` | `last`

### tab_table
**Use for events/exceptions/alerts that have a category field.** Renders tabs at the top — one per unique value of `tab_field` plus an "All" tab. Each tab shows its row count. Clicking a tab filters the table to that category.
Required: `tab_field`. Optional: `fields[]`, `actions[]`, `searchable`.
```
{ type: "tab_table", tab_field: "exception_type", searchable: true,
  fields: [
    { key: "vin", display: "code" },
    { key: "timestamp", display: "date" },
    { key: "amount_paid", label: "Amount", display: "currency" },
    { key: "action", display: "status_badge" }
  ],
  actions: [{
    label: "Investigate",
    tool: "present_data",
    action_type: "follow_up",
    message: "Investigate this {{exception_type}} for vehicle {{vin}} on {{timestamp}} — amount ${{amount_paid}}",
    args_template: {},
    variant: "secondary"
  }]
}
```

### grouped_table
All rows visible at once, visually separated by section headers. Use when rows belong to clear groups and you want to see them all simultaneously (not just one group at a time).
Required: `group_by`. Optional: `fields[]`, `actions[]`, `searchable`.
```
{ type: "grouped_table", group_by: "team_name", searchable: true,
  fields: [
    { key: "incident_id", display: "code" },
    { key: "title" },
    { key: "severity", display: "status_badge" },
    { key: "created_at", display: "date" }
  ],
  actions: [{
    label: "Details",
    tool: "present_data",
    action_type: "follow_up",
    message: "Show details for incident {{incident_id}} assigned to {{team_name}}",
    args_template: {},
    variant: "secondary"
  }]
}
```

### sparkline_table
**Best oracle data block.** One row per entity (team/service/user): sparkline trend + latest value. Required: `group_field`, `time_field`, `value_field`. Optional: `label`, `unit`, `color`.
```
{ type: "sparkline_table", group_field: "team_name", time_field: "time",
  value_field: "mean_seconds_to_first_ack", label: "MTTA", unit: "s", color: "#C32D34" }
```
Color guide: `#0561FC` (blue, default) | `#C32D34` (red, error/latency) | `#2DAB4E` (green, positive/uptime)

### metric_grid
Colorful tiles — best for 2–6 aggregated groups where the current value matters more than trend. Required: `label_field`, `value_field`. Optional: `columns` (2/3/4), `unit`, `color`, `secondary_field`, `secondary_label`.
```
{ type: "metric_grid", label_field: "oem", value_field: "total_incidents",
  columns: 3, color: "rose", unit: "incidents" }
```

### bar_chart
Category vs numeric — 5–20 groups. View auto-switches to horizontal bars when labels > 8 or label text is long. Required: `label_field`, `value_field`. Optional: `horizontal`, `color`.
```
{ type: "bar_chart", label_field: "team_name", value_field: "override_count" }
```

### line_chart
Single metric over time, or multi-line grouped series. Required: `x_field`, `y_field`. Optional: `series_field` for multi-line grouping.
```
{ type: "line_chart", x_field: "time", y_field: "success_rate_pct", series_field: "oem" }
```

### pie_chart
Proportional breakdown, 2–8 categories. Labels hidden for >4 slices (legend handles it). Required: `label_field`, `value_field`. Optional: `donut`.
```
{ type: "pie_chart", label_field: "exception_type", value_field: "count", donut: true }
```

### table
Sortable, searchable table that paginates at 15 rows. Use for entity lists with many columns or when rows don't have a natural grouping field. Prefer `tab_table` or `grouped_table` when rows have a category field.
Optional: `fields[]`, `searchable`, `striped`, `collapsible`, `default_collapsed`, `actions[]`.
```
{ type: "table", searchable: true, fields: [
    { key: "plate", display: "badge" },
    { key: "status", display: "status_badge" },
    { key: "fuel_level_pct", label: "Fuel", display: "fuel_bar" }
]}
```

### cards
Card grid — each row gets its own card. Good for entities with rich per-item context (5–15 rows). Required: `fields[]`. Optional: `title_field`, `subtitle_field`, `columns` (2/3/4), `searchable`, `actions[]`.

### list
Compact roster — avatar + title + subtitle + optional badge. Good for people, assets, services. Required: `title_field`. Optional: `subtitle_field`, `badge_field`, `badge_display`, `meta_fields[]`, `actions[]`.

### accordion
Expandable rows — good for policy steps, hierarchical data, or "click to see details" patterns. Required: `title_field`, `fields[]`. Optional: `subtitle_field`, `badge_field`.

### detail
Single-record detail card (uses rows[0]). Optional: `title_field`, `fields[]`, `actions[]`.

### kv_grid
Fixed key-value pairs from rows[0]. Required: `pairs[]` each with `label` + `field`. Optional `display` per pair.
```
{ type: "kv_grid", pairs: [
    { label: "VIN", field: "vin", display: "code" },
    { label: "Status", field: "status", display: "status_badge" }
]}
```

### timeline
Chronological event history — sorted by time. Required: `time_field`, `title_field`. Optional: `subtitle_field`, `badge_field`.

### callout
Highlighted note, warning, or tip. Required: `message`. Optional: `variant` (`info` | `warning` | `success` | `error`).

---

## Oracle Data Patterns

Oracle metrics have a `time` + group field + numeric metric. Never return them as a plain table.

**Incident counts by team (metric_si_01)**
```
graphql: "query{oracle{metric_si_01(order_by:{time:desc},limit:120){time team_name total_incidents}}}"
result_path: "oracle.metric_si_01"
layout: [
  { type: "stat_row", items: [
      { label: "Total Incidents", field: "total_incidents", agg: "sum", color: "rose" }
  ]},
  { type: "sparkline_table", group_field: "team_name", time_field: "time",
    value_field: "total_incidents", label: "Incidents", color: "#C32D34" }
]
```

**MTTA by team (metric_pd_02)**
```
layout: [
  { type: "sparkline_table", group_field: "team_name", time_field: "time",
    value_field: "mean_seconds_to_first_ack", label: "MTTA", unit: "s" },
  { type: "metric_grid", label_field: "team_name", value_field: "mean_seconds_to_first_ack",
    columns: 3, unit: "s", color: "violet" }
]
```

**Override/burden counts (metric_pd_01, metric_ana_01)**
```
layout: [
  { type: "bar_chart", label_field: "user_name", value_field: "total_overrides" }
]
```

---

## Natural Language → Layout Type

| User says… | Use |
|---|---|
| "show as cards" | `cards` |
| "show in a table" | `table, searchable: true` |
| "collapsible table" | `table, collapsible: true, default_collapsed: true` |
| "grouped by X" / "sections by X" | `grouped_table, group_by: "X"` |
| "tabs by X" / "filter by X type" | `tab_table, tab_field: "X"` |
| "summary / KPIs / key numbers" | `stat_row` |
| "expandable rows / click to expand" | `accordion` |
| "list / roster" | `list` |
| "details for one item" | `detail` or `kv_grid` |
| "timeline / history / events" | `timeline` |
| "images / photo gallery" | `gallery` |
| "key-value / overview card" | `kv_grid` |
| "note / warning / tip" | `callout` |
| "trend per team/service/entity" | `sparkline_table` |
| "tiles / metric grid" | `metric_grid` |
| "bar chart / count by category" | `bar_chart` |
| "line chart / trend over time" | `line_chart` |
| "pie / donut / breakdown" | `pie_chart, donut: true` |
| "exceptions / alerts with types" | `stat_row` + `tab_table` |
| "incidents grouped by team" | `grouped_table, group_by: "team_name"` |

---

## Field Display Options

Set `display` on any `fields[]` or `pairs[]` entry:

| value | renders as |
|---|---|
| `text` | plain string (default) |
| `number` | formatted integer with commas |
| `currency` | $1,234.50 format |
| `percent` | 42.3% format |
| `badge` | pill chip (categories, types, tags — neutral gray) |
| `status_badge` | color-coded: active/ok→green, pending/idle→amber, error/critical→red, offline→gray |
| `fuel_bar` | colored progress bar (fuel_level_pct, battery_pct) |
| `date` | formatted date |
| `boolean` | Yes / No |
| `code` | monospace + copy button (IDs, VINs, hashes) |
| `link` | clickable URL |
| `email` | mailto link |
| `avatar` | circular avatar with initials derived from the value |
| `truncate` | truncated text with full value on hover |

---

## Action Buttons

Add `actions[]` to `table`, `tab_table`, `grouped_table`, `cards`, `list`, `detail`, or `gallery` blocks.

### action_type
- `"follow_up"` — sends a chat message so the LLM handles it and renders the result. Use for anything that should show a view (map, chart, detail, investigation).
- `"call_tool"` — calls the MCP tool directly. Use only for mutations (updating status, acknowledging alerts).

### Button Variants
`"primary"` (filled blue, main CTA) | `"secondary"` (bordered gray) | `"tertiary"` (ghost/text) | `"destructive"` (red, irreversible)

Add `confirm: true` on destructive actions.

### Template Syntax
Use `{{fieldName}}` in `args_template` and `message` to inject the clicked row's values:
```
actions: [{
    label: "Investigate",
    tool: "present_data",
    action_type: "follow_up",
    message: "Show details and history for {{exception_type}} exception on vehicle {{vin}} (amount: ${{amount_paid}}, timestamp: {{timestamp}})",
    args_template: {},
    variant: "secondary"
}]
```

### Common Action Patterns
```
"investigate exception/event" → action_type:"follow_up", message:"Investigate {{event_type}} for {{vin}} on {{timestamp}}"
"view on map"                 → action_type:"follow_up", tool:"fleet_map", message:"Show location for vehicle {{vin}}"
"recovery prediction"         → action_type:"follow_up", tool:"fleet_map", message:"Show Motorq recovery prediction for {{vin}}"
"vehicle trip history"        → action_type:"follow_up", message:"Show trip history for vehicle {{vin}}"
"update alert status"         → action_type:"call_tool", tool:"update_alert_status", confirm:true
```
