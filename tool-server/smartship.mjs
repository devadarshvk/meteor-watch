
const AUTH_TOKEN_URL = process.env.ONBOARDING_AUTH_TOKEN_URL;
const SERVER_URL = process.env.SMARTSHIP_SERVER_URL;
const API_VERSION = process.env.SMARTSHIP_API_VERSION || "v1.2";
const AUDIENCE = process.env.SMARTSHIP_AUDIENCE;
const CLIENT_ID = process.env.SMARTSHIP_CLIENT_ID;
const CLIENT_SECRET = process.env.SMARTSHIP_CLIENT_SECRET;
const TENANT = process.env.SMARTSHIP_TENANT || "0north";

const DEFAULT_COMPANY_ID = process.env.SMARTSHIP_COMPANY_ID || "";
const DEFAULT_USER_ID = process.env.SMARTSHIP_USER_ID || "";

const base = () => `${SERVER_URL.replace(/\/$/, "")}/${API_VERSION}/geo-custom-zone`;

function requireEnv() {
  const missing = [];
  if (!AUTH_TOKEN_URL) missing.push("ONBOARDING_AUTH_TOKEN_URL");
  if (!SERVER_URL) missing.push("SMARTSHIP_SERVER_URL");
  if (!CLIENT_ID) missing.push("SMARTSHIP_CLIENT_ID");
  if (!CLIENT_SECRET) missing.push("SMARTSHIP_CLIENT_SECRET");
  if (missing.length) {
    throw new Error(`SMARTShip config missing in .env: ${missing.join(", ")}`);
  }
}

let _token = null;
let _tokenExp = 0; // epoch ms

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export async function getAccessToken(force = false) {
  requireEnv();
  const now = Date.now();
  if (!force && _token && now < _tokenExp - 60_000) return _token;

  const resp = await fetch(AUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: AUDIENCE,
      tenant: TENANT,
    }),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`api-login ${resp.status} at ${AUTH_TOKEN_URL} — ${text}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`api-login returned non-JSON: ${text.slice(0, 200)}`);
  }
  const token = data.access_token || data.token;
  if (!token) {
    throw new Error(`api-login response had no access_token: ${text.slice(0, 200)}`);
  }
  _token = token;
  _tokenExp = decodeJwtExp(token) || now + 50 * 60_000; // fallback 50min
  return token;
}

async function authedFetch(url, opts = {}) {
  const token = await getAccessToken();
  const headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  let resp = await fetch(url, { ...opts, headers });
  // One retry on 401 with a fresh token (handles stale-cache edge).
  if (resp.status === 401) {
    const fresh = await getAccessToken(true);
    resp = await fetch(url, {
      ...opts,
      headers: { ...headers, Authorization: `Bearer ${fresh}` },
    });
  }
  return resp;
}

export async function uploadCustomZoneKml(kmlBuffer, filename = "fireballs.kml") {
  if (!filename.endsWith(".kml")) {
    throw new Error("filename must end in .kml (SMARTShip rejects other extensions)");
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([kmlBuffer], { type: "application/vnd.google-earth.kml+xml" }),
    filename
  );
  const resp = await authedFetch(`${base()}/upload`, { method: "POST", body: form });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`upload ${resp.status} — ${text.slice(0, 300)}`);
  return JSON.parse(text); // { status, data: { boundary, zone_color, zone_name } }
}

export async function createCustomZone({
  company_id = DEFAULT_COMPANY_ID,
  user_id = DEFAULT_USER_ID,
  zone_name,
  zone_color = "#a3a6a2",
  zone_permission = [],
  boundary,
}) {
  if (!company_id || !user_id) {
    throw new Error("createCustomZone needs company_id and user_id (set in .env or pass them)");
  }
  if (!Array.isArray(boundary) || !boundary.length) {
    throw new Error("createCustomZone needs a non-empty boundary array");
  }
  const body = { company_id, user_id, zone_name, zone_color, zone_permission, boundary };
  const resp = await authedFetch(base(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`create ${resp.status} — ${text.slice(0, 300)}`);
  return JSON.parse(text); // { status: 'OK', data: <zoneId> }
}

export async function pushKmlAsCustomZone(kmlBuffer, opts = {}) {
  const uploaded = await uploadCustomZoneKml(kmlBuffer, opts.filename);
  const parsed = uploaded.data || uploaded;
  const zoneName = opts.zone_name || parsed.zone_name || "Meteor Hazard Zone";
  const boundary = (parsed.boundary || []).map((b, i) => ({
    boundary_name: b.name || b.boundary_name || `${zoneName} ${i + 1}`,
    coordinates: b.coordinates,
  }));
  const created = await createCustomZone({
    ...opts,
    zone_name: zoneName,
    zone_color: opts.zone_color || parsed.zone_color || "#d65c6b",
    boundary,
  });
  return { uploaded: parsed, created, zoneId: created.data };
}
