import "@/index.css";
import React, { useState, useEffect, useRef } from "react";
import { EChart } from "../charts/EChart.js";
import { AXIS_PRESET, ITEM_PRESET, LEGEND_PRESET, formatValue } from "../charts/presets.js";
import { CTRL_COLORS } from "../charts/theme.js";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@alpic-ai/ui/components/accordion";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@alpic-ai/ui/components/dialog";
import { Input } from "@alpic-ai/ui/components/input";
import { Skeleton } from "@alpic-ai/ui/components/skeleton";
import { TooltipProvider } from "@alpic-ai/ui/components/tooltip";
import { useToolInfo, useCallTool, useRequestSize, useSendFollowUpMessage } from "skybridge/web";
import { CheckCircle2, Loader2, AlertCircle, ExternalLink, Copy, Check, Search, X, Zap } from "lucide-react";


// ── Types ──────────────────────────────────────────────────────


type FieldDisplay =
 | "text" | "number" | "badge" | "status_badge" | "fuel_bar"
 | "date" | "boolean" | "link" | "email" | "currency" | "percent"
 | "avatar" | "code" | "truncate";


type ActionVariant = "primary" | "secondary" | "destructive" | "tertiary";
type ActionType = "call_tool" | "follow_up";


interface FieldSpec {
 key: string;
 label?: string;
 display?: FieldDisplay;
 prefix?: string;
 suffix?: string;
}


interface ActionSpec {
 label: string;
 tool: string;
 args_template: Record<string, any>;
 variant?: ActionVariant;
 confirm?: boolean;
 icon?: string;
 description?: string;
 action_type?: ActionType;
 message?: string;
}


interface StatItem {
 label: string;
 field: string;
 agg?: "count" | "sum" | "avg" | "max" | "min" | "first" | "last";
 unit?: string;
 prefix?: string;
 trend_field?: string;
 icon?: string;
 color?: "blue" | "green" | "amber" | "rose" | "violet" | "cyan";
}


type LayoutBlock =
 | { type: "stat_row"; items: StatItem[]; }
 | { type: "cards"; fields: FieldSpec[]; columns?: 2 | 3 | 4; title_field?: string; subtitle_field?: string; actions?: ActionSpec[]; searchable?: boolean; }
 | { type: "table"; fields?: FieldSpec[]; actions?: ActionSpec[]; searchable?: boolean; striped?: boolean; collapsible?: boolean; default_collapsed?: boolean; }
 | { type: "accordion"; title_field: string; subtitle_field?: string; fields: FieldSpec[]; badge_field?: string; }
 | { type: "list"; title_field: string; subtitle_field?: string; badge_field?: string; badge_display?: FieldDisplay; meta_fields?: FieldSpec[]; actions?: ActionSpec[]; }
 | { type: "detail"; fields?: FieldSpec[]; actions?: ActionSpec[]; title_field?: string; }
 | { type: "gallery"; image_field: string; title_field?: string; subtitle_field?: string; badge_field?: string; actions?: ActionSpec[]; }
 | { type: "timeline"; time_field: string; title_field: string; subtitle_field?: string; badge_field?: string; }
 | { type: "kv_grid"; pairs: Array<{ label: string; field: string; display?: FieldDisplay; }>; }
 | { type: "callout"; message: string; title?: string; variant?: "info" | "warning" | "success" | "error"; icon?: string; }
 | { type: "sparkline_table"; group_field: string; time_field: string; value_field: string; label?: string; unit?: string; color?: string; }
 | { type: "metric_grid"; label_field: string; value_field: string; columns?: 2 | 3 | 4; unit?: string; color?: "blue" | "green" | "amber" | "rose" | "violet"; secondary_field?: string; secondary_label?: string; }
 | { type: "bar_chart"; label_field: string; value_field: string; horizontal?: boolean; color?: string; }
 | { type: "line_chart"; x_field: string; y_field: string; series_field?: string; }
 | { type: "pie_chart"; label_field: string; value_field: string; donut?: boolean; }
 | { type: "tab_table"; tab_field: string; fields?: FieldSpec[]; actions?: ActionSpec[]; searchable?: boolean; }
 | { type: "grouped_table"; group_by: string; fields?: FieldSpec[]; actions?: ActionSpec[]; searchable?: boolean; };


interface DataPresenterInput {
 title: string;
 subtitle?: string;
 rows?: any[];
 layout: LayoutBlock[];
}


// ── Motorq light theme colors (always light, no dark mode) ──────

interface ThemeColors {
 bg: string;
 fg: string;
 muted: string;
 mutedFg: string;
 border: string;
 cardBg: string;
 cardFg: string;
 inputBg: string;
 tableHeaderBg: string;
 tableRowHoverBg: string;
}

const MQ_TC: ThemeColors = {
 bg: "#FFFFFF",
 fg: "#353D46",
 muted: "#F7F8F9",
 mutedFg: "#6A798C",
 border: "#D6DCE3",
 cardBg: "#FFFFFF",
 cardFg: "#353D46",
 inputBg: "#FFFFFF",
 tableHeaderBg: "#F7F8F9",
 tableRowHoverBg: "#F0F9FF",
};


const STAT_PALETTE = {
 blue:   { bg: () => "#E2F3FF", text: () => "#0561FC", icon: () => "#0561FC" },
 green:  { bg: () => "#E7F7EA", text: () => "#138837", icon: () => "#2DAB4E" },
 amber:  { bg: () => "#FEF3C7", text: () => "#D97706", icon: () => "#D97706" },
 rose:   { bg: () => "#FEEBEF", text: () => "#C32D34", icon: () => "#C32D34" },
 violet: { bg: () => "#EEF0F2", text: () => "#353D46", icon: () => "#6A798C" },
 cyan:   { bg: () => "#E2F3FF", text: () => "#0561FC", icon: () => "#0561FC" },
};

