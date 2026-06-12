import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assessExposure } from "./exposure.mjs";
import { buildKML } from "./kml.mjs";
import {
  uploadCustomZoneKml,
  createCustomZone,
  pushKmlAsCustomZone,
} from "./smartship.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 9001;
const NASA_FIREBALL_API =
  process.env.NASA_FIREBALL_API || "https://ssd-api.jpl.nasa.gov/fireball.api?limit=10";

const openapi = readFileSync(join(__dirname, "openapi.json"), "utf8");

// Hero demo vessel: a REAL stage vessel with an active voyage leg, so the
// voyage_* routing tools have backend data to reroute it. Position + destination
// confirmed live from the platform. The DEMO_FIREBALL below is positioned ~25 km
// away so meteor_assess_exposure flags this vessel as critical.
const FLEET = [
  {
    id: "9643881",
    name: "Harvest Time",
    latitude: 21.88,
    longitude: -111.54,
    destination: { name: "Tumaco", latitude: 1.83, longitude: -78.74 },
  },
];

// Original synthetic fleet — kept for reference / multi-vessel demos.
// const FLEET = [
//   { id: "IMO-9123456", name: "Anna Maria", latitude: 42.1, longitude: -70.4, destination: { name: "Rotterdam", latitude: 51.95, longitude: 4.14 } },
//   { id: "IMO-9234567", name: "Northern Star", latitude: 31.2, longitude: 131.4, destination: { name: "Yokohama", latitude: 35.45, longitude: 139.66 } },
//   { id: "538001234", name: "Atlas Polaris", latitude: 56.85, longitude: 172.8, destination: { name: "Dutch Harbor", latitude: 53.89, longitude: -166.54 } },
//   { id: "538889911", name: "Aurora Drift", latitude: 56.9, longitude: 174.0, destination: { name: "Busan", latitude: 35.1, longitude: 129.04 } },
//   { id: "IMO-9345678", name: "Pacific Envoy", latitude: 38.0, longitude: -64.5, destination: { name: "New York", latitude: 40.7, longitude: -74.0 } },
//   { id: "IMO-9456789", name: "Cape Meridian", latitude: -45.4, longitude: -110.2, destination: { name: "Valparaiso", latitude: -33.04, longitude: -71.62 } },
//   { id: "IMO-9567890", name: "Baltic Crown", latitude: 46.5, longitude: 133.2, destination: { name: "Vladivostok", latitude: 43.12, longitude: 131.89 } },
//   { id: "IMO-9678901", name: "Coral Sentinel", latitude: -38.0, longitude: -64.7, destination: { name: "Buenos Aires", latitude: -34.6, longitude: -58.37 } },
// ];

// Synthetic high-impact fireball positioned on Harvest Time's voyage, off the
// Pacific coast of southern Mexico (14°57'31"N, 99°57'10"W). High impact energy so
// the voyage crosses the critical hazard zone. Injected into the
// meteor_get_fireballs response by field name so it aligns with NASA's column
// order regardless of how the live API orders `fields`.
const DEMO_FIREBALL = {
  date: "2026-06-11 12:00:00",
  energy: "500",
  "impact-e": "50",
  lat: "14.9586",
  "lat-dir": "N",
  lon: "99.9528",
  "lon-dir": "W",
  alt: "30",
  vel: "18",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function getFireballs(query) {
  const base = new URL(NASA_FIREBALL_API);
  base.searchParams.set("req-loc", "true");
  base.searchParams.set("sort", "-date");
  if (query.get("date_min")) base.searchParams.set("date-min", query.get("date_min"));
  if (query.get("date_max")) base.searchParams.set("date-max", query.get("date_max"));
  if (query.get("energy_min")) base.searchParams.set("energy-min", query.get("energy_min"));
  base.searchParams.set("limit", query.get("limit") || base.searchParams.get("limit") || "50");

  const url = base.toString();
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`NASA Fireball API returned ${resp.status} for ${url} — ${body}`);
  }
  const data = await resp.json();
  return injectDemoFireball(data);
}

