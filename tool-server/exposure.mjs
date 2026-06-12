const RANGE_BASE_KM = 120;
const RANGE_MIN_KM = 30;
const RANGE_MAX_KM = 500;

const ZONE_FRAC = { critical: 0.2, high: 0.4, medium: 0.66, low: 1.0 };
const SEVERITY = ["critical", "high", "medium", "low"]; // index 0 = most severe

const THREAT_BASE = { critical: 80, high: 55, medium: 30, low: 10 };
const RISK_REDUCTION = { critical: 75, high: 60, medium: 45, low: 30 };

export const severityOf = (impactE) =>
  impactE >= 10 ? "critical" : impactE >= 1 ? "high" : impactE >= 0.1 ? "medium" : "low";

export const outerRangeKm = (impactE) =>
  Math.min(RANGE_MAX_KM, Math.max(RANGE_MIN_KM, RANGE_BASE_KM * Math.cbrt(Math.max(impactE, 0))));

const WAYPOINT_MARGIN_KM = 25; // clearance added beyond the zone boundary
const KM_PER_DEG_LAT = 111.32;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round6 = (n) => Math.round(n * 1e6) / 1e6 + 0; // `+ 0` normalises -0 → 0

const toNum = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const vesselPath = (vessel) => {
  const r = vessel.route;
  if (Array.isArray(r) && r.length >= 2) {
    const pts = r
      .filter((p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .map((p) => ({ lat: p.latitude, lon: p.longitude }));
    if (pts.length >= 2) return pts;
  }
  const d = vessel.destination;
  if (d && Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) {
    return [
      { lat: vessel.latitude, lon: vessel.longitude },
      { lat: d.latitude, lon: d.longitude },
    ];
  }
  return null;
};

const waypointEndpoints = (vessel) => {
  const O = { lat: vessel.latitude, lon: vessel.longitude };
  const d = vessel.destination;
  if (d && Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) {
    return [O, { lat: d.latitude, lon: d.longitude }];
  }
  const r = vessel.route;
  if (Array.isArray(r) && r.length >= 2) {
    const last = r[r.length - 1];
    if (last && Number.isFinite(last.latitude) && Number.isFinite(last.longitude)) {
      return [O, { lat: last.latitude, lon: last.longitude }];
    }
  }
  return null;
};

const closestApproach = (path, fLat, fLon) => {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((fLat * Math.PI) / 180) || 1e-9;
  const toXY = (p) => [(p.lon - fLon) * kmPerDegLon, (p.lat - fLat) * KM_PER_DEG_LAT];
  const xy = path.map(toXY);
  let best = null; // { dist, P, u }
  for (let i = 0; i < xy.length - 1; i++) {
    const A = xy[i];
    const B = xy[i + 1];
    const AB = [B[0] - A[0], B[1] - A[1]];
    const ab2 = AB[0] ** 2 + AB[1] ** 2;
    if (ab2 < 1e-9) continue; // skip degenerate (duplicate) waypoints
    let t = (-A[0] * AB[0] + -A[1] * AB[1]) / ab2; // foot of perpendicular from F (origin)
    t = Math.max(0, Math.min(1, t));
    const P = [A[0] + t * AB[0], A[1] + t * AB[1]];
    const dist = Math.hypot(P[0], P[1]);
    if (!best || dist < best.dist) {
      const abLen = Math.sqrt(ab2);
      best = { dist, P, u: [AB[0] / abLen, AB[1] / abLen] };
    }
  }

  if (!best) {
    const P = xy[0];
    best = { dist: Math.hypot(P[0], P[1]), P, u: [1, 0] };
  }
  return { kmPerDegLon, start: xy[0], dist: best.dist, P: best.P, u: best.u };
};

const parseFireballs = (resp) => {
  const fields = resp.fields ?? [];
  const idx = (name) => fields.indexOf(name);
  const iDate = idx("date");
  const iImpact = idx("impact-e");
  const iEnergy = idx("energy");
  const iLat = idx("lat");
  const iLatDir = idx("lat-dir");
  const iLon = idx("lon");
  const iLonDir = idx("lon-dir");

  const out = [];
  for (const row of resp.data ?? []) {
    const lat = toNum(row[iLat]);
    const lon = toNum(row[iLon]);
    if (lat === null || lon === null) continue; // malformed/no-location row → skip
    const latSign = (row[iLatDir] ?? "N") === "S" ? -1 : 1;
    const lonSign = (row[iLonDir] ?? "E") === "W" ? -1 : 1;
    const impactE = toNum(row[iImpact]) ?? 0;
    const date = row[iDate] ?? "";
    out.push({
      id: date || `FB-${out.length + 1}`,
      date,
      lat: lat * latSign,
      lon: lon * lonSign,
      impactE,
      energy: toNum(row[iEnergy]) ?? 0,
    });
  }
  return out;
};

const assessVessel = (vessel, fireballs) => {
  const path = vesselPath(vessel);
  if (!path) return null; // no voyage to assess
  let best = null; // { rank, level, eventId, distanceKm, eventLat, eventLon, zoneRadiusKm, geom }
  for (const f of fireballs) {
    const geom = closestApproach(path, f.lat, f.lon);
    const dist = geom.dist;
    const outer = outerRangeKm(f.impactE);
    for (let rank = 0; rank < SEVERITY.length; rank++) {
      const level = SEVERITY[rank];
      if (dist <= outer * ZONE_FRAC[level]) {
        if (!best || rank < best.rank || (rank === best.rank && dist < best.distanceKm)) {
          best = {
            rank,
            level,
            eventId: f.id,
            distanceKm: dist,
            eventLat: f.lat,
            eventLon: f.lon,
            zoneRadiusKm: outer * ZONE_FRAC[level], // radius of the zone the voyage enters
            geom,
          };
        }
        break; // most-severe zone for this fireball found
      }
    }
  }
  if (!best) return null;
  return {
    criticality: best.level,
    nearestEventId: best.eventId,
    distanceKm: best.distanceKm,
    eventLat: best.eventLat,
    eventLon: best.eventLon,
    zoneRadiusKm: best.zoneRadiusKm,
    geom: best.geom,
  };
};

const circleRing = (lat, lon, radiusKm, segments = 64) => {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180) || 1e-9;
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    const dxKm = radiusKm * Math.cos(a); // east
    const dyKm = radiusKm * Math.sin(a); // north
    ring.push([round6(lon + dxKm / kmPerDegLon), round6(lat + dyKm / KM_PER_DEG_LAT)]);
  }
  return ring;
};