const CALLOUT_PALETTE = {
 info:    { bg: () => "#E2F3FF", border: () => "#86CDFF", text: () => "#0561FC",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0561FC" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> },
 warning: { bg: () => "#FEF3C7", border: () => "#FDE68A", text: () => "#D97706",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2"><path d="M10.3 3.3l-8 13.5A2 2 0 0 0 4 20h16a2 2 0 0 0 1.7-3.2l-8-13.5a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> },
 success: { bg: () => "#E7F7EA", border: () => "#A1DDAC", text: () => "#138837",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#138837" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg> },
 error:   { bg: () => "#FEEBEF", border: () => "#EC9BA0", text: () => "#C32D34",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C32D34" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> },
};


// ── Helpers ──────────────────────────────────────────────────


const STATUS_GOOD    = new Set(["active","available","success","ok","healthy","resolved","online","connected","approved","completed","paid","done"]);
const STATUS_WARN    = new Set(["warning","idle","pending","unknown","processing","in_review","partial"]);
const STATUS_BAD     = new Set(["error","maintenance","offline","critical","failed","alert","rejected","cancelled","expired","blocked","inactive"]);
const STATUS_PRIMARY = new Set(["on_trip","in_progress","running","active_trip","open","live"]);


function statusVariant(val: unknown): "success" | "warning" | "error" | "secondary" | "primary" {
 const s = String(val).toLowerCase().replace(/\s+/g, "_");
 if (STATUS_GOOD.has(s))    return "success";
 if (STATUS_WARN.has(s))    return "warning";
 if (STATUS_BAD.has(s))     return "error";
 if (STATUS_PRIMARY.has(s)) return "primary";
 return "secondary";
}


function computeAgg(rows: any[], field: string, agg?: StatItem["agg"]): number | string {
 const vals = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
 if (vals.length === 0) return "—";
 const nums = vals.map(Number).filter((n) => !isNaN(n));
 switch (agg) {
   case "count": return rows.length;
   case "sum":   return nums.reduce((s, v) => s + v, 0);
   case "avg":   return nums.length ? +(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(1) : "—";
   case "max":   return nums.length ? Math.max(...nums) : "—";
   case "min":   return nums.length ? Math.min(...nums) : "—";
   case "first": return vals[0];
   case "last":  return vals[vals.length - 1];
   default:      return vals[0];
 }
}


function interpolate(template: Record<string, any>, row: any): Record<string, any> {
 return Object.fromEntries(
   Object.entries(template).map(([k, v]) => [
     k,
     typeof v === "string" ? v.replace(/\{\{(\w+)\}\}/g, (_, f) => String(row[f] ?? "")) : v,
   ])
 );
}


function interpolateString(tmpl: string, row: any): string {
 return tmpl.replace(/\{\{(\w+)\}\}/g, (_, f) => String(row[f] ?? ""));
}


function initials(name: string): string {
 return name.split(" ").slice(0, 2).map((n) => n[0]?.toUpperCase() ?? "").join("");
}


const AVATAR_COLORS = [
 "#3b82f6","#8b5cf6","#10b981","#f59e0b",
 "#f43f5e","#06b6d4","#6366f1","#14b8a6","#f97316","#ec4899",
];
function avatarColor(seed: string) {
 let h = 0;
 for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
 return AVATAR_COLORS[h % AVATAR_COLORS.length];
}


// ── Primitive display components ────────────────────────────


function FuelBar({ pct }: { pct: number }) {
 const color = pct <= 20 ? "#C32D34" : pct <= 50 ? "#D97706" : "#2DAB4E";
 return (
   <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }} title={`${pct}% remaining`}>
     <div style={{ flex: 1, background: "#D6DCE3", borderRadius: 4, height: 6, overflow: "hidden" }}>
       <div style={{ width: `${Math.min(pct, 100)}%`, background: color, height: 6, borderRadius: 4 }} />
     </div>
     <span style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", fontWeight: 700, color, flexShrink: 0 }}>{pct}%</span>
   </div>
 );
}


function CopyableValue({ value, tc }: { value: string; tc: ThemeColors }) {
 const [copied, setCopied] = useState(false);
 return (
   <button
     onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
     className="flex items-center gap-1 group font-mono text-xs px-1.5 py-0.5 rounded transition-colors"
     style={{ background: tc.muted, color: tc.fg }}
   >
     <span className="truncate max-w-[140px]">{value}</span>
     {copied
       ? <Check className="w-2.5 h-2.5 shrink-0" style={{ color: "#22c55e" }} />
       : <Copy className="w-2.5 h-2.5 opacity-0 group-hover:opacity-60 shrink-0" style={{ color: tc.mutedFg }} />
     }
   </button>
 );
}


function FieldValue({ value, display, prefix, suffix, tc }: { value: unknown; display?: FieldDisplay; prefix?: string; suffix?: string; tc: ThemeColors }) {
 if (value === null || value === undefined || value === "") {
   return <span style={{ fontSize: 13, color: tc.mutedFg, opacity: 0.5 }}>—</span>;
 }
 const str = String(value);
 const wrap = (node: React.ReactNode) => (
   <span className="inline-flex items-center gap-0.5">
     {prefix && <span style={{ fontSize: 11, color: tc.mutedFg }}>{prefix}</span>}
     {node}
     {suffix && <span style={{ fontSize: 11, color: tc.mutedFg }}>{suffix}</span>}
   </span>
 );

 switch (display) {
   case "status_badge": {
     const sv = statusVariant(value);
     const sbg = sv === "success" ? "#E7F7EA" : sv === "warning" ? "#FEF3C7" : sv === "error" ? "#FEEBEF" : sv === "primary" ? "#E2F3FF" : "#F7F8F9";
     const sfg = sv === "success" ? "#138837" : sv === "warning" ? "#D97706" : sv === "error" ? "#C32D34" : sv === "primary" ? "#0561FC" : "#6A798C";
     const sbr = sv === "success" ? "#A1DDAC" : sv === "warning" ? "#FDE68A" : sv === "error" ? "#EC9BA0" : sv === "primary" ? "#86CDFF" : "#D6DCE3";
     return wrap(<span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 999, background: sbg, color: sfg, border: `1px solid ${sbr}`, textTransform: "capitalize", display: "inline-block" }}>{str.replace(/_/g, " ")}</span>);
   }
   case "badge":
     return wrap(<span style={{ fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 999, background: "#F7F8F9", color: "#6A798C", border: "1px solid #D6DCE3", display: "inline-block" }}>{str}</span>);
   case "fuel_bar":
     return <FuelBar pct={Number(value)} />;
   case "boolean":
     return <span style={{ fontSize: 13, color: value ? "#138837" : "#6A798C" }}>{value ? "Yes" : "No"}</span>;
   case "date":
     try {
       const d = new Date(str);
       return wrap(<span style={{ fontSize: 13, color: tc.fg }}>{d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>);
     } catch { return wrap(<span style={{ fontSize: 13, color: tc.fg }}>{str}</span>); }
   case "number":
     return wrap(<span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, fontWeight: 600, color: tc.fg }}>{Number(value).toLocaleString()}</span>);
   case "currency":
     return wrap(<span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, fontWeight: 600, color: "#2DAB4E" }}>${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>);
   case "percent":
     return wrap(<span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, fontWeight: 600, color: tc.fg }}>{Number(value).toFixed(1)}%</span>);
   case "link":
     return wrap(<a href={str} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#0561FC", display: "inline-flex", alignItems: "center", gap: 3 }}>{str.replace(/^https?:\/\//, "").slice(0, 30)}<ExternalLink size={11} style={{ flexShrink: 0 }} /></a>);
   case "email":
     return wrap(<a href={`mailto:${str}`} style={{ fontSize: 13, color: "#0561FC" }}>{str}</a>);
   case "code":
     return wrap(<CopyableValue value={str} tc={tc} />);
   case "avatar":
     return (
       <div className="flex items-center gap-2">
         <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ background: avatarColor(str) }}>
           <span style={{ color: "white", fontWeight: 700, fontSize: 10 }}>{initials(str)}</span>
         </div>
         <span style={{ fontSize: 13, fontWeight: 500, color: tc.fg }}>{str}</span>
       </div>
     );
   case "truncate":
     return (
       <span title={str} style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180, display: "block", cursor: "default", color: tc.fg }}>{str}</span>
     );
   default:
     return wrap(<span style={{ fontSize: 13, color: tc.fg }}>{str}</span>);
 }
}


// ── Action Button ────────────────────────────────────────────


