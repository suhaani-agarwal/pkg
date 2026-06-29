import { McpServer } from "skybridge/server";
import { getUserByApiKey, getUserById } from "./data/data-service.js";
import { verifyJwt } from "./auth/jwt.js";
import { getOpenApiSpecById, getOpenApiSpecByIdAdmin } from "./domain/subgraph/repository.js";
import { executeOpenApiRequest } from "./tools/external-api-tools.js";
import shareRouter from "./api/share.js";
import authRouter from "./api/auth.js";
import oauthRouter from "./api/oauth.js";
import userRouter from "./api/user.js";
import ingestRouter from "./api/ingest.js";
import gqlGatewayRouter from "./api/gql-gateway.js";
import oauthConnectorsRouter from "./api/oauth-connectors.js";
import express from "express";
import session from "express-session";
import path from "node:path";
import { runWithMcpContext, getMcpUser, getMcpSessionId } from "./data/mcp-context.js";
import { buildSessionId, traceMcpTool } from "./utils/langfuse.js";
import { registerDataTools } from "./tools/data-tools.js";
import { registerSopTools } from "./tools/sop-tools.js";
import { registerFleetTools } from "./tools/fleet-tools.js";
import { registerDashboardTools } from "./tools/dashboard-tools.js";
import { registerPresentDataTools } from "./tools/present-data-tools.js";
import { registerExternalApiTools } from "./tools/external-api-tools.js";

// ═════════════════════════════════════════════════════════════
export const server = new McpServer(
  { name: "fleet-management-copilot", version: "0.0.1" },
  { capabilities: {} },
);

registerDataTools(server);
registerSopTools(server);
registerFleetTools(server);
registerDashboardTools(server);
registerPresentDataTools(server);
registerExternalApiTools(server);

if (process.env.NODE_ENV === "production") {
  const { default: manifest } = await import("./vite-manifest.js");
  server.setViteManifest(manifest);
}

// Trust reverse-proxy / tunnel headers so req.protocol is https when behind a tunnel
server.express.set("trust proxy", 1);

// ── CORS for OAuth + MCP endpoints ──────────────────────────
// claude.ai and other web-based MCP clients call these from the browser.
// The Alpic/Cloudflare tunnel terminates TLS before us, so req.protocol
// may still read as "http" — derive the public base URL conservatively.
function publicBase(req: any): string {
  const host = req.get("host") ?? "localhost:3000";
  const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  const proto = isLocal ? (req.protocol ?? "http") : "https";
  return `${proto}://${host}`;
}

const oauthCors = (req: any, res: any, next: any) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
};
server.express.use("/oauth", oauthCors);
server.express.use("/.well-known", oauthCors);
server.express.use("/mcp", oauthCors);