const hazardZonePolygon = (eventId, lat, lon, radiusKm, criticality) => ({
  id: `meteor-${eventId}`,
  name: `Meteor hazard zone (${criticality})`,
  type: "nogo",
  geojson: {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [circleRing(lat, lon, radiusKm)] },
    properties: { eventId, criticality, radiusKm: Math.round(radiusKm * 10) / 10 },
  },
  notes: `${criticality} debris hazard zone around fireball ${eventId} (radius ${Math.round(radiusKm)} km).`,
  order: 0,
});

const computeSafeWaypoint = (geom, fLat, fLon, clearKm) => {
  const { kmPerDegLon, start, P, u, dist: dmin } = geom;

  let n = [-u[1], u[0]];
  if (P[0] * n[0] + P[1] * n[1] < 0) n = [-n[0], -n[1]];

  const pAlong = P[0] * u[0] + P[1] * u[1];
  const h = clearKm > dmin ? Math.sqrt(clearKm * clearKm - dmin * dmin) : 0;

  const startDist = Math.hypot(start[0], start[1]);
  const edge = startDist <= clearKm ? +h : -h;

  const wx = clearKm * n[0] + (pAlong + edge) * u[0];
  const wy = clearKm * n[1] + (pAlong + edge) * u[1];
  return {
    latitude: round4(fLat + wy / KM_PER_DEG_LAT),
    longitude: round4(fLon + wx / kmPerDegLon),
  };
};

export const assessExposure = (fireballsResponse, vessels) => {
  const fireballs = parseFireballs(fireballsResponse);
  const affectedVessels = [];

  for (const v of vessels ?? []) {
    const hit = assessVessel(v, fireballs);
    if (hit) {
      const prev = zoneByEvent.get(hit.nearestEventId);
      if (!prev || hit.zoneRadiusKm > prev.radiusKm) {
        zoneByEvent.set(hit.nearestEventId, {
          lat: hit.eventLat,
          lon: hit.eventLon,
          radiusKm: hit.zoneRadiusKm,
          criticality: hit.criticality,
        });
      }
      const entry = {
        id: v.id,
        name: v.name,
        latitude: v.latitude,
        longitude: v.longitude,
        criticality: hit.criticality,
        nearestEventId: hit.nearestEventId,
        distanceKm: Math.round(hit.distanceKm * 10) / 10,
      };

      const ends = waypointEndpoints(v);
      const wpGeom = ends ? closestApproach(ends, hit.eventLat, hit.eventLon) : hit.geom;
      entry.safeWaypoint = computeSafeWaypoint(
        wpGeom,
        hit.eventLat,
        hit.eventLon,
        hit.zoneRadiusKm + WAYPOINT_MARGIN_KM,
      );
      affectedVessels.push(entry);
    }
  }

  const affectedAssetCount = affectedVessels.length;
  if (affectedAssetCount === 0) {
    return {
      affectedVessels: [],
      affectedAssetCount: 0,
      threatScore: 0,
      estimatedRiskReductionPercent: 0,
      worstEventId: null,
      hazardZones: [],
      summary: "No watched voyage crosses any fireball hazard zone.",
    };
  }

  // One nogo-zone polygon per affected fireball event, for the reroute map.
  const hazardZones = [...zoneByEvent.entries()].map(([eventId, z]) =>
    hazardZonePolygon(eventId, z.lat, z.lon, z.radiusKm, z.criticality),
  );

  // Worst affected vessel = lowest severity rank.
  const worst = affectedVessels.reduce((acc, v) =>
    SEVERITY.indexOf(v.criticality) < SEVERITY.indexOf(acc.criticality) ? v : acc,
  );
  const threatScore = Math.min(
    100,
    THREAT_BASE[worst.criticality] + Math.max(0, affectedAssetCount - 1) * 5,
  );
  const estimatedRiskReductionPercent = RISK_REDUCTION[worst.criticality];

  return {
    affectedVessels,
    affectedAssetCount,
    threatScore,
    estimatedRiskReductionPercent,
    worstEventId: worst.nearestEventId,
    hazardZones,
    summary: `${affectedAssetCount} voyage(s) crossing the ${worst.criticality} hazard zone of fireball ${worst.nearestEventId}.`,
  };
};