// Prepend the demo fireball, mapping its values onto the live `fields` order so
// the synthetic row aligns with real NASA rows. Newest-first, so it leads.
function injectDemoFireball(data) {
  const fields = data.fields ?? [];
  const row = fields.map((f) => DEMO_FIREBALL[f] ?? null);
  data.data = [row, ...(data.data ?? [])];
  if (data.count !== undefined) {
    data.count = String(Number(data.count) + 1);
  }
  return data;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(openapi);
    }

    if (req.method === "GET" && path === "/fireballs") {
      const data = await getFireballs(url.searchParams);
      return sendJson(res, 200, data);
    }

    if (req.method === "GET" && path === "/vessels") {
      return sendJson(res, 200, { vessels: FLEET });
    }

    if (req.method === "POST" && path === "/response/decision") {
      const body = await readBody(req);
      if (!body.decision) {
        return sendJson(res, 400, { error: "Missing required field 'decision'." });
      }
      return sendJson(res, 200, {
        eventId: body.eventId ?? null,
        decision: body.decision,
        recordedAt: new Date().toISOString(),
      });
    }

    if (req.method === "GET" && path === "/kml") {
      const data = await getFireballs(url.searchParams);
      const kml = buildKML(data);
      const payload = Buffer.from(kml, "utf8");
      const dataDir = join(__dirname, "../data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "fireballs.kml"), payload);
      res.writeHead(200, {
        "Content-Type": "application/vnd.google-earth.kml+xml",
        "Content-Length": payload.length,
        "Content-Disposition": 'attachment; filename="fireballs.kml"',
      });
      return res.end(payload);
    }


    if (req.method === "POST" && path === "/exposure") {
      const body = await readBody(req);
      if (!body.fireballs || !Array.isArray(body.vessels)) {
        return sendJson(res, 400, {
          error: "Body must include 'fireballs' (get_fireballs response) and 'vessels' (array).",
        });
      }
      return sendJson(res, 200, assessExposure(body.fireballs, body.vessels));
    }

    // --- SMARTShip geo-custom-zone integration ---

    // Upload raw KML to SMARTShip; returns parsed boundaries/color/name.
    // Body = raw KML text. Optional ?filename=foo.kml
    if (req.method === "POST" && path === "/smartship/custom-zone/upload") {
      const buf = await readRaw(req);
      if (!buf.length) return sendJson(res, 400, { error: "Empty body; expected raw KML." });
      const filename = url.searchParams.get("filename") || "fireballs.kml";
      const out = await uploadCustomZoneKml(buf, filename);
      return sendJson(res, 200, out);
    }

    // Create a custom zone from a JSON payload (passthrough to SMARTShip).
    // Body = { company_id, user_id, zone_name, zone_color, zone_permission, boundary }.
    if (req.method === "POST" && path === "/smartship/custom-zone") {
      const body = await readBody(req);
      const out = await createCustomZone(body);
      return sendJson(res, 200, out);
    }

    // One-shot: generate the current fireball-hazard KML and push it to
    // SMARTShip as a custom zone. Body (optional) = { company_id, user_id,
    // zone_name, zone_color }. Reuses the same fireball query params as /kml.
    if (req.method === "POST" && path === "/smartship/push-hazard-zones") {
      const body = await readBody(req);
      const data = await getFireballs(url.searchParams);
      const kml = Buffer.from(buildKML(data), "utf8");
      const out = await pushKmlAsCustomZone(kml, body);
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: `No route for ${req.method} ${path}` });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message ?? "Internal error" });
  }
});

async function generateAndSaveKML() {
  try {
    const data = await getFireballs(new URLSearchParams());
    const kml = buildKML(data);
    const dataDir = join(__dirname, "../data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "fireballs.kml"), Buffer.from(kml, "utf8"));
    console.log(`[kml] fireballs.kml updated at ${new Date().toISOString()}`);
  } catch (err) {
    console.error(`[kml] failed to generate: ${err.message}`);
  }
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

server.listen(PORT, () => {
  console.log(`Meteor tool server listening on http://localhost:${PORT}`);
  console.log(`OpenAPI spec at http://localhost:${PORT}/openapi.json`);
  generateAndSaveKML();
  setInterval(generateAndSaveKML, SIX_HOURS);
});