// ── Session middleware ───────────────────────────────────────
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("SESSION_SECRET must be set in production");
}
server.express.use(session({
  secret: process.env.SESSION_SECRET ?? "fleet-local-session-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// ── MCP auth middleware ──────────────────────────────────────
// Accepts: server-signed JWT (device flow) OR legacy api_key (backwards compat).
// In dev: null user allowed through if no credential present.
server.express.use("/mcp", async (req: any, res: any, next: any) => {
  let token = (req.query?.api_key ?? req.headers?.["x-api-key"]) as string | undefined;
  if (!token) {
    const authHeader = req.headers?.["authorization"] as string | undefined;
    if (authHeader?.toLowerCase().startsWith("bearer ")) token = authHeader.slice(7).trim();
  }

  if (!token) {
    // Allow unauthenticated access only from localhost (Skybridge DevTools UI).
    // Any external connection — tunnel, cloud deploy — must authenticate and
    // will receive a 401 that triggers the client's OAuth2 flow.
    const ip = req.ip ?? req.socket?.remoteAddress ?? "";
    const isLocalhost = ["::1", "127.0.0.1", "::ffff:127.0.0.1"].includes(ip);
    if (isLocalhost && process.env.NODE_ENV !== "production") {
      runWithMcpContext({ user: null, sessionId: buildSessionId(null) }, next);
      return;
    }
    const base = publicBase(req);
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="ctrl", resource_metadata="${base}/.well-known/oauth-protected-resource"`)
      .json({ error: "Authentication required", resource_metadata: `${base}/.well-known/oauth-protected-resource` });
    return;
  }

  // Try JWT first (stateless, no DB hit)
  if (process.env.JWT_SECRET) {
    const claims = await verifyJwt(token);
    if (claims) {
      const user = {
        id: claims.sub,
        email: claims.email,
        name: "",
        api_key: "",
        role: claims.role,
        tenant_id: claims.tenant_id,
        created_at: "",
        updated_at: "",
      };
      runWithMcpContext({ user, sessionId: buildSessionId(user.email) }, next);
      return;
    }
    // JWT present but invalid/expired — tell the client to re-authenticate.
    // The error="invalid_token" hint causes MCP clients to start a new OAuth flow
    // rather than retrying the same expired token indefinitely.
    const base = publicBase(req);
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="ctrl", error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"`)
      .json({ error: "Token expired or invalid" });
    return;
  }

  // Fallback: API key DB lookup (existing MCP clients with ?api_key= or x-api-key)
  const user = await getUserByApiKey(token).catch(() => null);
  if (!user) {
    const base = publicBase(req);
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer realm="ctrl", error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource"`)
      .json({ error: "Invalid credentials" });
    return;
  }
  runWithMcpContext({ user, sessionId: buildSessionId(user.email) }, next);
});

// ── Dashboard action — executes a registered OpenAPI endpoint from a dashboard widget ──
// Auth: session cookie (portal) or x-api-key header (MCP chat view / DevTools).
server.express.post("/api/dashboard-action", express.json(), async (req: any, res: any) => {
  const sessionUserId = req.session?.userId;
  const apiKey = (
    req.headers?.["x-api-key"] ??
    req.headers?.["authorization"]?.replace(/^Bearer /i, "") ??
    req.body?.api_key
  ) as string | undefined;

  let user: any = null;
  if (sessionUserId) {
    user = await getUserById(sessionUserId).catch(() => null);
  } else if (apiKey) {
    user = await getUserByApiKey(apiKey).catch(() => null);
  } else if (process.env.NODE_ENV !== "production") {
    user = { id: "dev", tenant_id: "dev" };
  }
  if (!user) return res.status(401).json({ error: "Authentication required" });

  const { spec_id, path: apiPath, method, query_params, request_body } = req.body ?? {};
  if (!spec_id || !apiPath || !method) {
    return res.status(400).json({ error: "spec_id, path, and method are required" });
  }

  try {
    const tenantId = user.tenant_id ?? user.id;
    // In dev mode the synthetic user has no real tenant_id — skip tenant ownership check.
    const spec = (user.id === "dev" || !tenantId || tenantId === "dev")
      ? await getOpenApiSpecByIdAdmin(spec_id)
      : await getOpenApiSpecById(spec_id, tenantId);
    if (!spec) return res.status(404).json({ error: `Spec ${spec_id} not found` });
    const result = await executeOpenApiRequest(spec, apiPath, method, query_params, request_body, tenantId ?? spec.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── OSM tile proxy — avoids sandbox CSP blocking external img-src ──────────
// Views use /api/tiles/{z}/{x}/{y} instead of tile.openstreetmap.org directly.
// Same-origin requests are never blocked by the iframe CSP, solving blank maps.
// Gated to same-origin callers (Referer check) to prevent open-proxy abuse.
server.express.get("/api/tiles/:z/:x/:y", async (req: any, res: any) => {
  const referer = (req.headers["referer"] ?? "") as string;
  const origin = publicBase(req);
  // Allow empty Referer: Skybridge iframes send no Referer header (referrerpolicy: no-referrer).
  // Only block requests that supply a Referer pointing to a different origin.
  if (referer && !referer.startsWith(origin)) {
    res.status(403).end();
    return;
  }
  const { z: zoom, x, y } = req.params;
  const sub = ["a", "b", "c"][Math.floor(Math.random() * 3)];
  const url = `https://${sub}.tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  try {
    const upstream = await fetch(url, {
      headers: { "User-Agent": "ctrl-internal-mcp/1.0 (tile proxy)" },
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch {
    res.status(502).end();
  }
});

// ── REST API routes ─────────────────────────────────────────
server.express.use("/api", shareRouter);
server.express.use("/api/auth", authRouter);
server.express.use("/oauth", oauthRouter);
// OAuth2 authorization server metadata (RFC 8414)
// MCP clients discover this to know where to send users for login.
server.express.get("/.well-known/oauth-authorization-server", (req: any, res: any) => {
  const base = publicBase(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: ["openid", "email", "profile"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
  });
});
// OAuth2 protected resource metadata (RFC 9728) — MCP clients use this to discover
// which auth server to use before attempting tool calls.
// Handles both /.well-known/oauth-protected-resource and the path-suffixed variant
// /.well-known/oauth-protected-resource/mcp that Skybridge DevTools requests.
const oauthProtectedResource = (req: any, res: any) => {
  const base = publicBase(req);
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header", "query"],
    resource_documentation: `${base}/mcp`,
  });
};
server.express.get("/.well-known/oauth-protected-resource", oauthProtectedResource);
server.express.get("/.well-known/oauth-protected-resource/mcp", oauthProtectedResource);
server.express.use("/api/user", userRouter);
server.express.use("/api/ingest", ingestRouter);
server.express.use("/api/gql-gateway", gqlGatewayRouter);
server.express.use("/api/connectors", oauthConnectorsRouter);

// ── Shared dashboard viewer — served by the portal React SPA ──
const publicDir = path.resolve(process.cwd(), "public");
server.express.get("/share/s/:token", (_req, res) => {
  res.sendFile(path.join(publicDir, "portal", "index.html"));
});

// ── Portal (React app) ───────────────────────────────────────
server.express.use("/portal", express.static(path.join(publicDir, "portal")));
server.express.get("/portal/*path", (_req, res) => {
  res.sendFile(path.join(publicDir, "portal", "index.html"));
});

// ── MCP resources: skills (schema references + workflow guides) ────────────
// All skill content lives in skills/<name>/SKILL.md.
// Schema skills:  hasura://schema, hasura://schema/pg, /oracle, /sop, /openapi
// Workflow skills: skill://kpi-dashboard
import { readFileSync } from "node:fs";
function loadSkill(name: string): string {
  try {
    return readFileSync(path.resolve(process.cwd(), `skills/${name}/SKILL.md`), "utf-8");
  } catch {
    return `# ${name}\n\nSee skills/${name}/SKILL.md`;
  }
}

const skillResources: Array<{ skill: string; uri: string; description: string }> = [
  { skill: "schema-index",   uri: "hasura://schema",         description: "Routing guide — which sub-resource to read for each data source. Read this first." },
  { skill: "schema-pg",      uri: "hasura://schema/pg",      description: "Fleet Postgres tables: vehicles, trips, telemetry_events (all event types + data_payload keys), drivers." },
  { skill: "schema-oracle",  uri: "hasura://schema/oracle",  description: "Oracle remote schema: metric_si_*, metric_pd_*, metric_ana_*, metric_app_*, metric_mp_*, metric_langfuse_*, metric_status_*, metric_ops_*, oracle Actions (langfuse, ops_portal)." },
  { skill: "schema-sop",     uri: "hasura://schema/sop",     description: "SOP knowledge base: sop_policies, sop_steps, sop_trigger_conditions, search_sop_policies function. Always use preset or search function — never _ilike." },
  { skill: "schema-openapi", uri: "hasura://schema/openapi", description: "openapi_specs (endpoint catalog) + openapi_spec_credentials + sop_policy_api_links. Use preset='openapi_catalog' or 'openapi_search' for discovery. Query sop_policies with api_links { spec { ... } } for pre-linked endpoints. Execute via query_external_api(mode=execute, spec_id)." },
  { skill: "kpi-dashboard",          uri: "skill://kpi-dashboard",          description: "KPI dashboard build guide: widget recipes, GQL patterns, filter wiring. Read before calling get_kpi_dashboard." },
  { skill: "present-data-layouts",  uri: "skill://present-data-layouts",  description: "present_data layout block reference — block types, field display options, button variants, action types, natural-language-to-block mapping. Read before constructing a layout array." },
  { skill: "oracle-graphql",   uri: "skill://oracle-graphql",   description: "Oracle GraphQL query reliability rules: alias batching, aggregates, filter composition, self-correction, introspection. Read before writing any oracle query_data call." },
  { skill: "oracle-catalog",   uri: "skill://oracle-catalog",   description: "Motorq metric catalog: all metric_si/pd/ana/app/mp/langfuse/status/ops table column names and business descriptions." },
  { skill: "oracle-exec",      uri: "skill://oracle-exec",      description: "Cross-metric business reasoning: metric relationships, customer segmentation, derived KPI signals, leadership question patterns." },
  { skill: "oracle-pagerduty", uri: "skill://oracle-pagerduty", description: "PagerDuty metrics metric_pd_01..10, L2 pagerduty() action proxy, on-call and incident query patterns." },
  { skill: "oracle-langfuse",  uri: "skill://oracle-langfuse",  description: "Langfuse AI observability: metric_langfuse_01..08, langfuse() action proxy, L3 langfuse_traces/scores tables, known environments." },
  { skill: "oracle-mixpanel",  uri: "skill://oracle-mixpanel",  description: "Mixpanel events table, customer_id to company_name mapping, noise filters, BI pipeline gaps (Lyft APP-* empty)." },
  { skill: "oracle-status",    uri: "skill://oracle-status",    description: "Status page metrics metric_status_01..05, L2 status_page_incidents/components tables, outage and MTTR queries." },
  { skill: "oracle-ops",       uri: "skill://oracle-ops",       description: "Ops portal: user provisioning, org structure, hal9k environment classification, ops_portal() action paths." },
];

const skillContentMap: Record<string, string> = {};
for (const r of skillResources) {
  const content = loadSkill(r.skill);
  skillContentMap[r.skill] = content;
  // Keep registering as MCP resources for clients that support resources/read (Claude, Skybridge)
  (server as any).registerResource(
    `skill-${r.skill}`,
    r.uri,
    { description: r.description, mimeType: "text/markdown" },
    async () => ({ contents: [{ uri: r.uri, mimeType: "text/markdown", text: content }] }),
  );
}

// ── read_skill tool — portable fallback for clients that don't support resources/read ──
// Goose and other MCP clients generate "Load skill name:X" instead of calling read_resource
// because the "skill://" URI prefix is ambiguous with Goose's native skill system.
// This tool serves the same content as the resources, callable from any MCP client.
import { z } from "zod";
server.registerTool(
  {
    name: "read_skill",
    description: `Fetch a reference skill/guide by name. Use this whenever a tool description tells you to "read skill://X" or "check hasura://schema/Y".

Available names (pass exactly as listed):
  oracle-catalog    — all oracle metric table/column names
  oracle-graphql    — oracle query patterns, aggregates, filter composition
  oracle-exec       — cross-metric reasoning, customer segmentation, leadership KPI patterns
  oracle-pagerduty  — PagerDuty metric_pd_* tables and L2 pagerduty() proxy
  oracle-langfuse   — Langfuse metric_langfuse_* tables and langfuse() proxy
  oracle-mixpanel   — Mixpanel metric_mp_* tables and customer_id mapping
  oracle-status     — Status page metric_status_* tables
  oracle-ops        — Ops portal user provisioning and ops_portal() proxy
  kpi-dashboard     — KPI dashboard widget recipes, GQL patterns, filter wiring
  schema-index      — routing guide: which schema to read for each data source
  schema-pg         — fleet Postgres tables (vehicles, trips, telemetry_events)
  schema-oracle     — oracle remote schema overview
  schema-sop        — SOP knowledge base tables and search patterns
  schema-openapi    — openapi_specs catalog and credential tables`,
    inputSchema: {
      name: z.string().describe("Skill name from the list above, e.g. 'oracle-catalog'"),
    },
  },
  async ({ name }) => {
    const mcpUser = getMcpUser();
    return traceMcpTool("read_skill", mcpUser?.email ?? null, getMcpSessionId(), { name }, async () => {
      const content = skillContentMap[name];
      if (!content) {
        const available = Object.keys(skillContentMap).join(", ");
        return {
          content: [{ type: "text" as const, text: `Unknown skill "${name}". Available: ${available}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: content }],
        isError: false,
      };
    });
  },
);

export default await server.run();
export type AppType = typeof server;
