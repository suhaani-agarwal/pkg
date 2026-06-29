import { z } from "zod";
import type { McpServer } from "skybridge/server";
import {
  updateAlertStatus,
} from "../data/data-service.js";
import { getMcpUser, getMcpSessionId } from "../data/mcp-context.js";
import { traceMcpTool } from "../utils/langfuse.js";
import { jsonOk, jsonErr } from "./types.js";
import { decode } from "../data/path-encoder.js";


function safeDecodePath(row: any): any {
  if (row.path_encoded && !Array.isArray(row.path)) {
    try { return { ...row, path: decode(row.path_encoded) }; }
    catch { return { ...row, path: [] }; }
  }
  return row;
}

const OSM_CSP = { resourceDomains: ["https://tile.openstreetmap.org", "https://unpkg.com"] };

export function registerFleetTools(server: McpServer): void {
  // ── fleet_map ─────────────────────────────────────────────
  // Three modes auto-detected from rows + mode param:
  //   fleet      — all vehicles as markers with sidebar (query fleet_vehicles with lat, lon)
  //   vehicle    — single vehicle zoomed in with detail card (query fleet_vehicles filtered by VIN)
  //   congestion — active trip paths colored by overlap count (query fleet_trips with path_encoded)
  server.registerTool(
    {
      name: "fleet_map",
      description: `Show an interactive map. Choose mode based on what the user wants.
For query patterns and exact field names per mode: read skill://schema-pg (Fleet Map section).

MODE "fleet" (default) — All vehicles on map with sidebar + status filter. Row shape: { vin, plate, make, model, year, status, lat, lon, fuel_level_pct, odometer, current_driver_id }. Merge dealer_locations rows ({ id, name, lat, lon, geofence_radius_mi, address }) into the same rows[] to show geofence circles.

MODE "vehicle" — Single vehicle focused with detail card. Row shape: vehicle row (with lat/lon) + optional active trip row (with path_encoded). Set focus_vin to the VIN.

MODE "congestion" — Trip paths colored by route overlap (green=low, red=high). Row shape: fleet_trips { id, vehicle_id, status, distance_mi, path_encoded, started_at }.

MODE "recovery" — OOT recovery prediction with night/day recommendation pins and confidence circles. Requires TWO batched queries in one query_data call (vehicle_recovery telemetry event + vehicle row). Merge both into rows[], set focus_vin.`,
      inputSchema: {
        rows: z.array(z.any()).describe("Rows from query_data — vehicle rows for fleet/vehicle mode, trip rows for congestion mode, vehicle_recovery telemetry_events row (+ optional vehicle row) for recovery mode"),
        mode: z.enum(["fleet", "vehicle", "congestion", "recovery"]).optional().default("fleet").describe("Map mode: 'fleet' (all vehicles), 'vehicle' (single vehicle detail), 'congestion' (trip path heatmap), 'recovery' (out-of-trust recovery prediction)"),
        focus_vin: z.string().optional().describe("VIN to pan to on load (fleet + vehicle + recovery modes)"),
        filter_status: z.string().optional().describe("Client-side status filter for fleet mode: active, idle, maintenance, offline"),
      },
      view: {
        component: "fleet-map",
        description: "Interactive fleet map — vehicles, trip paths, single-vehicle detail, route congestion heatmap",
        csp: OSM_CSP,
      },
    },
    async ({ rows, mode = "fleet", focus_vin, filter_status }) => {
      const mcpUser = getMcpUser();
      return traceMcpTool("fleet_map", mcpUser?.email ?? null, getMcpSessionId(), { mode, focus_vin, row_count: (rows as any[]).length }, async () => {
      try {
        if (mode === "vehicle") {
          const vehicle = rows.find((r: any) => r.vin === focus_vin && r.lat !== undefined)
            ?? rows.find((r: any) => r.lat !== undefined);
          if (!vehicle) return jsonErr(`No vehicle with coordinates found in rows${focus_vin ? ` for VIN ${focus_vin}` : ""}`);
          const tripRows = rows.filter((r: any) => r.path_encoded !== undefined || (Array.isArray(r.path) && r.path.length > 0));
          const rawTrip = tripRows.find((t: any) => t.vehicle_id === (focus_vin ?? vehicle.vin) && t.status === "active")
            ?? tripRows[0] ?? null;
          const currentTrip = rawTrip ? safeDecodePath(rawTrip) : null;
          return jsonOk({ mode: "vehicle", vehicle, currentTrip });
        }

        if (mode === "recovery") {
          const isRecoveryRow = (r: any) => r.data_payload !== undefined;
          const recoveryRow = (focus_vin ? rows.find((r: any) => isRecoveryRow(r) && r.vin === focus_vin) : undefined)
            ?? rows.find(isRecoveryRow);
          if (!recoveryRow) return jsonErr(`No vehicle_recovery event found in rows${focus_vin ? ` for VIN ${focus_vin}` : ""}`);
          const payload = typeof recoveryRow.data_payload === "string"
            ? JSON.parse(recoveryRow.data_payload)
            : recoveryRow.data_payload;
          const recoveryVin = recoveryRow.vin ?? focus_vin ?? null;
          const vehicle = rows.find((r: any) => r.vin === recoveryVin && !isRecoveryRow(r)) ?? null;
          return jsonOk({ mode: "recovery", vin: recoveryVin, vehicle, timestamp: recoveryRow.timestamp, recovery: payload });
        }

        if (mode === "congestion") {
          const decoded = rows.map(safeDecodePath);
          const withOverlap = decoded.map((t: any) => {
            const path: [number, number][] = Array.isArray(t.path) ? t.path : [];
            if (path.length === 0) return { ...t, overlapCount: 1 };
            const [tMinLat, tMaxLat] = [Math.min(...path.map((p) => p[0])), Math.max(...path.map((p) => p[0]))];
            const [tMinLon, tMaxLon] = [Math.min(...path.map((p) => p[1])), Math.max(...path.map((p) => p[1]))];
            const overlap = decoded.filter((other: any) => {
              if (other.id === t.id) return false;
              const op: [number, number][] = Array.isArray(other.path) ? other.path : [];
              if (op.length === 0) return false;
              const oMinLat = Math.min(...op.map((p) => p[0]));
              const oMaxLat = Math.max(...op.map((p) => p[0]));
              const oMinLon = Math.min(...op.map((p) => p[1]));
              const oMaxLon = Math.max(...op.map((p) => p[1]));
              return tMinLat <= oMaxLat && tMaxLat >= oMinLat && tMinLon <= oMaxLon && tMaxLon >= oMinLon;
            }).length;
            return { ...t, overlapCount: overlap + 1 };
          });
          const maxOverlap = withOverlap.reduce((m: number, t: any) => Math.max(m, t.overlapCount ?? 1), 1);
          return jsonOk({ mode: "congestion", trips: withOverlap, totalActiveTrips: rows.length, maxOverlap });
        }

        // fleet mode (default)
        const isDealerRow = (r: any) => r.geofence_radius_mi !== undefined;
        const dealers = rows.filter(isDealerRow);
        const allVehicles = rows.filter((r: any) => !isDealerRow(r) && r.lat !== undefined && r.lon !== undefined);
        const rawTripRows = rows.filter((r: any) => !isDealerRow(r) && (r.path_encoded !== undefined || (Array.isArray(r.path) && r.path.length > 0)));
        const tripRows = rawTripRows.map(safeDecodePath);
        const filtered = filter_status ? allVehicles.filter((v: any) => v.status === filter_status) : allVehicles;
        return jsonOk({ mode: "fleet", vehicles: filtered, trips: tripRows, dealers, focusVin: focus_vin ?? null });
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
      }); // traceMcpTool
    },
  );

  // ── get_vehicle_distance ──────────────────────────────────
  server.registerTool(
    {
      name: "get_vehicle_distance",
      description: "Calculate total distance driven by a vehicle. REQUIRES rows from query_data first: query_data({ graphql: 'query { fleet_trips(where: { vehicle_id: { _eq: \"V001\" }, status: { _eq: \"completed\" } }) { distance_mi started_at ended_at } }' }), then pass rows here.",
      inputSchema: {
        rows: z.array(z.any()).describe("Trip rows from query_data (fleet_trips table, completed only)"),
        vin: z.string().optional().describe("VIN label for the response header"),
      },
    },
    async ({ rows, vin }) => {
      try {
        const total = rows.reduce((s: number, t: any) => s + (t.distance_mi ?? 0), 0);
        return jsonOk({ vin, total_distance: Math.round(total * 10) / 10, distance_units: "mi", trip_count: rows.length });
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );


  // ── update_alert_status ───────────────────────────────────
  server.registerTool(
    {
      name: "update_alert_status",
      description: "Acknowledge or resolve an alert.",
      inputSchema: {
        alert_id: z.string(),
        status: z.enum(["acknowledged", "resolved"]),
      },
    },
    async ({ alert_id, status }) => {
      try {
        const alert = await updateAlertStatus(alert_id, status);
        if (!alert) throw new Error(`Alert ${alert_id} not found`);
        return jsonOk({ success: true, alert });
      } catch (e) {
        return jsonErr(e instanceof Error ? e.message : "Unknown error");
      }
    },
  );

}
