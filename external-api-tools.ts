import { z } from "zod";
import type { McpServer } from "skybridge/server";
import { getMcpUser, getMcpSessionId } from "../data/mcp-context.js";
import { traceMcpTool } from "../utils/langfuse.js";
import {
  getTenantOpenApiSpecs,
  getOpenApiSpecById,
  getOpenApiCredentials,
  saveOpenApiCredential,
} from "../domain/subgraph/repository.js";
import { resolveEffectiveOAuth2Scheme, resolveEffectiveOAuthApp, getValidOAuthAccessToken } from "../domain/subgraph/oauth.js";
import { signState } from "../utils/oauth-state.js";
import { signActionTicket, verifyActionTicket } from "../utils/action-ticket.js";
import { baseUrl } from "../utils/base-url.js";
import { jsonErr } from "./types.js";

// ── Standalone HTTP executor (reused by /api/dashboard-action) ────────────

export async function executeOpenApiRequest(
  spec: { id: string; target_base_url: string; spec_json?: any },
  path: string,
  method: string,
  queryParams: Record<string, string> | undefined,
  requestBody: Record<string, any> | undefined,
  tenantId: string,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; ok: boolean; response: any }> {
  const httpMethod = method.toUpperCase();
  const base = spec.target_base_url.replace(/\/$/, "");
  // Resolve any {{field}} placeholders left in the path from query_template context
  const resolvedPathStr = path.replace(
    /\{\{(\w+)\}\}/g,
    (_, k) => encodeURIComponent(String(queryParams?.[k] ?? requestBody?.[k] ?? "")),
  );
  const apiPath = resolvedPathStr.startsWith("/") ? resolvedPathStr : `/${resolvedPathStr}`;
  const url = new URL(`${base}${apiPath}`);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, String(v));
  }

  const savedCreds = await getOpenApiCredentials(spec.id, tenantId).catch(() => []);
  const savedHeaders: Record<string, string> = {};
  const savedQueryParams: Record<string, string> = {};

  for (const cred of savedCreds) {
    const isBasicEmail = cred.credential_name === "__basic_email__";
    const isBasicToken = cred.credential_name === "__basic_token__";
    if (!isBasicEmail && !isBasicToken) {
      savedHeaders[cred.credential_name] = cred.decrypted_value;
    }
  }
  const basicEmail = savedCreds.find((c) => c.credential_name === "__basic_email__");
  const basicToken = savedCreds.find((c) => c.credential_name === "__basic_token__");
  if (basicEmail && basicToken) {
    const encoded = Buffer.from(`${basicEmail.decrypted_value}:${basicToken.decrypted_value}`).toString("base64");
    savedHeaders["Authorization"] = `Basic ${encoded}`;
  }
  // OAuth2 connector token (if this spec has one configured, spec-declared or
  // platform-default) takes precedence over any stale saved credential.
  const oauth2Info = resolveEffectiveOAuth2Scheme(spec.spec_json ?? {}, spec.target_base_url);
  if (oauth2Info) {
    const app = await resolveEffectiveOAuthApp(spec.id, tenantId, spec.target_base_url);
    if (app) {
      const token = await getValidOAuthAccessToken(spec.id, tenantId, oauth2Info.tokenUrl, app).catch(() => null);
      if (token) savedHeaders["Authorization"] = `Bearer ${token}`;
    }
  }
  for (const [k, v] of Object.entries(savedQueryParams)) {
    if (!url.searchParams.has(k)) url.searchParams.set(k, v);
  }

  const fetchOpts: RequestInit = {
    method: httpMethod,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...savedHeaders,
      ...(extraHeaders ?? {}),
    },
  };
  if (requestBody && ["POST", "PUT", "PATCH"].includes(httpMethod)) {
    fetchOpts.body = JSON.stringify(requestBody);
  }

  let apiStatus = 0;
  let apiOk = false;
  let apiResponse: any;
  try {
    const res = await fetch(url.toString(), fetchOpts);
    apiStatus = res.status;
    apiOk = res.ok;
    const ct = res.headers.get("content-type") ?? "";
    apiResponse = ct.includes("json") ? await res.json() : await res.text();
  } catch (fetchErr) {
    apiResponse = { error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) };
  }
  return { status: apiStatus, ok: apiOk, response: apiResponse };
}

