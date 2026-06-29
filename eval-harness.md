# Eval Harness

This document explains the evaluation framework for CTRL's MCP server — why it exists, what it covers, how to run it, and how to use results to improve the system.

---

## Why evals?

CTRL's LLM must make five sequential decisions correctly on every user query:

1. **Read the right skill** — load the oracle-graphql or schema-pg SKILL.md before writing GQL
2. **Write valid GraphQL** — oracle tables require `oracle{}` wrapper, correct `result_path`, `_aggregate` tables for grouped summaries, alias-batching for multi-table fetches
3. **Pick the right view tool** — `present_data` for ad-hoc, `get_kpi_dashboard` only when the user says "dashboard"
4. **Choose layout blocks that match the data shape** — pie vs. line vs. sparkline vs. stat_row
5. **Map field names correctly** — `label_field`, `value_field`, `time_field` must match actual column names in the fetched schema

A failure at any step silently produces wrong output. The most common recurring failure: the LLM fetches raw rows from `metric_si_01(limit: 500)` when the user asks "average failure rate by OEM" — returning one row per (customer, oem, day) — then averages them incorrectly. The oracle schema has `metric_si_01_aggregate` specifically for this. Without evals you only find this in production.

**What evals buy:**
- A repeatable score that tells you whether a change made the LLM better or worse
- Coverage of the oracle `_aggregate` pattern (the hardest failure mode)
- Structural checks that run without any LLM (GQL validity, field mapping, query drift) — deterministic and fast
- A way to test the full tool-call trace, not just the final text response

---

## Why PromptFoo

Options evaluated:

| | PromptFoo | Braintrust | LangSmith |
|---|---|---|---|
| License | MIT | Closed | Closed |
| Runs locally | ✓ | account required | account required |
| Custom JS assertions | ✓ | ✓ | limited |
| Repeat / determinism % | ✓ built-in | manual | manual |
| Multi-turn tool loop | via custom provider | partial | partial |
| Cost | free | SaaS pricing | SaaS pricing |

PromptFoo runs fully locally (`npx promptfoo eval`), no account, no data leaving your machine. It supports custom JavaScript assertion functions, `repeat: N` for determinism scoring, and arbitrary provider implementations — which we needed for the multi-turn tool-call loop.

---

## Architecture

```
evals/
├── promptfoo.yaml          # Main config — providers, prompts, test files
├── ctrl-provider.ts        # Custom multi-turn Anthropic provider
├── tool-stubs.ts           # Tool stub implementations (hit real Hasura)
├── assertions/
│   ├── tool-choice.js      # Was oracle{} used? Was result_path correct? Right view tool?
│   ├── field-validity.js   # GQL errors, field mapping, query/view drift
│   ├── aggregation.js      # Stub result vs. independent ground truth (no prose scraping)
│   └── visual-selection.js # Shape heuristics, _aggregate enforcement, orphan filters
└── cases/
    ├── oracle-si.yaml      # Source Integration metric cases (SI-01 through SI-12)
    ├── oracle-pd.yaml      # PagerDuty metric cases (PD-01, PD-02, PD-07)
    ├── oracle-multi.yaml   # 5-7 oracle aliases batched in one query_data call
    ├── oracle-dashboard.yaml  # get_kpi_dashboard with filters + blank-widget detection
    ├── fleet.yaml          # Fleet Postgres tables (vehicles, trips, telemetry, drivers)
    ├── view-selection.yaml # Tool selection: present_data vs. get_kpi_dashboard vs. others
    └── edge-cases.yaml     # Known failure modes: empty tables, wrong prefixes, raw-row aggregation
```

### Why a custom provider?

PromptFoo's built-in `anthropic:` provider does NOT support multi-turn `functionToolCallbacks`. The LLM must call `read_skill → query_data → present_data` in sequence — three separate API calls. The built-in provider processes only one round and returns the joined tool results as its output, never completing the full conversation.

`evals/ctrl-provider.ts` wraps the Anthropic SDK directly:

```
User prompt
  → Anthropic API (with 4 tools declared)
  → tool_use: read_skill       → stub returns actual SKILL.md content
  → tool_use: query_data       → stub hits real Hasura, returns schema + _raw
  → tool_use: present_data     → stub fetches real rows, returns columns + _rows
  → stop_reason: end_turn      → returns final text to promptfoo
```

