// Zone math ported from
// zap-widgets/src/meteor/components/meteor-fireball-map.layers.ts —
// KEEP THESE CONSTANTS IN SYNC with that file so server numbers match the map.

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

const toNum = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Closest approach (km) of the voyage leg O→D to a fireball at (fLat,fLon).
// Equirectangular frame centred on the fireball — accurate in the zone's vicinity,
// which is all that matters for the minimum. Used so a voyage is flagged when its
// PATH crosses a hazard zone, not only when the vessel currently sits inside one.
const segmentDistanceKm = (oLat, oLon, dLat, dLon, fLat, fLon) => {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((fLat * Math.PI) / 180);
  const toXY = (lat, lon) => [(lon - fLon) * kmPerDegLon, (lat - fLat) * KM_PER_DEG_LAT];
  const O = toXY(oLat, oLon);
  const D = toXY(dLat, dLon);
  const AB = [D[0] - O[0], D[1] - O[1]];
  const ab2 = AB[0] ** 2 + AB[1] ** 2 || 1e-9;
  let t = (-O[0] * AB[0] + -O[1] * AB[1]) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(O[0] + t * AB[0], O[1] + t * AB[1]);
};

// NASA columnar response → signed-coordinate fireball records.
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

// Most-severe zone a vessel's VOYAGE enters across all detections.
// Exposure is judged purely on the planned voyage leg (current position →
// destination): a vessel is flagged when that PATH crosses a zone, so a ship
// heading into a zone is caught before it arrives. A vessel already sitting in a
// zone with nowhere to go is not actionable, so a vessel without a destination is
// not assessed (returns null). Distance is the closest approach of the leg to the
// fireball. Returns null when clear, else { criticality, nearestEventId, distanceKm }.
const assessVessel = (vessel, fireballs) => {
  const dest = vessel.destination;
  if (!dest || !Number.isFinite(dest.latitude) || !Number.isFinite(dest.longitude)) {
    return null; // no voyage leg → nothing to reroute
  }
  let best = null; // { rank, level, eventId, distanceKm, eventLat, eventLon, zoneRadiusKm }
  for (const f of fireballs) {
    const dist = segmentDistanceKm(vessel.latitude, vessel.longitude, dest.latitude, dest.longitude, f.lat, f.lon);
    const outer = outerRangeKm(f.impactE);
    for (let rank = 0; rank < SEVERITY.length; rank++) {
      const level = SEVERITY[rank];
      if (dist <= outer * ZONE_FRAC[level]) {
        // pick more-severe rank; tie-break on nearer distance
        if (!best || rank < best.rank || (rank === best.rank && dist < best.distanceKm)) {
          best = {
            rank,
            level,
            eventId: f.id,
            distanceKm: dist,
            eventLat: f.lat,
            eventLon: f.lon,
            zoneRadiusKm: outer * ZONE_FRAC[level], // radius of the zone the vessel sits inside
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
  };
};

// Margin (km) added beyond the hazard-zone boundary when placing a detour
// waypoint, so the routed leg stays clearly outside the zone.
const WAYPOINT_MARGIN_KM = 25;
const KM_PER_DEG_LAT = 111.32;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const round6 = (n) => Math.round(n * 1e6) / 1e6 + 0; // `+ 0` normalises -0 → 0

// GeoJSON ring approximating a circle of `radiusKm` centred on (lat,lon).
// Returns a closed ring of [lon, lat] pairs (first == last), matching the
// route_comparison widget's activePolygons geometry (GeoJSON Polygon).
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

// Build a route_comparison-compatible ActivePolygon ("nogo" zone) for a meteor
// hazard circle, so the operator sees the zone the reroute is steering clear of.
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

// Compute a single via-point that pulls a route clear of a circular hazard zone
// centred on (fLat,fLon). Works in a local equirectangular frame with the
// fireball at the origin. Two cases, both offset to the safe side by `clearKm`:
//   • Vessel already INSIDE the zone → place the waypoint at the FAR (exit) edge,
//     forward toward the destination, so the ship steers to the side away from the
//     fireball and exits moving toward port (no backtracking).
//   • Vessel still OUTSIDE but its voyage crosses the zone → place the waypoint at
//     the NEAR (approach) edge, so the route turns off its original line *before*
//     it would enter the zone.
// Because the destination is far down-track, the onward leg stays clear either way.
const computeSafeWaypoint = (oLat, oLon, dLat, dLon, fLat, fLon, clearKm) => {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((fLat * Math.PI) / 180);
  const toXY = (lat, lon) => [(lon - fLon) * kmPerDegLon, (lat - fLat) * KM_PER_DEG_LAT];
  const O = toXY(oLat, oLon);
  const D = toXY(dLat, dLon);
  const AB = [D[0] - O[0], D[1] - O[1]];
  const ab2 = AB[0] ** 2 + AB[1] ** 2 || 1e-9;
  const abLen = Math.sqrt(ab2);
  const u = [AB[0] / abLen, AB[1] / abLen]; // unit heading origin→destination
  // Closest approach of the route to the fireball (origin), clamped to the segment.
  let t = (-O[0] * AB[0] + -O[1] * AB[1]) / ab2;
  t = Math.max(0, Math.min(1, t));
  const P = [O[0] + t * AB[0], O[1] + t * AB[1]]; // foot of perpendicular from F
  const dmin = Math.hypot(P[0], P[1]); // distance from fireball to the route line
  // Safe radial direction: from the fireball outward to the route line.
  const safe = dmin > 1e-6 ? [P[0] / dmin, P[1] / dmin] : [-u[1], u[0]];
  // Half-chord: along-track distance from closest approach to the avoidance-circle
  // boundary (near edge one h back, exit edge one h forward).
  const h = clearKm > dmin ? Math.sqrt(clearKm * clearKm - dmin * dmin) : 0;
  // Inside the zone → exit edge (forward, +h); approaching from outside → near edge
  // (turn before entering, -h). "Inside" = current position within the clearance.
  const oDist = Math.hypot(O[0], O[1]);
  const edge = oDist <= clearKm ? +h : -h;
  // Waypoint: chosen edge along-track, offset to the safe side at full clearance.
  const wx = P[0] + edge * u[0] + (clearKm - dmin) * safe[0];
  const wy = P[1] + edge * u[1] + (clearKm - dmin) * safe[1];
  return {
    latitude: round4(fLat + wy / KM_PER_DEG_LAT),
    longitude: round4(fLon + wx / kmPerDegLon),
  };
};

export const assessExposure = (fireballsResponse, vessels) => {
  const fireballs = parseFireballs(fireballsResponse);
  const affectedVessels = [];
  // Distinct hazard zones to draw on the reroute map, keyed by fireball event.
  // Each vessel sits inside its most-severe zone; we keep, per event, the most
  // severe (largest-clearance) zone so the drawn circle encloses what we avoid.
  const zoneByEvent = new Map();
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
      // Detour waypoint clear of the hazard zone, for the routing engine's
      // viaPoints. Requires a destination to know which way the vessel is headed.
      const dest = v.destination;
      if (dest && Number.isFinite(dest.latitude) && Number.isFinite(dest.longitude)) {
        entry.safeWaypoint = computeSafeWaypoint(
          v.latitude,
          v.longitude,
          dest.latitude,
          dest.longitude,
          hit.eventLat,
          hit.eventLon,
          hit.zoneRadiusKm + WAYPOINT_MARGIN_KM,
        );
      }
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
      summary: "No watched vessels fall within any fireball hazard zone.",
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
    summary: `${affectedAssetCount} vessel(s) within the ${worst.criticality} hazard zone of fireball ${worst.nearestEventId}.`,
  };
};