function ActionButton({ action, row, tc: _tc }: { action: ActionSpec; row: any; tc: ThemeColors }) {
 const actionType = action.action_type ?? "call_tool";
 const { callTool, isPending } = useCallTool(action.tool as any);
 const sendFollowUp = useSendFollowUpMessage();


 const [localSuccess, setLocalSuccess] = useState(false);
 const [localError, setLocalError] = useState<string | null>(null);
 const [confirming, setConfirming] = useState(false);


 const doCall = () => {
   setLocalError(null);
   const args = interpolate(action.args_template, row);


   if (actionType === "follow_up") {
     // Send a follow-up message into the chat so the LLM handles it and renders the view
     const msgTemplate = action.message ?? `Call ${action.tool} with ${Object.entries(args).map(([k,v]) => `${k}="${v}"`).join(", ")}`;
     const msg = interpolateString(msgTemplate, row);
     sendFollowUp(msg)
       .then(() => { setLocalSuccess(true); setTimeout(() => setLocalSuccess(false), 2500); })
       .catch((e: unknown) => {
         setLocalError(e instanceof Error ? e.message : "Failed");
         setTimeout(() => setLocalError(null), 3000);
       });
   } else {
     (callTool as any)(args, {
       onSuccess: () => { setLocalSuccess(true); setTimeout(() => setLocalSuccess(false), 2500); },
       onError: (e: unknown) => {
         setLocalError(e instanceof Error ? e.message : "Failed");
         setTimeout(() => setLocalError(null), 3000);
       },
     });
   }
 };


 const handleClick = () => {
   if (action.confirm) { setConfirming(true); return; }
   doCall();
 };


 if (localSuccess) {
   return (
     <span className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: "#22c55e" }}>
       <CheckCircle2 className="w-3.5 h-3.5" />
       {actionType === "follow_up" ? "Sent" : "Done"}
     </span>
   );
 }
 if (localError) {
   return (
     <span title={localError} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, cursor: "default", color: "#C32D34" }}>
       <AlertCircle size={13} /> Error
     </span>
   );
 }

 const isPrimary = action.variant === "primary";
 const isDestructive = action.variant === "destructive";
 const btnBg = isDestructive ? "#C32D34" : isPrimary ? "#0561FC" : "#F7F8F9";
 const btnColor = isDestructive || isPrimary ? "#fff" : "#353D46";
 const btnBorder = isDestructive ? "#C32D34" : isPrimary ? "#0561FC" : "#D6DCE3";

 return (
   <>
     <button
       style={{ minHeight: 30, fontSize: 12, padding: "6px 12px", lineHeight: "16px", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4, background: btnBg, color: btnColor, border: `1px solid ${btnBorder}`, borderRadius: 6, cursor: isPending ? "default" : "pointer", fontFamily: "inherit", fontWeight: 600, opacity: isPending ? 0.6 : 1, textAlign: "center" }}
       onClick={handleClick}
       disabled={isPending}
     >
       {isPending ? <Loader2 size={12} style={{ animation: "spin .7s linear infinite" }} /> : action.label}
     </button>
     {action.confirm && confirming && (
       <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center" }}
         onClick={() => setConfirming(false)}>
         <div style={{ background: "#fff", border: "1px solid #D6DCE3", borderRadius: 8, padding: 20, minWidth: 300, maxWidth: 400, boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}
           onClick={(e) => e.stopPropagation()}>
           <div style={{ fontWeight: 700, fontSize: 15, color: "#353D46", marginBottom: 6 }}>Confirm: {action.label}</div>
           {action.description && <div style={{ fontSize: 13, color: "#6A798C", marginBottom: 16 }}>{action.description}</div>}
           <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
             <button style={{ height: 32, fontSize: 12, padding: "0 12px", background: "#F7F8F9", border: "1px solid #D6DCE3", color: "#353D46", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" }} onClick={() => setConfirming(false)}>Cancel</button>
             <button style={{ height: 32, fontSize: 12, padding: "0 12px", background: "#C32D34", border: "none", color: "#fff", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }} onClick={() => { setConfirming(false); doCall(); }}>Confirm</button>
           </div>
         </div>
       </div>
     )}
   </>
 );
}


// ── Search helper ────────────────────────────────────────────


function useSearch(rows: any[], enabled: boolean) {
 const [q, setQ] = useState("");
 const filtered = enabled && q
   ? rows.filter((r) => Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q.toLowerCase())))
   : rows;
 return { q, setQ, filtered };
}


function SearchBar({ q, setQ, tc }: { q: string; setQ: (v: string) => void; tc: ThemeColors }) {
 return (
   <div className="relative">
     <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: tc.mutedFg }} />
     <Input
       value={q}
       onChange={(e) => setQ(e.target.value)}
       placeholder="Search…"
       className="h-8 pl-8 text-xs"
       style={{ background: tc.inputBg, color: tc.fg, borderColor: tc.border }}
     />
     {q && (
       <button onClick={() => setQ("")} className="absolute right-2.5 top-1/2 -translate-y-1/2">
         <X className="w-3 h-3" style={{ color: tc.mutedFg }} />
       </button>
     )}
   </div>
 );
}


// ── Block renderers ──────────────────────────────────────────