Every tool call and result is recorded in `metadata.toolCalls`. All four JS assertions read this to inspect the complete trace without touching the prose output.

### Why stubs hit real Hasura

The stubs in `tool-stubs.ts` call the actual local Hasura endpoint with the LLM's own GQL strings. This means:
- GQL errors are real Hasura errors (wrong field names, missing `oracle{}`, bad types)
- Column schemas returned to assertions are real schemas from real rows
- Aggregation correctness checks compare against actual seeded data
- No hardcoded schemas that silently diverge from production

---

## What each assertion checks

### `tool-choice.js`
Structural check — no LLM required, always deterministic.

- Did `query_data` get called before the view tool? If not → fail.
- For every query touching an oracle metric table: does the GQL include `oracle {}`? Does `result_path` start with `"oracle."`?
- Does the view tool called match `vars.expected_tool`? (e.g., if `expected_tool: get_kpi_dashboard` but the LLM called `present_data` → fail)

### `field-validity.js`
Structural check — no LLM required, always deterministic.

Four layers:
1. **GQL errors** — `query_data` stub returned `{error: "..."}` → the LLM's GQL was invalid
2. **View GQL errors** — `present_data`/`get_kpi_dashboard` widget GQL failed when the stub ran it
3. **Field mapping** — every `label_field`, `value_field`, `time_field`, etc. specified in the layout must exist in the actual fetched column list; mismatches are hallucinated field names
4. **Drift** — tables referenced in `query_data` GQL must also appear in `present_data` GQL; if they differ, the view is showing data from a different table than the one described to the user

### `aggregation.js`
Compares stub result vs. independently computed ground truth. Never reads the LLM's prose output.

Reads aggregate values from `_raw.oracle.<alias>.aggregate.{method}.{field}` (for `_aggregate` queries) or from `_rows` (for transform-based grouping). Independently fetches raw rows and computes the same aggregation. Fails if the two diverge by more than `threshold_pct` (default 5%).

If the stub returns no aggregate values at all, it means the LLM fetched raw rows instead of using `_aggregate` — this is caught here (and also by `visual-selection.js`).

Skips gracefully when the table has no seeded data (returns `pass: true, reason: "no seeded data — skip"`).

### `visual-selection.js`
Structural check — no LLM required.

- **`_aggregate` enforcement** — if `requires_aggregate: true` in the test vars and no `_aggregate` or `aggregate {` appears in any query GQL → fail. This is the primary check for the "double-counting raw rows" failure mode.
- **Shape heuristics** — `pie_chart` for `time_series` data → fail; `line_chart` for `single_record` data → fail; `bar_chart` for time-series without a series_field → fail
- **Blank plot detection** — if the stub returned `columns: []` with no GQL errors, the chart will render blank; this catches queries that return zero columns
- **Orphan filter detection** (dashboard cases) — replicates `findOrphanFilters` from `dashboard-tools.ts`; a filter variable `$key` must appear at least twice in some widget's GQL (once in the query variables, once in a WHERE clause); filters declared but never used in WHERE have no effect

### `llm-rubric` (inline in each case)
Uses a second LLM call to score the final text output. Examples:
- "Every percentage in the response must trace back to the query_data result. Score FAIL if any number was invented."
- "Must show BOTH success rate (SI-01) and failure rate (SI-06). Score FAIL if only one is shown."
- "If the table returns 0 rows, the LLM must acknowledge there is no data. Score FAIL if it fabricates numbers."

These catch things structural checks can't: completeness, tone for empty results, whether the correct entities appear in the response.

---

## Test cases (44 total)

| File | Cases | What it tests |
|---|---|---|
| `oracle-si.yaml` | 8 | Enrollment metrics: time-series, aggregate per OEM/customer, batched aliases |
| `oracle-pd.yaml` | 6 | PagerDuty: MTTA/MTTR, customer filter wiring, aggregate correctness |
| `oracle-multi.yaml` | 5 | 5–7 oracle aliases in one `query_data` call; multi-block present_data layouts |
| `oracle-dashboard.yaml` | 4 | `get_kpi_dashboard` with filters; orphan filter detection; blank widget prevention |
| `fleet.yaml` | 10 | Fleet Postgres: aggregate stats, status distributions, histograms, telemetry, multi-source batching |
| `view-selection.yaml` | 8 | Correct tool selection across prompt types; single vs. multi-block layouts |
| `edge-cases.yaml` | 4 | Known failure modes: APP-* data gap, missing `oracle.` prefix, raw-row aggregation, empty table |