export function registerExternalApiTools(server: McpServer): void {
  // ── query_external_api ───────────────────────────────────
  server.registerTool(
    {
      name: "query_external_api",
      description: `Query data from any external REST API registered via the OpenAPI spec portal.

Call immediately — do NOT narrate or ask for confirmation first. The view handles all feedback (Connect button, confirmation card, errors). At most say one short sentence after the view renders.

MODE — choose one:
  mode="execute" — use when spec_id, path, and method are known.
    GET: executes immediately once auth is resolved.
    POST/PUT/PATCH/DELETE: always renders a confirmation card first — the write happens only when the user clicks Execute. Do not call again expecting a write to occur; the card handles it.
  mode="discover" — use only when you don't know which spec or endpoint to use yet.
    Never use discover after show_sop_response (endpoint is already in the result) or after query_data(preset="openapi_catalog").

AUTH: auto-resolves. OAuth2 tokens, saved API keys, and Basic credentials are injected automatically. Never ask the user to paste an OAuth token or a previously-saved credential.

RECORD-ORIENTED APIs: never invent or guess a path ID. If you don't have the real ID, GET/list the resource first to find it; if nothing matches, POST a new record and use the ID it returns.`,
      inputSchema: {
        mode: z.enum(["discover", "execute"]).describe("'discover' = show available endpoints from Hasura. 'execute' = call the live endpoint and return results."),
        situation: z.string().optional().describe("What the user wants to do, in plain English. Used in discover mode to highlight the best matching endpoint."),
        spec_id: z.string().optional().describe("UUID of the spec to use (required for execute mode). Omit in discover mode — all specs are shown."),
        path: z.string().optional().describe("API path to call, e.g. /users or /posts/1 (required for execute mode)."),
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).optional().describe("HTTP method (required for execute mode, default GET)."),
        query_params: z.record(z.string(), z.string()).optional().describe("URL query parameters."),
        request_body: z.record(z.string(), z.any()).optional().describe("JSON body for POST/PUT/PATCH."),
        extra_headers: z.record(z.string(), z.string()).optional().describe("Additional HTTP headers."),
        display_mode: z.enum(["auto", "table", "cards", "chart"]).optional().describe("How to display the result. 'cards' renders each item as a card (best when ≤8 keys per item). 'auto' picks cards automatically when ≤8 keys. 'table' forces the data table. 'chart' forces a bar chart if numeric data exists. Default is 'table'."),
        action_token: z.string().optional().describe("Set ONLY by the rendered Execute button — never pass this yourself. It is only ever issued inside this tool's own confirmation card, so its presence proves a human already saw and approved this exact request."),
      },
      view: {
        component: "external-api-interactor",
        description: "Interactive API runner: shows a confirmation form for write operations, a credentials form when auth fails, and an adaptive result view (table, chart, or raw JSON) with Hasura fleet context alongside.",
      },
    },
    async ({ mode, situation, spec_id, path, method, query_params, request_body, extra_headers, display_mode, action_token }) => {
      const mcpUser = getMcpUser();
      return traceMcpTool("query_external_api", mcpUser?.email ?? null, getMcpSessionId(), { mode, spec_id, path, method }, async () => {
      try {
        if (!mcpUser) return jsonErr(
          "Not authenticated. Send your API key as: Authorization: Bearer <key>, x-api-key: <key>, or ?api_key=<key>. " +
          "Get your key from the portal at /portal/profile."
        );

        const tenantId = mcpUser.tenant_id ?? mcpUser.id;

        // ── DISCOVER MODE ──────────────────────────────────────
        // Uses compact endpoints_index catalog — no spec_json loaded.
        if (mode === "discover" || !spec_id || !path) {
          const specs = await getTenantOpenApiSpecs(tenantId);
          if (specs.length === 0) {
            return {
              structuredContent: { specs: [], total: 0 },
              content: [{ type: "text" as const, text: "No external API specs registered yet. Upload an OpenAPI spec at /portal/data-sources/openapi." }],
              isError: false,
            };
          }

          const parsed = specs.map((s) => {
            const endpoints = (s.endpoints_index ?? []).map((ep) => ({
              path: ep.path,
              method: ep.method,
              operationId: ep.operationId ?? null,
              summary: ep.summary ?? null,
              description: ep.description ?? null,
              parameters: ep.parameters,
              hasRequestBody: ep.hasRequestBody,
              requestBodyFields: ep.requestBodyFields ?? null,
            }));
            return { id: s.id, title: s.title, spec_summary: s.spec_summary ?? null, target_base_url: s.target_base_url, endpoints };
          });

          const totalEndpoints = parsed.reduce((sum, sp) => sum + sp.endpoints.length, 0);
          const lines: string[] = [
            `${specs.length} registered API spec${specs.length !== 1 ? "s" : ""} (${totalEndpoints} endpoints total).`,
            situation ? `Situation: "${situation}"` : "",
            "",
          ];
          for (const sp of parsed) {
            lines.push(`## ${sp.title}  [spec_id: ${sp.id}]`);
            if (sp.spec_summary) lines.push(sp.spec_summary);
            lines.push(`Base URL: ${sp.target_base_url}`);
            for (const ep of sp.endpoints) {
              const req = ep.parameters.filter((p: any) => p.required).map((p: any) => `${p.name}(${p.in})`).join(", ");
              lines.push(`  ${ep.method.padEnd(6)} ${ep.path}  —  ${ep.summary ?? ep.operationId ?? "(no summary)"}${req ? `  [${req}]` : ""}`);
              if (ep.requestBodyFields?.length) {
                const fields = ep.requestBodyFields.map((f: any) => `${f.name}${f.required ? "*" : ""}${f.type ? `:${f.type}` : ""}`).join(", ");
                lines.push(`           body fields (* = required): ${fields}`);
              }
            }
            lines.push("");
          }
          if (situation) {
            lines.push(`Now pick the endpoint that best matches "${situation}" and call this tool again with mode=execute.`);
          } else {
            lines.push("To fetch live data, call this tool again with mode=execute, spec_id, path, and method.");
          }

          return {
            structuredContent: { specs: parsed, total: specs.length, situation: situation ?? null },
            content: [{ type: "text" as const, text: lines.join("\n") }],
            isError: false,
          };
        }

        // ── EXECUTE MODE ────────────────────────────────────────
        // Load only the single spec being executed — not all tenant specs.
        const spec = await getOpenApiSpecById(spec_id, tenantId);
        if (!spec) return jsonErr(`Spec ${spec_id} not found. Call with mode=discover to see available specs.`);

        const httpMethod = (method ?? "GET").toUpperCase();

        // Reject unresolved path template params (e.g. "{caseNumber}") before making any
        // network call — sending the literal placeholder to the real API produces a
        // confusing 404 ("record not found") instead of the actual problem.
        const unresolvedParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
        if (unresolvedParams.length > 0) {
          return jsonErr(
            `The path "${path}" still has unresolved placeholder(s): ${unresolvedParams.map((p) => `{${p}}`).join(", ")}. ` +
            `Those are template parameters from the spec, not real values — substitute the actual ID directly into the path before calling again, e.g. "/cases/2150946401/notes" instead of "/cases/{caseNumber}/notes". ` +
            `If you don't have the real ID yet, look it up first with a GET/list call on this same spec.`
          );
        }

        // Parse security schemes from the spec — done unconditionally so bounce-back paths can reuse authFields
        const specJson = spec.spec_json as any;
        const securitySchemes: Record<string, any> = specJson?.components?.securitySchemes ?? {};
        const globalSecurity: any[] = specJson?.security ?? [];
        const pathItem = specJson?.paths?.[path] ?? {};
        const opSecurity: any[] = pathItem?.[httpMethod.toLowerCase()]?.security ?? globalSecurity;

        type AuthField = {
          name: string;
          location: "headers" | "query_params";
          description: string;
          required: boolean;
          inputType?: "password" | "text" | "email";
          basicPart?: "email" | "token";
        };
        // Resolved once, up front: either a real oauth2 scheme the spec declares itself,
        // or a platform-default provider matched by this spec's target_base_url host —
        // for specs (most real-world vendor specs) that only document OAuth in prose,
        // with the real authorize/token endpoints living on a separate host never
        // embedded in their own openapi.json. When this resolves, OAuth wins exclusively
        // — no manual Bearer/Basic/apiKey field is ever shown, even if the spec's own
        // securitySchemes are plain http/basic/bearer (e.g. Jira's "BearerAuth").
        const effectiveOAuth2 = resolveEffectiveOAuth2Scheme(specJson, spec.target_base_url);

        const authFields: AuthField[] = [];
        let needsOAuth2 = !!effectiveOAuth2;
        for (const secReq of opSecurity) {
          for (const schemeName of Object.keys(secReq)) {
            const scheme = securitySchemes[schemeName];
            if (!scheme) continue;
            if (scheme.type === "oauth2") {
              needsOAuth2 = true;
              continue;
            }
            if (effectiveOAuth2) continue; // OAuth resolved — suppress manual fields entirely
            if (scheme.type === "apiKey") {
              authFields.push({
                name: scheme.name,
                location: scheme.in === "query" ? "query_params" : "headers",
                description: `API key (${schemeName})`,
                required: true,
                inputType: "password",
              });
            } else if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
              // Split Basic auth into Email + API Token so the user fills two human-readable fields
              authFields.push({
                name: "__basic_email__",
                location: "headers",
                description: "Your account email address",
                required: true,
                inputType: "email",
                basicPart: "email",
              });
              authFields.push({
                name: "__basic_token__",
                location: "headers",
                description: "API token (from your account security settings)",
                required: true,
                inputType: "password",
                basicPart: "token",
              });
            } else if (scheme.type === "http") {
              authFields.push({
                name: "Authorization",
                location: "headers",
                description: `Bearer token (${schemeName})`,
                required: true,
                inputType: "password",
              });
            } else if (scheme.type === "openIdConnect") {
              authFields.push({
                name: "Authorization",
                location: "headers",
                description: `Bearer token for OpenID Connect (${schemeName})`,
                required: true,
                inputType: "password",
              });
            }
          }
        }

        // ── OAuth2 connector resolution ─────────────────────────
        // Generic — driven by the spec's own securitySchemes or a platform-default
        // provider, so this works for any registered API (RDN, Jira, anything), not
        // a hardcoded vendor.
        let oauthAuthHeader: string | null = null;
        let oauthConnect: { spec_id: string; spec_title: string; connect_url: string } | null = null;
        if (needsOAuth2) {
          if (!effectiveOAuth2) {
            // Spec declares oauth2 but not in a shape we can drive a redirect flow from, and
            // no platform-default provider matches this spec's host — fall back to manual paste.
            authFields.push({
              name: "Authorization",
              location: "headers",
              description: "Bearer token for OAuth2",
              required: true,
              inputType: "password",
            });
          } else {
            const app = await resolveEffectiveOAuthApp(spec_id, tenantId, spec.target_base_url);
            if (!app) {
              // No connector configured for this spec yet — fall back to manual paste.
              authFields.push({
                name: "Authorization",
                location: "headers",
                description: `Bearer token for OAuth2 (${effectiveOAuth2.schemeName}) — or ask an admin to set up the Connect button for this API in the portal`,
                required: true,
                inputType: "password",
              });
            } else {
              const token = await getValidOAuthAccessToken(spec_id, tenantId, effectiveOAuth2.tokenUrl, app);
              if (token) {
                oauthAuthHeader = `Bearer ${token}`;
              } else {
                oauthConnect = {
                  spec_id,
                  spec_title: spec.title,
                  // No spec_id in this URL — real providers (Atlassian, etc.) require one
                  // exact, pre-registered redirect URI shared across every tenant/spec, so
                  // spec_id/tenantId travel inside the signed state instead of the path.
                  connect_url: `${baseUrl()}/api/connectors/oauth/start?state=${encodeURIComponent(signState({ specId: spec_id, tenantId }))}`,
                };
              }
            }
          }
        }

        // 🛑 Mutations NEVER execute through this tool — only a real click on the rendered
        // Execute button can run a write. The model has no way to obtain a valid
        // action_token on its own — it is only ever issued inside this tool's own
        // confirmation card, which means a human already saw this exact request
        // rendered before any token allowing it to run could exist. Passing back
        // anything other than that exact, unmodified token (wrong spec/path/method,
        // forged, or expired) just re-shows the card with a fresh one.
        // GETs that still need auth (no token/credentials resolved) hit this same gate —
        // not because they're unsafe, but because there's nothing to execute yet.
        const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(httpMethod);
        const needsAuthGate = !!oauthConnect || authFields.length > 0;
        const ticket = action_token ? verifyActionTicket(action_token) : null;
        const ticketMatches = !!ticket && ticket.tenantId === tenantId && ticket.specId === spec_id && ticket.path === path && ticket.method === httpMethod;
        if (needsAuthGate || (isMutation && !ticketMatches)) {
          // Seed body from spec example so the UI pre-fills — LLM values take precedence
          const opDef = pathItem?.[httpMethod.toLowerCase()];
          const specExamples = opDef?.requestBody?.content?.["application/json"]?.examples;
          const firstExampleValue: Record<string, unknown> | undefined = specExamples
            ? (Object.values(specExamples)[0] as any)?.value
            : undefined;
          const seededBody = firstExampleValue != null
            ? { ...firstExampleValue, ...(request_body ?? {}) }
            : (request_body ?? null);

          const actionToken = signActionTicket({ tenantId, specId: spec_id, path, method: httpMethod });

          return {
            structuredContent: {
              requiresExecutionInput: true,
              isMutation,
              authFields: authFields.length > 0 ? authFields : null,
              oauthConnect,
              action_token: actionToken,
              spec_id,
              spec_title: spec.title,
              path,
              method: httpMethod,
              query_params: query_params ?? null,
              request_body: seededBody,
              extra_headers: extra_headers ?? null,
            },
            content: [{
              type: "text" as const,
              text: oauthConnect
                ? `${oauthConnect.spec_title} isn't connected yet — the view shows a Connect button, nothing more to say here.`
                : isMutation
                ? `Ready to execute ${httpMethod} ${path} — awaiting a real click on the Execute button in the rendered card. There is no way to perform this write from this tool; do not call it again expecting a different result.`
                : `Ready to execute ${httpMethod} ${path} — authentication required. Awaiting user input in the rendered card.`,
            }],
            isError: false,
          };
        }

        const base = spec.target_base_url.replace(/\/$/, "");
        const apiPath = path.startsWith("/") ? path : `/${path}`;
        const url = new URL(`${base}${apiPath}`);
        if (query_params) {
          for (const [k, v] of Object.entries(query_params)) url.searchParams.set(k, v);
        }

        // Auto-inject saved credentials so the user doesn't re-enter them each call.
        // extra_headers from the caller take precedence (allows override).
        const savedCreds = await getOpenApiCredentials(spec_id, tenantId).catch(() => []);
        const savedHeaders: Record<string, string> = {};
        const savedQueryParams: Record<string, string> = {};
        for (const cred of savedCreds) {
          const field = authFields.find((f: any) => f.name === cred.credential_name);
          if (field?.location === "query_params") {
            savedQueryParams[cred.credential_name] = cred.decrypted_value;
          } else {
            // Default: inject as header (covers apiKey, bearer, basic)
            const isBasicEmail = cred.credential_name === "__basic_email__";
            const isBasicToken = cred.credential_name === "__basic_token__";
            if (isBasicEmail || isBasicToken) {
              // Handled below after both parts are collected
            } else {
              savedHeaders[cred.credential_name] = cred.decrypted_value;
            }
          }
        }
        // Reconstruct Basic auth if both email+token are stored
        const basicEmail = savedCreds.find((c) => c.credential_name === "__basic_email__");
        const basicToken = savedCreds.find((c) => c.credential_name === "__basic_token__");
        if (basicEmail && basicToken) {
          const encoded = Buffer.from(`${basicEmail.decrypted_value}:${basicToken.decrypted_value}`).toString("base64");
          savedHeaders["Authorization"] = `Basic ${encoded}`;
        }
        // OAuth2 connector token (resolved above) takes precedence over any stale saved credential.
        if (oauthAuthHeader) savedHeaders["Authorization"] = oauthAuthHeader;
        // Inject saved query params
        for (const [k, v] of Object.entries(savedQueryParams)) {
          if (!url.searchParams.has(k)) url.searchParams.set(k, v);
        }

        const fetchOpts: RequestInit = {
          method: httpMethod,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Accept-Language": "en",
            ...savedHeaders,
            ...(extra_headers ?? {}),  // caller-supplied always wins
          },
        };
        if (request_body && ["POST", "PUT", "PATCH"].includes(httpMethod)) {
          fetchOpts.body = JSON.stringify(request_body);
        }

        let apiResponse: any;
        let apiStatus = 0;
        let apiOk = false;
        try {
          const res = await fetch(url.toString(), fetchOpts);
          apiStatus = res.status;
          apiOk = res.ok;
          const ct = res.headers.get("content-type") ?? "";
          apiResponse = ct.includes("json") ? await res.json() : await res.text();
        } catch (fetchErr) {
          apiResponse = { error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) };
        }

        // Persist any manually-entered credentials now that they've been accepted — fixes the
        // "asks every time" gap. Skipped for the OAuth2 path (that's saved at connect time) and
        // skipped on auth rejections (don't persist credentials that didn't actually work).
        if (!oauthAuthHeader && apiStatus !== 401 && apiStatus !== 403 && authFields.length > 0) {
          for (const field of authFields) {
            const value = field.location === "query_params" ? query_params?.[field.name] : extra_headers?.[field.name];
            if (!value?.trim()) continue;
            const authType = field.basicPart ? "httpBasic" : field.name.toLowerCase() === "authorization" ? "bearer" : "apiKey";
            await saveOpenApiCredential({
              spec_id,
              tenant_id: tenantId,
              auth_type: authType,
              credential_name: field.name,
              plaintext_value: value,
            }).catch(() => {});
          }
        }

        // 🛑 INTERCEPT AUTH REJECTIONS — re-show form so user can provide credentials
        if (apiStatus === 401 || apiStatus === 403) {
          return {
            structuredContent: {
              requiresExecutionInput: true,
              isMutation: ["POST", "PUT", "PATCH", "DELETE"].includes(httpMethod),
              authFields: authFields.length > 0 ? authFields : ([{
                name: "Authorization",
                location: "headers" as const,
                description: "Bearer or Basic credentials",
                required: true,
                inputType: "password" as const,
              }] as AuthField[]),
              oauthConnect,
              action_token: signActionTicket({ tenantId, specId: spec_id, path, method: httpMethod }),
              spec_id,
              spec_title: spec.title,
              path,
              method: httpMethod,
              query_params: query_params ?? null,
              request_body: request_body ?? null,
              extra_headers: extra_headers ?? null,
              apiError: { status: apiStatus, body: apiResponse },
            },
            content: [{ type: "text" as const, text: `Authentication failed (${apiStatus}). Please provide valid credentials.` }],
            isError: false,
          };
        }

        // 🛑 INTERCEPT CLIENT ERRORS (400, 422, etc.) — bounce back to editable form so user can fix the payload
        if (!apiOk && apiStatus >= 400 && apiStatus < 500) {
          return {
            structuredContent: {
              requiresExecutionInput: true,
              isMutation: ["POST", "PUT", "PATCH", "DELETE"].includes(httpMethod),
              authFields: null,
              action_token: signActionTicket({ tenantId, specId: spec_id, path, method: httpMethod }),
              spec_id,
              spec_title: spec.title,
              path,
              method: httpMethod,
              query_params: query_params ?? null,
              request_body: request_body ?? null,
              extra_headers: extra_headers ?? null,
              apiError: { status: apiStatus, body: apiResponse },
            },
            content: [{
              type: "text" as const,
              text: `API error ${apiStatus} on ${httpMethod} ${path}:\n${typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse, null, 2)}\n\nFix the request body/params based on this exact error and call again in this same turn — don't guess blindly.`,
            }],
            isError: false,
          };
        }

        const responsePreview = Array.isArray(apiResponse)
          ? `[${apiResponse.length} items] ${JSON.stringify(apiResponse.slice(0, 3), null, 2)}${apiResponse.length > 3 ? "\n…" : ""}`
          : JSON.stringify(apiResponse, null, 2);

        const text = [
          `## ${httpMethod} ${url.toString()}`,
          `Status: ${apiStatus}${apiOk ? " ✓" : " ✗"}  |  Spec: ${spec.title}`,
          "",
          "### External API Response",
          "```json",
          responsePreview,
          "```",
        ].filter(Boolean).join("\n");

        // Shape analysis — the view uses this to pick the best renderer automatically
        const responseData: any = apiResponse;
        const isArr = Array.isArray(responseData);
        const sample = isArr ? responseData[0] : responseData;
        const keys: string[] = sample && typeof sample === "object" ? Object.keys(sample) : [];
        const numericKeys = keys.filter((k) => typeof sample[k] === "number");
        const suggestChart = isArr && numericKeys.length > 0 && (responseData as any[]).length <= 50;

        return {
          structuredContent: {
            view: "result",
            spec_title: spec.title,
            display_mode: display_mode ?? "auto",
            api_call: {
              url: url.toString(),
              method: httpMethod,
              status: apiStatus,
              ok: apiOk,
              response: responseData,
            },
            shape: {
              is_array: isArr,
              count: isArr ? (responseData as any[]).length : null,
              keys,
              numeric_keys: numericKeys,
              suggest_chart: suggestChart,
            }
          },
          content: [{ type: "text" as const, text }],
          isError: !apiOk,
        };
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
      }); // traceMcpTool
    },
  );

}