function StatRowBlock({ block, rows }: { block: Extract<LayoutBlock, { type: "stat_row" }>; rows: any[]; dark?: boolean }) {
 const colClass = block.items.length <= 2 ? "grid-cols-2" : block.items.length === 3 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4";
 return (
   <div className={`grid ${colClass} gap-3`}>
     {block.items.map((item, i) => {
       const raw = computeAgg(rows, item.field, item.agg);
       const colorKey = item.color ?? (["blue","green","amber","rose","violet","cyan"][i % 6] as keyof typeof STAT_PALETTE);
       const palette = STAT_PALETTE[colorKey] ?? STAT_PALETTE.blue;
       const displayVal = typeof raw === "number"
         ? (item.agg === "avg" ? raw.toFixed(1) : raw.toLocaleString())
         : String(raw);


       return (
         <div
           key={item.label}
           className="rounded-xl p-4 flex flex-col gap-2.5"
           style={{ background: palette.bg(), border: `1px solid ${palette.bg()}` }}
         >
           <div className="flex items-center justify-between gap-2">
             <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: palette.text(), opacity: 0.75 }}>{item.label}</span>
             <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${palette.icon()}22` }}>
               <Zap className="w-4 h-4" style={{ color: palette.icon() }} />
             </div>
           </div>
           <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: palette.text(), lineHeight: 1.1 }}>
             {item.prefix ?? ""}{displayVal}{item.unit ?? ""}
           </div>
         </div>
       );
     })}
   </div>
 );
}


function CardsBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "cards" }>; rows: any[]; tc: ThemeColors; dark?: boolean }) {
 const { q, setQ, filtered } = useSearch(rows, block.searchable ?? false);
 const cols = block.columns ?? 3;
 const gridClass = cols === 2 ? "grid-cols-1 sm:grid-cols-2" : cols === 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";


 return (
   <div className="space-y-3">
     {block.searchable && <SearchBar q={q} setQ={setQ} tc={tc} />}
     {filtered.length === 0 && <div className="py-8 text-center" style={{ fontSize: 14, color: tc.mutedFg }}>No results found.</div>}
     <div className={`grid ${gridClass} gap-3`}>
       {filtered.map((row, i) => {
         const titleVal = block.title_field ? row[block.title_field] : null;
         const subtitleVal = block.subtitle_field ? row[block.subtitle_field] : null;
         return (
           <div
             key={i}
             className="rounded-xl p-4 space-y-3 transition-all"
             style={{ background: tc.cardBg, border: `1px solid ${tc.border}`, color: tc.cardFg }}
           >
             {titleVal && (
               <div>
                 <div style={{ fontSize: 15, fontWeight: 600, color: tc.fg }}>{String(titleVal)}</div>
                 {subtitleVal && <div style={{ fontSize: 13, color: tc.mutedFg, marginTop: 2 }}>{String(subtitleVal)}</div>}
               </div>
             )}
             <div className="space-y-2.5">
               {block.fields.map((f) => (
                 <div key={f.key} className="flex items-start gap-2 justify-between">
                   <span style={{ fontSize: 11, flexShrink: 0, color: tc.mutedFg, textTransform: "capitalize" as const, lineHeight: "20px" }}>{f.label ?? f.key.replace(/_/g, " ")}</span>
                   <div className="text-right min-w-0 flex-1">
                     <FieldValue value={row[f.key]} display={f.display} prefix={f.prefix} suffix={f.suffix} tc={tc} />
                   </div>
                 </div>
               ))}
             </div>
             {block.actions && block.actions.length > 0 && (
               <div className="flex flex-wrap gap-1.5 pt-2" style={{ borderTop: `1px solid ${tc.border}` }}>
                 {block.actions.map((action, ai) => (
                   <ActionButton key={ai} action={action} row={row} tc={tc} />
                 ))}
               </div>
             )}
           </div>
         );
       })}
     </div>
   </div>
 );
}


function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (!dir) return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" style={{ opacity: 0.3, flexShrink: 0 }}>
      <path d="M5 1L8 4H2L5 1Z" fill="currentColor" />
      <path d="M5 11L2 8H8L5 11Z" fill="currentColor" />
    </svg>
  );
  if (dir === "asc") return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" style={{ flexShrink: 0 }}>
      <path d="M5 1L8 5H2L5 1Z" fill="currentColor" />
      <path d="M5 11L2 7H8L5 11Z" fill="currentColor" opacity="0.3" />
    </svg>
  );
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" style={{ flexShrink: 0 }}>
      <path d="M5 1L8 5H2L5 1Z" fill="currentColor" opacity="0.3" />
      <path d="M5 11L2 7H8L5 11Z" fill="currentColor" />
    </svg>
  );
}

function TableBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "table" }>; rows: any[]; tc: ThemeColors }) {
 const { q, setQ, filtered } = useSearch(rows, block.searchable ?? false);
 const fields: FieldSpec[] = block.fields ?? (rows[0] ? Object.keys(rows[0]).map((k) => ({ key: k })) : []);
 const [sortField, setSortField] = useState<string | null>(null);
 const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
 const [collapsed, setCollapsed] = useState(block.default_collapsed ?? false);
 const PAGE_SIZE = 15;
 const [page, setPage] = useState(1);
 useEffect(() => { setPage(1); }, [q]);

 const handleSort = (key: string) => {
   if (sortField === key) {
     setSortDir((d) => (d === "asc" ? "desc" : "asc"));
   } else {
     setSortField(key);
     setSortDir("asc");
   }
 };

 const sorted = sortField
   ? [...filtered].sort((a, b) => {
       const av = a[sortField];
       const bv = b[sortField];
       const an = Number(av);
       const bn = Number(bv);
       const numericSort = !isNaN(an) && !isNaN(bn);
       let cmp = 0;
       if (numericSort) cmp = an - bn;
       else cmp = String(av ?? "").localeCompare(String(bv ?? ""));
       return sortDir === "asc" ? cmp : -cmp;
     })
   : filtered;

 const tableContent = (
   <div className="space-y-2">
     {block.searchable && <SearchBar q={q} setQ={setQ} tc={tc} />}
     <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tc.border}`, background: tc.cardBg }}>
       <div className="overflow-x-auto">
         <table className="w-full" style={{ fontSize: 13 }}>
           <thead>
             <tr style={{ background: tc.tableHeaderBg, borderBottom: `1px solid ${tc.border}` }}>
               {fields.map((f) => {
                 const isActive = sortField === f.key;
                 return (
                   <th
                     key={f.key}
                     className="text-left whitespace-nowrap select-none"
                     style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: isActive ? "#0561FC" : tc.mutedFg, cursor: "pointer" }}
                     onClick={() => handleSort(f.key)}
                   >
                     <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                       {f.label ?? f.key.replace(/_/g, " ")}
                       <SortIcon dir={isActive ? sortDir : null} />
                     </span>
                   </th>
                 );
               })}
               {block.actions && block.actions.length > 0 && (
                 <th className="text-right" style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: tc.mutedFg }}>Actions</th>
               )}
             </tr>
           </thead>
           <tbody>
             {sorted.length === 0 ? (
               <tr>
                 <td colSpan={fields.length + (block.actions?.length ? 1 : 0)} className="text-center py-10" style={{ color: tc.mutedFg, fontSize: 13 }}>
                   {q ? "No results match your search." : "No data available."}
                 </td>
               </tr>
             ) : (
               <>
                 {sorted.slice(0, page * PAGE_SIZE).map((row, i) => (
                   <tr
                     key={i}
                     className="transition-colors"
                     style={{ borderBottom: `1px solid ${tc.border}`, background: block.striped && i % 2 === 1 ? tc.tableHeaderBg : "transparent" }}
                     onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = tc.tableRowHoverBg; }}
                     onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = block.striped && i % 2 === 1 ? tc.tableHeaderBg : "transparent"; }}
                   >
                     {fields.map((f) => (
                       <td key={f.key} style={{ padding: "10px 16px" }}>
                         <FieldValue value={row[f.key]} display={f.display} prefix={f.prefix} suffix={f.suffix} tc={tc} />
                       </td>
                     ))}
                     {block.actions && block.actions.length > 0 && (
                       <td className="text-right" style={{ padding: "8px 16px" }}>
                         <div className="flex items-center justify-end gap-1.5 flex-wrap">
                           {block.actions.map((action, ai) => (
                             <ActionButton key={ai} action={action} row={row} tc={tc} />
                           ))}
                         </div>
                       </td>
                     )}
                   </tr>
                 ))}
                 {sorted.length > page * PAGE_SIZE && (
                   <tr>
                     <td colSpan={fields.length + (block.actions?.length ? 1 : 0)} style={{ padding: "10px 16px", textAlign: "center" }}>
                       <button
                         onClick={() => setPage((p) => p + 1)}
                         style={{ fontSize: 12, fontWeight: 600, color: "#0561FC", background: "none", border: "none", cursor: "pointer", padding: "4px 12px", borderRadius: 4, fontFamily: "inherit" }}
                       >
                         Show {Math.min(PAGE_SIZE, sorted.length - page * PAGE_SIZE)} more of {sorted.length - page * PAGE_SIZE} remaining…
                       </button>
                     </td>
                   </tr>
                 )}
               </>
             )}
           </tbody>
         </table>
       </div>
       {sorted.length > 0 && (
         <div style={{ padding: "6px 16px", borderTop: `1px solid ${tc.border}`, color: tc.mutedFg, fontSize: 11 }}>
           {q
             ? `${sorted.length} of ${rows.length} rows`
             : sorted.length > page * PAGE_SIZE
               ? `Showing ${page * PAGE_SIZE} of ${sorted.length} rows`
               : `${rows.length} rows`}
         </div>
       )}
     </div>
   </div>
 );

 if (!block.collapsible) return tableContent;

 return (
   <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tc.border}` }}>
     <button
       onClick={() => setCollapsed((c) => !c)}
       className="w-full flex items-center justify-between px-4 py-3 transition-colors"
       style={{ background: tc.tableHeaderBg, cursor: "pointer", border: "none", fontFamily: "inherit", textAlign: "left" }}
     >
       <span style={{ fontSize: 13, fontWeight: 600, color: tc.fg }}>
         {rows.length} row{rows.length !== 1 ? "s" : ""}{sortField ? ` · sorted by ${sortField.replace(/_/g, " ")} ${sortDir}` : ""}
       </span>
       <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: tc.mutedFg, transition: "transform 0.15s", transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
         <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
       </svg>
     </button>
     {!collapsed && <div style={{ borderTop: `1px solid ${tc.border}` }}>{tableContent}</div>}
   </div>
 );
}


function AccordionBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "accordion" }>; rows: any[]; tc: ThemeColors }) {
 return (
   <Accordion type="multiple" className="space-y-1.5">
     {rows.map((row, i) => {
       const title = String(row[block.title_field] ?? `Item ${i + 1}`);
       const subtitle = block.subtitle_field ? String(row[block.subtitle_field] ?? "") : undefined;
       const badge = block.badge_field ? row[block.badge_field] : undefined;
       return (
         <AccordionItem
           key={i}
           value={String(i)}
           className="rounded-xl px-4"
           style={{ background: tc.cardBg, border: `1px solid ${tc.border}` }}
         >
           <AccordionTrigger className="py-3 hover:no-underline">
             <div className="flex items-center gap-3 min-w-0 text-left">
               <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: avatarColor(title) }}>
                 <span style={{ color: "white", fontWeight: 700, fontSize: 11 }}>{initials(title)}</span>
               </div>
               <div className="min-w-0 flex-1">
                 <div style={{ fontSize: 14, fontWeight: 600, color: tc.fg }} className="truncate">{title}</div>
                 {subtitle && <div style={{ fontSize: 13, color: tc.mutedFg }} className="truncate">{subtitle}</div>}
               </div>
               {badge !== undefined && <FieldValue value={badge} display="status_badge" tc={tc} />}
             </div>
           </AccordionTrigger>
           <AccordionContent className="pb-4">
             <div className="h-px mb-3" style={{ background: tc.border }} />
             <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
               {block.fields.map((f) => (
                 <div key={f.key}>
                   <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: tc.mutedFg }}>{f.label ?? f.key.replace(/_/g, " ")}</dt>
                   <dd className="mt-1"><FieldValue value={row[f.key]} display={f.display} tc={tc} /></dd>
                 </div>
               ))}
             </dl>
           </AccordionContent>
         </AccordionItem>
       );
     })}
   </Accordion>
 );
}


function ListBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "list" }>; rows: any[]; tc: ThemeColors }) {
 return (
   <div className="space-y-1.5">
     {rows.map((row, i) => {
       const title = String(row[block.title_field] ?? `Item ${i + 1}`);
       const subtitle = block.subtitle_field ? String(row[block.subtitle_field] ?? "") : undefined;
       const badgeVal = block.badge_field ? row[block.badge_field] : undefined;
       return (
         <div
           key={i}
           className="flex items-center gap-3 px-4 py-3 rounded-xl transition-all"
           style={{ background: tc.cardBg, border: `1px solid ${tc.border}` }}
         >
           <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: avatarColor(title) }}>
             <span className="text-white font-bold text-xs">{initials(title)}</span>
           </div>
           <div className="flex-1 min-w-0">
             <div className="text-sm font-semibold" style={{ color: tc.fg }}>{title}</div>
             <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
               {subtitle && <span className="text-xs" style={{ color: tc.mutedFg }}>{subtitle}</span>}
               {block.meta_fields?.map((f) => (
                 <span key={f.key} className="text-xs flex items-center gap-1" style={{ color: tc.mutedFg }}>
                   <span className="capitalize">{f.label ?? f.key.replace(/_/g, " ")}:</span>
                   <FieldValue value={row[f.key]} display={f.display} tc={tc} />
                 </span>
               ))}
             </div>
           </div>
           <div className="flex items-center gap-2 shrink-0">
             {badgeVal !== undefined && <FieldValue value={badgeVal} display={block.badge_display ?? "status_badge"} tc={tc} />}
             {block.actions?.map((action, ai) => (
               <ActionButton key={ai} action={action} row={row} tc={tc} />
             ))}
           </div>
         </div>
       );
     })}
   </div>
 );
}


function DetailBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "detail" }>; rows: any[]; tc: ThemeColors }) {
 const row = rows[0];
 if (!row) return <div className="text-sm p-4 italic" style={{ color: tc.mutedFg }}>No data available.</div>;
 const fields: FieldSpec[] = block.fields ?? Object.keys(row).map((k) => ({ key: k }));
 const titleVal = block.title_field ? row[block.title_field] : null;


 return (
   <div className="rounded-xl overflow-hidden" style={{ background: tc.cardBg, border: `1px solid ${tc.border}` }}>
     {titleVal && (
       <div className="px-5 py-4" style={{ borderBottom: `1px solid ${tc.border}` }}>
         <div className="text-base font-semibold" style={{ color: tc.fg }}>{String(titleVal)}</div>
       </div>
     )}
     <div className="p-5 space-y-4">
       <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
         {fields.map((f) => (
           <div key={f.key}>
             <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: tc.mutedFg }}>{f.label ?? f.key.replace(/_/g, " ")}</dt>
             <dd className="mt-1.5"><FieldValue value={row[f.key]} display={f.display} prefix={f.prefix} suffix={f.suffix} tc={tc} /></dd>
           </div>
         ))}
       </dl>
       {block.actions && block.actions.length > 0 && (
         <>
           <div className="h-px" style={{ background: tc.border }} />
           <div className="flex flex-wrap gap-2">
             {block.actions.map((action, ai) => (
               <ActionButton key={ai} action={action} row={row} tc={tc} />
             ))}
           </div>
         </>
       )}
     </div>
   </div>
 );
}


function GalleryBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "gallery" }>; rows: any[]; tc: ThemeColors }) {
 const [selected, setSelected] = useState<any | null>(null);
 return (
   <>
     <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
       {rows.map((row, i) => {
         const imgSrc = String(row[block.image_field] ?? "");
         const title = block.title_field ? String(row[block.title_field] ?? "") : "";
         const badge = block.badge_field ? row[block.badge_field] : null;
         return (
           <div
             key={i}
             className="rounded-xl overflow-hidden cursor-pointer transition-all"
             style={{ background: tc.cardBg, border: `1px solid ${tc.border}` }}
             onClick={() => setSelected(row)}
           >
             {imgSrc && <img src={imgSrc} alt={title} className="w-full h-32 object-cover" />}
             <div className="p-2.5 space-y-1">
               {title && <div className="text-xs font-semibold truncate" style={{ color: tc.fg }}>{title}</div>}
               {block.subtitle_field && <div className="text-[10px] truncate" style={{ color: tc.mutedFg }}>{String(row[block.subtitle_field] ?? "")}</div>}
               {badge !== null && <FieldValue value={badge} display="status_badge" tc={tc} />}
             </div>
           </div>
         );
       })}
     </div>
     <Dialog open={!!selected} onOpenChange={(v) => { if (!v) setSelected(null); }}>
       <DialogContent className="max-w-lg">
         <DialogHeader><DialogTitle style={{ color: tc.fg }}>{selected && block.title_field ? String(selected[block.title_field]) : "Details"}</DialogTitle></DialogHeader>
         {selected && block.image_field && selected[block.image_field] && (
           <img src={String(selected[block.image_field])} alt="" className="w-full rounded-lg max-h-64 object-contain" />
         )}
         {selected && block.actions && (
           <div className="flex flex-wrap gap-2 pt-2">
             {block.actions.map((action, ai) => <ActionButton key={ai} action={action} row={selected} tc={tc} />)}
           </div>
         )}
       </DialogContent>
     </Dialog>
   </>
 );
}


function TimelineBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "timeline" }>; rows: any[]; tc: ThemeColors }) {
 const sorted = [...rows].sort((a, b) => {
   const at = new Date(a[block.time_field]).getTime();
   const bt = new Date(b[block.time_field]).getTime();
   return isNaN(at) || isNaN(bt) ? 0 : at - bt;
 });
 return (
   <div className="relative space-y-0 pl-6">
     <div className="absolute left-2 top-0 bottom-0 w-px" style={{ background: tc.border }} />
     {sorted.map((row, i) => {
       const t = new Date(row[block.time_field]);
       const title = String(row[block.title_field] ?? "");
       const subtitle = block.subtitle_field ? String(row[block.subtitle_field] ?? "") : undefined;
       const badge = block.badge_field ? row[block.badge_field] : null;
       return (
         <div key={i} className="relative pb-5">
           <div className="absolute -left-[18px] top-1 w-3 h-3 rounded-full border-2 " style={{ borderColor: "#e90060", background: tc.bg }} />
           <div className="text-[10px] font-mono" style={{ color: tc.mutedFg }}>
             {isNaN(t.getTime()) ? String(row[block.time_field]) : `${t.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
           </div>
           <div className="flex items-center gap-2 mt-0.5">
             <span className="text-sm font-semibold" style={{ color: tc.fg }}>{title}</span>
             {badge !== null && <FieldValue value={badge} display="status_badge" tc={tc} />}
           </div>
           {subtitle && <div className="text-xs mt-0.5" style={{ color: tc.mutedFg }}>{subtitle}</div>}
         </div>
       );
     })}
   </div>
 );
}


function KvGridBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "kv_grid" }>; rows: any[]; tc: ThemeColors }) {
 const row = rows[0] ?? {};
 return (
   <div className="rounded-xl p-4" style={{ background: tc.cardBg, border: `1px solid ${tc.border}` }}>
     <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">
       {block.pairs.map((pair) => (
         <div key={pair.label}>
           <dt className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: tc.mutedFg }}>{pair.label}</dt>
           <dd className="mt-1"><FieldValue value={row[pair.field]} display={pair.display} tc={tc} /></dd>
         </div>
       ))}
     </dl>
   </div>
 );
}


function CalloutBlock({ block }: { block: Extract<LayoutBlock, { type: "callout" }>; dark?: boolean }) {
 const palette = CALLOUT_PALETTE[block.variant ?? "info"];
 return (
   <div
     style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 16px", borderRadius: 8, background: palette.bg(), border: `1px solid ${palette.border()}` }}
   >
     <span style={{ flexShrink: 0, marginTop: 1 }}>{palette.icon}</span>
     <div>
       {(block as any).title && <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2, color: palette.text() }}>{(block as any).title}</div>}
       <p style={{ fontSize: 13, lineHeight: 1.5, color: palette.text(), margin: 0 }}>{block.message}</p>
     </div>
   </div>
 );
}