Each case runs with `repeat: 5` by default. A test must pass all 5 runs to count as "passing" — this surfaces non-determinism (a case that passes 3/5 times has a real reliability problem).

**Oracle cases require `ORACLE_HASURA_GRAPHQL_ENDPOINT`** to be set. They pass gracefully when oracle data is empty (aggregation.js returns "no seeded data — skip"). Fleet cases always run.

---

## Running the eval

```bash
# Full suite (oracle + fleet + view-selection + edge-cases)
npm run eval

# Fleet only (always works without oracle configured)
npm run eval -- --filter-pattern "Fleet|Vehicle|fuel|tire|trip|driver"

# Single quick sanity check
npx promptfoo eval --config evals/promptfoo-single.yaml --no-cache

# Watch mode — re-runs on file change (useful during development)
npm run eval:watch
```

**Required env vars:**
```
ANTHROPIC_API_KEY=          # for the LLM calls
HASURA_ENDPOINT=            # for the stubs (default: http://localhost:8080/v1/graphql)
HASURA_ADMIN_SECRET=        # for the stubs (default: hasura-dev-secret)
ORACLE_HASURA_GRAPHQL_ENDPOINT=   # optional; enables oracle cases
```

**View results in browser:**
```bash
npx promptfoo view   # opens http://localhost:15500
```

---

## Debugging failing cases

### Step 1 — isolate the failing case

Run a single case (no repeat) to get fast feedback:

```bash
# in promptfoo-single.yaml, set vars.prompt to the failing case's prompt
npx promptfoo eval --config evals/promptfoo-single.yaml --no-cache
npx promptfoo view
```

In the browser UI: click the failing row → see the output text and per-assertion failure reasons. The `reason` string from each JS assertion is what you're looking for — e.g.:

```
field-validity: present_data layout[stat_row].value_field="avg_success_rate"
  not in fetched columns (success_rate_pct, time, customer_id)
```

This tells you the LLM hallucinated the field name `avg_success_rate` — the actual column is `success_rate_pct`.

### Step 2 — see the full tool call trace

Add `debug-trace.js` to any failing case to see exactly what the LLM called:

```yaml
assert:
  - type: javascript
    value: file://assertions/debug-trace.js   # always passes, dumps full trace
  - type: javascript
    value: file://assertions/tool-choice.js
  - type: javascript
    value: file://assertions/field-validity.js
```

The debug trace appears as the assertion's reason in `promptfoo view`:

```
─── Round 1: read_skill ───
  skill: oracle-graphql
  returned: # Oracle GraphQL Reference...

─── Round 2: query_data ───
  query[si01]:
    result_path: oracle.metric_si_01
    graphql: query { oracle { metric_si_01(limit: 90) { time oem success_rate_pct } } }
    ✓ rows: 45, columns: time, oem, success_rate_pct

─── Round 3: present_data ───
  graphql: query { oracle { metric_si_01(limit: 90) { time oem success_rate_pct } } }
  ✓ columns: time, oem, success_rate_pct
  layout[sparkline_table]: time_field=time, group_field=oem, value_field=avg_success_rate

─── Final output (first 300 chars) ───
Here is the enrollment success rate by OEM...
```

This immediately shows the problem: the layout references `avg_success_rate` but the fetched column is `success_rate_pct`.

### Step 3 — check the error logs

```bash
cat ~/.promptfoo/logs/promptfoo-error-*.log | tail -50
```

For Hasura GQL errors (wrong field name, missing oracle{} wrapper), the error message from Hasura is in the stub's return value and gets surfaced in `field-validity`'s reason string.

### Non-determinism debugging

If a case sometimes passes and sometimes fails, run it 10 times:

```bash
# In promptfoo-single.yaml, set options.repeat: 10
npx promptfoo eval --config evals/promptfoo-single.yaml --no-cache
```

A 6/10 pass rate means the prompt is borderline — the LLM gets it right most of the time but not reliably. Fix: strengthen the relevant SKILL.md or system prompt constraint, then rerun to confirm the rate improves.

---

## Interpreting results

