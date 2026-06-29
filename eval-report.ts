#!/usr/bin/env tsx
/**
 * Reads a PromptFoo JSON results file and computes per-case pass@k and
 * per-assertion failure breakdown. Outputs a markdown-style table.
 *
 * Usage:
 *   npx tsx scripts/eval-report.ts evals/results.json
 *   npx tsx scripts/eval-report.ts evals/results.json --min-consistency 0.7
 */

import { readFileSync } from "fs";

const resultFile = process.argv[2];
if (!resultFile) {
  console.error("Usage: npx tsx scripts/eval-report.ts <results.json>");
  process.exit(1);
}

const minConsistency = parseFloat(
  process.argv.find((a) => a.startsWith("--min-consistency="))?.split("=")[1] ?? "0"
);

const raw = JSON.parse(readFileSync(resultFile, "utf-8"));

// PromptFoo result structure: { results: { results: TestResult[] } }
const allResults: any[] = raw?.results?.results ?? raw?.results ?? [];

if (!allResults.length) {
  console.error("No results found in", resultFile);
  process.exit(1);
}

// Group results by description (test case)
const byCase = new Map<string, { pass: boolean; assertionResults: any[] }[]>();
for (const r of allResults) {
  const desc = r.description ?? r.vars?.description ?? "unknown";
  if (!byCase.has(desc)) byCase.set(desc, []);
  byCase.get(desc)!.push({
    pass: r.success === true,
    assertionResults: r.gradingResult?.componentResults ?? r.assertionResults ?? [],
  });
}

// Assertion failure tracker
const assertionFailures = new Map<string, number>();

// Build rows
type Row = {
  desc: string;
  runs: number;
  passes: number;
  passAt3: number;
  passAt5: number;
  consistency: number;
  highVariance: boolean;
};
const rows: Row[] = [];

for (const [desc, results] of byCase) {
  const n = results.length;
  const passes = results.filter((r) => r.pass).length;
  const consistency = passes / n;

  // pass@k = P(at least 1 pass in k runs) ≈ 1 - (1-p)^k
  // Using empirical fraction p = passes/n
  const p = consistency;
  const passAt3 = n >= 3 ? 1 - Math.pow(1 - p, 3) : p;
  const passAt5 = n >= 5 ? 1 - Math.pow(1 - p, 5) : p;
  const highVariance = p > 0 && p < 1;

  // Count assertion failures by name
  for (const r of results) {
    for (const a of r.assertionResults) {
      if (!a.pass) {
        const name = extractAssertionName(a);
        assertionFailures.set(name, (assertionFailures.get(name) ?? 0) + 1);
      }
    }
  }

  rows.push({ desc, runs: n, passes, passAt3, passAt5, consistency, highVariance });
}

// Sort: failures first, then high variance, then passing
rows.sort((a, b) => {
  if (a.consistency !== b.consistency) return a.consistency - b.consistency;
  if (a.highVariance !== b.highVariance) return a.highVariance ? -1 : 1;
  return a.desc.localeCompare(b.desc);
});

// Print table
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const maxDescLen = Math.min(60, Math.max(...rows.map((r) => r.desc.length)));

console.log("\n## Eval Report\n");
console.log(
  "Case".padEnd(maxDescLen),
  "runs",
  "pass@3".padStart(7),
  "pass@5".padStart(7),
  "cons%".padStart(6),
  "note"
);
console.log("─".repeat(maxDescLen + 32));

let failingCases = 0;
let highVarianceCases = 0;

for (const r of rows) {
  const note = r.consistency === 0
    ? "FAILING ✗"
    : r.consistency === 1
    ? "stable ✓"
    : r.highVariance
    ? "HIGH VARIANCE ⚠️"
    : "ok";

  if (r.consistency === 0) failingCases++;
  if (r.highVariance) highVarianceCases++;

  const flag = r.consistency < minConsistency && minConsistency > 0 ? " ← BELOW THRESHOLD" : "";
  console.log(
    r.desc.slice(0, maxDescLen).padEnd(maxDescLen),
    String(r.runs).padStart(4),
    pct(r.passAt3).padStart(7),
    pct(r.passAt5).padStart(7),
    pct(r.consistency).padStart(6),
    note + flag
  );
}

// Summary stats
const totalCases = rows.length;
const totalRuns = rows.reduce((s, r) => s + r.runs, 0);
const totalPasses = rows.reduce((s, r) => s + r.passes, 0);
const overallConsistency = totalPasses / totalRuns;

console.log("\n## Summary\n");
console.log(`Cases:        ${totalCases} (${failingCases} failing, ${highVarianceCases} high-variance)`);
console.log(`Runs:         ${totalRuns}`);
console.log(`Overall:      ${pct(overallConsistency)} consistency (${totalPasses}/${totalRuns})`);

// Assertion failure breakdown
if (assertionFailures.size > 0) {
  console.log("\n## Failure breakdown by assertion\n");
  const sorted = [...assertionFailures.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    const bar = "█".repeat(Math.min(20, Math.ceil(count / 2)));
    console.log(`  ${name.padEnd(28)} ${String(count).padStart(3)} failures  ${bar}`);
  }
}

// Exit with error if any case below threshold
if (minConsistency > 0 && overallConsistency < minConsistency) {
  console.log(`\n✗ Overall consistency ${pct(overallConsistency)} is below --min-consistency=${pct(minConsistency)}`);
  process.exit(1);
}

function extractAssertionName(a: any): string {
  // Try to get a readable name from the assertion result
  if (a.assertion?.type === "javascript") {
    const val = a.assertion?.value ?? "";
    const match = val.match(/assertions\/([^.]+)\.js/);
    if (match) return match[1];
  }
  if (a.assertion?.type === "llm-rubric") return "llm-rubric";
  return a.assertion?.type ?? "unknown";
}