// ── Tiny inline sparkline (SVG path) ─────────────────────────
function Sparkline({ values, color, width = 80, height = 28 }: { values: number[]; color: string; width?: number; height?: number }) {
 if (values.length < 2) return <span style={{ fontSize: 11, color: "#6A798C" }}>—</span>;
 const min = Math.min(...values);
 const max = Math.max(...values);
 const range = max - min || 1;
 const pts = values.map((v, i) => {
   const x = (i / (values.length - 1)) * width;
   const y = height - ((v - min) / range) * (height - 4) - 2;
   return `${x.toFixed(1)},${y.toFixed(1)}`;
 });
 return (
   <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
     <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
     {/* last point dot */}
     {(() => {
       const last = pts[pts.length - 1].split(",");
       return <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />;
     })()}
   </svg>
 );
}

function SparklineTableBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "sparkline_table" }>; rows: any[]; tc: ThemeColors }) {
 const color = block.color ?? "#0561FC";
 // Group rows by group_field, sort each group by time_field
 const groupMap = new Map<string, any[]>();
 for (const row of rows) {
   const key = String(row[block.group_field] ?? "—");
   if (!groupMap.has(key)) groupMap.set(key, []);
   groupMap.get(key)!.push(row);
 }
 const groups = Array.from(groupMap.entries()).map(([name, groupRows]) => {
   const sorted = [...groupRows].sort((a, b) => {
     const at = new Date(a[block.time_field]).getTime();
     const bt = new Date(b[block.time_field]).getTime();
     return isNaN(at) || isNaN(bt) ? 0 : at - bt;
   });
   const values = sorted.map((r) => Number(r[block.value_field])).filter((n) => !isNaN(n));
   const latest = values[values.length - 1];
   return { name, values, latest, count: sorted.length };
 }).sort((a, b) => (b.latest ?? 0) - (a.latest ?? 0));

 const colLabel = block.label ?? block.value_field.replace(/_/g, " ");

 return (
   <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tc.border}`, background: tc.cardBg }}>
     <table className="w-full" style={{ fontSize: 13 }}>
       <thead>
         <tr style={{ background: tc.tableHeaderBg, borderBottom: `1px solid ${tc.border}` }}>
           <th className="text-left" style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: tc.mutedFg }}>{block.group_field.replace(/_/g, " ")}</th>
           <th className="text-left" style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: tc.mutedFg }}>Trend</th>
           <th className="text-right" style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: tc.mutedFg }}>{colLabel}{block.unit ? ` (${block.unit})` : ""}</th>
         </tr>
       </thead>
       <tbody>
         {groups.map(({ name, values, latest }, i) => (
           <tr key={i} style={{ borderBottom: `1px solid ${tc.border}` }}
             onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = tc.tableRowHoverBg; }}
             onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
             <td style={{ padding: "10px 16px", fontWeight: 600, color: tc.fg }}>{name}</td>
             <td style={{ padding: "6px 16px" }}><Sparkline values={values} color={color} /></td>
             <td className="text-right" style={{ padding: "10px 16px", fontFamily: "ui-monospace, monospace", fontWeight: 700, color }}>
               {latest !== undefined && !isNaN(latest) ? latest.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—"}
               {block.unit ? <span style={{ fontSize: 10, color: tc.mutedFg, marginLeft: 2 }}>{block.unit}</span> : null}
             </td>
           </tr>
         ))}
         {groups.length === 0 && (
           <tr><td colSpan={3} className="text-center py-8" style={{ color: tc.mutedFg, fontSize: 13 }}>No data available.</td></tr>
         )}
       </tbody>
     </table>
   </div>
 );
}

function MetricGridBlock({ block, rows }: { block: Extract<LayoutBlock, { type: "metric_grid" }>; rows: any[]; tc: ThemeColors }) {
 const colorKey = block.color ?? "blue";
 const palette = STAT_PALETTE[colorKey as keyof typeof STAT_PALETTE] ?? STAT_PALETTE.blue;
 const cols = block.columns ?? 3;
 const gridClass = cols === 2 ? "grid-cols-1 sm:grid-cols-2" : cols === 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";

 return (
   <div className={`grid ${gridClass} gap-3`}>
     {rows.map((row, i) => {
       const label = String(row[block.label_field] ?? `Item ${i + 1}`);
       const val = row[block.value_field];
       const numVal = val !== null && val !== undefined ? Number(val) : null;
       const secVal = block.secondary_field ? row[block.secondary_field] : undefined;
       return (
         <div key={i} className="rounded-xl p-4 flex flex-col gap-1.5"
           style={{ background: palette.bg(), border: `1px solid ${palette.bg()}` }}>
           <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: palette.text(), opacity: 0.75 }} className="truncate">{label}</div>
           <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "ui-monospace, monospace", color: palette.text(), lineHeight: 1.1 }}>
             {numVal !== null && !isNaN(numVal) ? numVal.toLocaleString(undefined, { maximumFractionDigits: 1 }) : "—"}
             {block.unit ? <span style={{ fontSize: 13, fontWeight: 400, marginLeft: 4 }}>{block.unit}</span> : null}
           </div>
           {block.secondary_field && secVal !== undefined && (
             <div style={{ fontSize: 11, color: palette.text(), opacity: 0.6 }}>
               {block.secondary_label ?? block.secondary_field.replace(/_/g, " ")}: {String(secVal)}
             </div>
           )}
         </div>
       );
     })}
   </div>
 );
}

// ── Tab Table ────────────────────────────────────────────────

function TabTableBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "tab_table" }>; rows: any[]; tc: ThemeColors }) {
  const allVals = [...new Set(rows.map((r) => String(r[block.tab_field] ?? "Other")))].sort();
  const tabs = ["All", ...allVals];
  const [active, setActive] = useState("All");
  const tabRows = active === "All" ? rows : rows.filter((r) => String(r[block.tab_field] ?? "Other") === active);
  const count = (t: string) => t === "All" ? rows.length : rows.filter((r) => String(r[block.tab_field] ?? "Other") === t).length;

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {tabs.map((tab) => {
          const isActive = tab === active;
          return (
            <button
              key={tab}
              onClick={() => setActive(tab)}
              style={{
                padding: "5px 12px", fontSize: 12, fontWeight: isActive ? 700 : 500,
                background: isActive ? "#0561FC" : tc.muted,
                color: isActive ? "#fff" : tc.mutedFg,
                border: `1px solid ${isActive ? "#0561FC" : tc.border}`,
                borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
                display: "inline-flex", alignItems: "center", gap: 5,
              }}
            >
              {tab.replace(/_/g, " ")}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
                background: isActive ? "rgba(255,255,255,0.25)" : tc.border,
                color: isActive ? "#fff" : tc.mutedFg,
              }}>{count(tab)}</span>
            </button>
          );
        })}
      </div>
      <TableBlock block={{ type: "table", fields: block.fields, actions: block.actions, searchable: block.searchable }} rows={tabRows} tc={tc} />
    </div>
  );
}

// ── Grouped Table ────────────────────────────────────────────

function GroupedTableBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "grouped_table" }>; rows: any[]; tc: ThemeColors }) {
  const { q, setQ, filtered } = useSearch(rows, block.searchable ?? false);
  const fields: FieldSpec[] = block.fields ?? (rows[0] ? Object.keys(rows[0]).filter((k) => k !== block.group_by).map((k) => ({ key: k })) : []);
  const hasActions = (block.actions?.length ?? 0) > 0;

  const sorted = [...filtered].sort((a, b) => String(a[block.group_by] ?? "").localeCompare(String(b[block.group_by] ?? "")));
  const groups: { key: string; rows: any[] }[] = [];
  for (const row of sorted) {
    const key = String(row[block.group_by] ?? "");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }

  return (
    <div className="space-y-2">
      {block.searchable && <SearchBar q={q} setQ={setQ} tc={tc} />}
      <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${tc.border}`, background: tc.cardBg }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: 13 }}>
            <thead>
              <tr style={{ background: tc.tableHeaderBg, borderBottom: `1px solid ${tc.border}` }}>
                {fields.map((f) => (
                  <th key={f.key} className="text-left whitespace-nowrap" style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: tc.mutedFg }}>
                    {f.label ?? f.key.replace(/_/g, " ")}
                  </th>
                ))}
                {hasActions && <th className="text-right" style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.07em", color: tc.mutedFg }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={fields.length + (hasActions ? 1 : 0)} className="text-center py-10" style={{ color: tc.mutedFg }}>{q ? "No results." : "No data."}</td></tr>
              ) : groups.map(({ key, rows: gRows }, gi) => (
                <React.Fragment key={key}>
                  <tr style={{ background: "#F0F9FF", borderTop: gi > 0 ? `2px solid ${tc.border}` : undefined, borderBottom: `1px solid ${tc.border}` }}>
                    <td colSpan={fields.length + (hasActions ? 1 : 0)} style={{ padding: "6px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "#0561FC" }}>{key.replace(/_/g, " ")}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 8px", borderRadius: 999, background: "#E2F3FF", color: "#0561FC" }}>{gRows.length}</span>
                      </div>
                    </td>
                  </tr>
                  {gRows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${tc.border}` }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = tc.tableRowHoverBg; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                      {fields.map((f) => (
                        <td key={f.key} style={{ padding: "10px 16px" }}>
                          <FieldValue value={row[f.key]} display={f.display} prefix={f.prefix} suffix={f.suffix} tc={tc} />
                        </td>
                      ))}
                      {hasActions && (
                        <td className="text-right" style={{ padding: "8px 16px" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                            {block.actions!.map((action, ai) => <ActionButton key={ai} action={action} row={row} tc={tc} />)}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div style={{ padding: "6px 16px", borderTop: `1px solid ${tc.border}`, color: tc.mutedFg, fontSize: 11 }}>
            {filtered.length} rows · {groups.length} group{groups.length !== 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chart blocks ─────────────────────────────────────────────

function NoData({ tc }: { tc: ThemeColors }) {
  return <div style={{ fontSize: 13, color: tc.mutedFg, padding: "32px 0", textAlign: "center" }}>No data.</div>;
}

function ChartContainer({ tc, children }: { tc: ThemeColors; children: React.ReactNode }) {
  return (
    <div className="rounded-xl" style={{ border: `1px solid ${tc.border}`, background: tc.cardBg, padding: "12px 12px 4px" }}>
      {children}
    </div>
  );
}

function BarChartBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "bar_chart" }>; rows: any[]; tc: ThemeColors }) {
  if (!rows.length) return <NoData tc={tc} />;
  const labels = rows.map((r) => String(r[block.label_field] ?? ""));
  const values = rows.map((r) => Number(r[block.value_field] ?? 0));
  // Auto-switch to horizontal when many categories or long labels — far more readable
  const autoH = !block.horizontal && (labels.length > 8 || (labels.length > 5 && labels.some((l) => l.length > 10)));
  const isH = (block.horizontal ?? false) || autoH;
  const catData = isH ? [...labels].reverse() : labels;
  const catAxis = {
    type: "category" as const,
    data: catData,
    axisLabel: isH
      ? { interval: 0, overflow: "truncate" as const, width: 130 }
      : { interval: labels.length > 10 ? ("auto" as any) : 0 },
  };
  const valAxis = { type: "value" as const, axisLabel: { formatter: formatValue } };
  const chartHeight = isH ? `${Math.max(200, labels.length * 32)}px` : "260px";
  const option = {
    ...AXIS_PRESET,
    grid: isH
      ? { left: 8, right: 20, top: 8, bottom: 8, containLabel: true }
      : { left: 16, right: 16, top: 12, bottom: 28, containLabel: true },
    xAxis: isH ? valAxis : catAxis,
    yAxis: isH ? catAxis : valAxis,
    series: [{ type: "bar", data: isH ? [...values].reverse() : values, ...(block.color ? { itemStyle: { color: block.color } } : {}) }],
  };
  return <ChartContainer tc={tc}><EChart option={option as any} height={chartHeight} /></ChartContainer>;
}

function LineChartBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "line_chart" }>; rows: any[]; tc: ThemeColors }) {
  if (!rows.length) return <NoData tc={tc} />;

  if (block.series_field) {
    const grouped = new Map<string, any[]>();
    for (const r of rows) {
      const k = String(r[block.series_field] ?? "");
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(r);
    }
    const xSet = new Set(rows.map((r) => String(r[block.x_field] ?? "")));
    const xData = [...xSet];
    const xIdx = new Map(xData.map((x, i) => [x, i]));
    const series = [...grouped.entries()].map(([name, grp], i) => {
      const vals = new Array(xData.length).fill(null);
      for (const r of grp) {
        const xi = xIdx.get(String(r[block.x_field] ?? ""));
        if (xi !== undefined) vals[xi] = Number(r[block.y_field] ?? 0);
      }
      return { type: "line", name, data: vals, smooth: true, connectNulls: true, color: CTRL_COLORS[i % CTRL_COLORS.length] };
    });
    const option = {
      ...LEGEND_PRESET,
      grid: { left: 16, right: 16, top: 12, bottom: 44, containLabel: true },
      xAxis: { type: "category", data: xData },
      yAxis: { type: "value", axisLabel: { formatter: formatValue } },
      series,
    };
    return <ChartContainer tc={tc}><EChart option={option as any} height="260px" /></ChartContainer>;
  }

  const xData = rows.map((r) => String(r[block.x_field] ?? ""));
  const yData = rows.map((r) => Number(r[block.y_field] ?? 0));
  const interval = xData.length > 12 ? Math.floor(xData.length / 8) : 0;
  const option = {
    ...AXIS_PRESET,
    grid: { left: 16, right: 16, top: 12, bottom: 28, containLabel: true },
    xAxis: { type: "category", data: xData, axisLabel: { rotate: xData.length > 10 ? -30 : 0, interval } },
    yAxis: { type: "value", axisLabel: { formatter: formatValue } },
    series: [{ type: "line", data: yData, smooth: true, areaStyle: { opacity: 0.12 } }],
  };
  return <ChartContainer tc={tc}><EChart option={option as any} height="260px" /></ChartContainer>;
}

function PieChartBlock({ block, rows, tc }: { block: Extract<LayoutBlock, { type: "pie_chart" }>; rows: any[]; tc: ThemeColors }) {
  if (!rows.length) return <NoData tc={tc} />;
  const pieData = rows
    .map((r) => ({ name: String(r[block.label_field] ?? ""), value: Number(r[block.value_field] ?? 0) }))
    .filter((d) => !isNaN(d.value) && d.value > 0)
    .sort((a, b) => b.value - a.value);
  if (!pieData.length) return <NoData tc={tc} />;

  const isDonut = !!block.donut;
  const showLegend = pieData.length <= 8;

  const seriesConfig: any = {
    type: "pie",
    data: pieData,
    avoidLabelOverlap: true,
    center: showLegend ? ["38%", "50%"] : ["50%", "50%"],
  };

  if (isDonut) {
    seriesConfig.radius = ["35%", "60%"];
    seriesConfig.label = { show: false };
    seriesConfig.labelLine = { show: false };
    seriesConfig.emphasis = { label: { show: true, fontSize: 13, fontWeight: 600, formatter: "{b}\n{d}%" } };
  } else {
    seriesConfig.radius = "60%";
    // Only show labels when few slices — many labels on a pie overlap and look broken
    if (pieData.length <= 4) {
      seriesConfig.label = { fontSize: 11, formatter: "{b}: {d}%" };
      seriesConfig.labelLine = { length: 6, length2: 6 };
    } else {
      seriesConfig.label = { show: false };
      seriesConfig.labelLine = { show: false };
    }
  }

  const option = {
    ...ITEM_PRESET,
    legend: showLegend ? {
      show: true, orient: "vertical", right: "2%", top: "middle",
      icon: "circle", itemWidth: 8, itemHeight: 8,
      textStyle: { fontSize: 11, color: "#6A798C" },
    } : { show: false },
    series: [seriesConfig],
  };
  return (
    <div className="rounded-xl" style={{ border: `1px solid ${tc.border}`, background: tc.cardBg, padding: "12px 12px 8px" }}>
      <EChart option={option as any} height="280px" />
    </div>
  );
}

function renderBlock(block: LayoutBlock, rows: any[], idx: number, tc: ThemeColors, dark: boolean) {
 const key = idx;
 switch (block.type) {
   case "stat_row":  return <StatRowBlock   key={key} block={block} rows={rows} dark={dark} />;
   case "cards":     return <CardsBlock     key={key} block={block} rows={rows} tc={tc} dark={dark} />;
   case "table":     return <TableBlock     key={key} block={block} rows={rows} tc={tc} />;
   case "accordion": return <AccordionBlock key={key} block={block} rows={rows} tc={tc} />;
   case "list":      return <ListBlock      key={key} block={block} rows={rows} tc={tc} />;
   case "detail":    return <DetailBlock    key={key} block={block} rows={rows} tc={tc} />;
   case "gallery":   return <GalleryBlock   key={key} block={block} rows={rows} tc={tc} />;
   case "timeline":  return <TimelineBlock  key={key} block={block} rows={rows} tc={tc} />;
   case "kv_grid":          return <KvGridBlock        key={key} block={block} rows={rows} tc={tc} />;
   case "callout":          return <CalloutBlock       key={key} block={block} />;
   case "sparkline_table":  return <SparklineTableBlock key={key} block={block} rows={rows} tc={tc} />;
   case "metric_grid":      return <MetricGridBlock     key={key} block={block} rows={rows} tc={tc} />;
   case "bar_chart":        return <BarChartBlock       key={key} block={block} rows={rows} tc={tc} />;
   case "line_chart":       return <LineChartBlock      key={key} block={block} rows={rows} tc={tc} />;
   case "pie_chart":        return <PieChartBlock       key={key} block={block} rows={rows} tc={tc} />;
   case "tab_table":        return <TabTableBlock       key={key} block={block} rows={rows} tc={tc} />;
   case "grouped_table":    return <GroupedTableBlock   key={key} block={block} rows={rows} tc={tc} />;
   default: return null;
 }
}


// ── Root ─────────────────────────────────────────────────────


export default function DataPresenter() {
 const toolInfo = useToolInfo();
 const requestSize = useRequestSize();
 const rootRef = useRef<HTMLDivElement>(null);
 const tc = MQ_TC;

 // Force the iframe body to always use Motorq light background
 useEffect(() => {
   document.body.style.margin = "0";
   document.body.style.padding = "0";
   document.body.style.background = "#FFFFFF";
   document.body.style.color = "#353D46";
 }, []);


 useEffect(() => {
   if (!rootRef.current) return;
   const ro = new ResizeObserver(() => {
     if (rootRef.current) requestSize({ height: rootRef.current.scrollHeight + 32 });
   });
   ro.observe(rootRef.current);
   return () => ro.disconnect();
 }, []);


 if (!toolInfo.isSuccess) {
   return (
     <div className="p-6 space-y-3" style={{ background: tc.bg }}>
       <Skeleton className="h-6 w-48" />
       <div className="grid grid-cols-3 gap-3">
         {[1,2,3].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
       </div>
       <Skeleton className="h-48 rounded-xl" />
     </div>
   );
 }


 const { title, subtitle, layout = [] } = ((toolInfo as any).output ?? {}) as Omit<DataPresenterInput, "rows">;
 const { rows = [] } = ((toolInfo as any).responseMetadata ?? {}) as { rows?: any[] };


 return (
   <TooltipProvider>
     <div
       ref={rootRef}
       style={{ background: tc.bg, color: tc.fg, minHeight: "100%" }}
     >
       <div className="mx-auto w-full max-w-5xl p-4 space-y-5">
         {/* Header */}
         <div className="pb-4" style={{ borderBottom: `1px solid ${tc.border}` }}>
           <h2 className="text-xl font-bold tracking-tight" style={{ color: tc.fg }}>{title}</h2>
           {subtitle && <p className="mt-1" style={{ fontSize: 14, color: tc.mutedFg }}>{subtitle}</p>}
           {rows.length > 0 && (
             <p className="mt-1" style={{ fontSize: 11, color: tc.mutedFg, opacity: 0.6 }}>{rows.length} record{rows.length !== 1 ? "s" : ""}</p>
           )}
         </div>


         {/* Layout blocks */}
         {layout.map((block, i) => renderBlock(block, rows, i, tc, false))}
       </div>
     </div>
   </TooltipProvider>
 );
}