| Assertion | What failure means | What to fix |
|---|---|---|
| `tool-choice` | LLM skipped `query_data`, or used wrong view tool, or omitted `oracle{}` | Check the tool description in `ctrl-provider.ts` and the system prompt; strengthen the "REQUIRED before any view tool" constraint |
| `field-validity` (layer 1–2) | Invalid GQL — bad field name, wrong table, wrong namespace | Update the relevant SKILL.md to clarify valid fields; check if Hasura schema changed |
| `field-validity` (layer 3) | Layout references field that doesn't exist in fetched data | LLM is hallucinating field names; add explicit field lists to SKILL.md |
| `field-validity` (layer 4, drift) | `query_data` and `present_data` reference different tables | LLM switched tables between the two calls; reinforce in system prompt that the same GQL must be used in both |
| `aggregation` | Values off by >5% from ground truth | LLM computed aggregation client-side instead of using `_aggregate` — it's double-counting. Enforce `_aggregate` usage via `visual-selection` and SKILL.md |
| `visual-selection` (aggregate) | `requires_aggregate=true` but raw-row query detected | Strongest signal: LLM is fetching raw rows and averaging them. This is the canonical failure mode. Add explicit examples to oracle SKILL.md showing `_aggregate` syntax |
| `visual-selection` (shape) | Wrong chart type for data shape | Update `get_kpi_dashboard` or `present_data` tool description to specify chart type rules |
| `visual-selection` (blank) | Query returned no columns | The GQL is structurally valid but returns nothing — likely a wrong `result_path` or WHERE clause that filters out all rows |
| `visual-selection` (orphan filter) | Dashboard filter declared but unused in widget GQL | Reinforce in `get_kpi_dashboard` tool description: every filter key must appear in at least one widget's WHERE clause |
| `llm-rubric` | Output incomplete, empty-table response fabricated, wrong entities named | These are harder to fix systematically; update skill files, add specific few-shot examples, or add the missing check to the system prompt |

### Score targets

| Assertion category | Target baseline | Notes |
|---|---|---|
| `field_validity` | > 90% | GQL validity is binary; failures are almost always wrong field names or missing oracle{} |
| `tool_choice` | > 85% | Main failure mode is skipping `query_data` or using wrong view tool |
| `visual_selection` (aggregate enforcement) | > 80% | Hardest to fix without explicit SKILL.md examples |
| `aggregation_correctness` | > 85% | Only runs when oracle data is seeded; fast check |
| `groundedness` (llm-rubric) | > 80% | Noisier by nature; LLM-as-judge has inherent variance |

**Current fleet baseline (2026-06-28):** 44% pass (4/9 cases). Oracle baseline: pending oracle endpoint configuration.

---

## How to improve scores

**The fastest wins:**

1. **Add `_aggregate` examples to oracle SKILL.md** — the most common failure mode is fetching raw rows for grouped summaries. Adding a worked example directly to the skill file is the highest-leverage fix.

2. **Strengthen the system prompt in `ctrl-provider.ts`** — the `SYSTEM_PROMPT` constant in the provider is what the LLM sees. Add explicit negative examples ("Do NOT fetch raw rows and average them yourself — use `_aggregate`").

3. **Check field names in skill files** — when `field-validity` layer 3 fails (hallucinated field names), it usually means the SKILL.md doesn't list the actual column names. Add the exact field names from the Hasura schema reference.

4. **Add a case for the specific failure** — when you see a new failure pattern in production, add a case to the appropriate `.yaml` file. A case with `repeat: 5` gives you a determinism score for that exact behavior.

**To add a new test case:**

```yaml
# in evals/cases/fleet.yaml (or the relevant file)
- description: "Brief description of what's being tested"
  vars:
    prompt: "The exact user prompt"
    expected_tool: present_data          # or get_kpi_dashboard
    data_shape: time_series              # categorical | single_record | mixed | time_series
    requires_aggregate: false            # true if query MUST use _aggregate
    aggregation: false                   # or: { groupField, valueField, method, expected_table, threshold_pct }
  options:
    repeat: 5
  assert:
    - type: javascript
      value: file://assertions/tool-choice.js
    - type: javascript
      value: file://assertions/field-validity.js
    - type: javascript
      value: file://assertions/visual-selection.js
    - type: llm-rubric
      value: |
        Specific rubric for what the output should contain.
        Score FAIL if ...
```

**To add aggregation correctness checking:**

Set `aggregation` to an object:
```yaml
aggregation:
  groupField: oem              # column to group by
  valueField: failure_rate_pct # column to aggregate
  method: avg                  # avg | sum
  expected_table: metric_si_06 # oracle table (without oracle. prefix)
  threshold_pct: 5             # max allowed % error vs. ground truth
```

Then add `file://assertions/aggregation.js` to the assert list. The stub automatically fetches ground truth from Hasura and compares — no manual data needed.

---

## What PromptFoo doesn't do — and what to add

PromptFoo is the right tool for CI regression testing. It is not the right tool for production observability or deep semantic quality scoring. These are separate concerns:

### LangFuse — production tracing

PromptFoo tests **synthetic prompts you wrote**. LangFuse captures **real user sessions**.

Instrument the server with the LangFuse SDK (a few lines in `src/server.ts`) and every production tool call becomes a trace: the full prompt, every tool invocation with arguments and results, token counts, latency. When something breaks in production, you open the LangFuse UI and click through the trace instead of guessing.

LangFuse also lets you run evals on captured production traces — "of the 500 real sessions last week, how many had a valid `oracle{}` wrapper?" This is more valuable than synthetic tests once you have real traffic.

PromptFoo + LangFuse together: PromptFoo prevents regressions from shipping, LangFuse tells you what's actually failing in production.

### DeepEval — better semantic metrics

Our `llm-rubric` assertions use a free-form prompt to judge output quality. DeepEval provides structured metrics that score more consistently:

- `ToolCorrectnessMetric` — checks if the right tools were called with the right arguments in the right order; more precise than `tool-choice.js`
- `HallucinationMetric` — checks if the response contradicts the tool results (semantically, not just by field name)
- `FaithfulnessMetric` — checks that every factual claim in the output traces to tool data

The tradeoff: DeepEval is Python-only and doesn't have PromptFoo's `repeat: N` determinism scoring or its clean CI integration. Worth adding as a second layer once the structural assertions are consistently passing.

### Recommended layering

```
Production (LangFuse)
  ↓ real failing traces become new test cases
CI Regression (PromptFoo — this harness)
  ↓ add deeper semantic checks
Quality scoring (DeepEval or LangFuse evals)
```

---

## Path gotchas

All `file://` references in PromptFoo resolve relative to the **root config file's directory** (`evals/`), regardless of where the reference appears. This means:

```yaml
# In evals/promptfoo.yaml:
tests:
  - file://cases/fleet.yaml           # resolves to evals/cases/fleet.yaml ✓
  - file://evals/cases/fleet.yaml     # resolves to evals/evals/cases/fleet.yaml ✗

# In evals/cases/fleet.yaml:
assert:
  - value: file://assertions/tool-choice.js    # resolves to evals/assertions/tool-choice.js ✓
  - value: file://evals/assertions/tool-choice.js  # resolves to evals/evals/assertions/tool-choice.js ✗
```

Never prefix paths with `evals/` — all paths already start from that directory.

The `prompt` for each test case must be inside `vars`:
```yaml
vars:
  prompt: "The user's question"   # ✓ — rendered into {{prompt}} template
  expected_tool: present_data
```
Not at the test-case top level (promptfoo's `{{prompt}}` template reads from `vars.prompt`, not the top-level `prompt:` field).


 Part 1 — Langfuse tracing (all tools now covered):
  - sop-tools.ts — wrapped show_sop_response handler
  - external-api-tools.ts — wrapped query_external_api handler
  - fleet-tools.ts — added imports + wrapped fleet_map handler
  - .env — added blank LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY vars with comment

  Part 2 — PromptFoo real-MCP eval:
  - evals/ctrl-provider.ts — full rewrite: connects to http://localhost:3000/mcp via StreamableHTTPClientTransport, calls listTools() dynamically, executes tools
  via client.callTool(), SYSTEM_PROMPT stripped to 2 sentences
  - evals/assertions/field-validity.js — updated for real server format: structuredContent.results[id] for query errors, structuredContent.columns for present_data
  columns, args.layout for field mappings instead of stub's result.field_mappings
  - evals/assertions/stat-value-accuracy.js — _rows → _meta.rows
  - evals/tool-stubs.ts — deleted

  Next steps for you:
  1. Go to cloud.langfuse.com → create account → Settings → API Keys → paste LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY into .env
  2. npm run dev in one terminal, then ask Claude.ai a fleet question — check Langfuse Sessions tab for the grouped read_skill → query_data → present_data trace
  3. npm run eval:quick with dev running — fleet cases should no longer fail on schema drift
