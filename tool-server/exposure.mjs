// Zone math ported from
// zap-widgets/src/meteor/components/meteor-fireball-map.layers.ts —
// KEEP THESE CONSTANTS IN SYNC with that file so server numbers match the map.

const RANGE_BASE_KM = 120;
const RANGE_MIN_KM = 30;
const RANGE_MAX_KM = 500;
const R_EARTH_KM = 6371;

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

const toRad = (d) => (d * Math.PI) / 180;
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
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

// Most-severe zone a vessel falls within across all detections.
// Returns null when out of range, else { criticality, nearestEventId, distanceKm }.
const assessVessel = (vessel, fireballs) => {
  let best = null; // { rank, level, eventId, distanceKm }
  for (const f of fireballs) {
    const dist = haversineKm(vessel.latitude, vessel.longitude, f.lat, f.lon);
    const outer = outerRangeKm(f.impactE);
    for (let rank = 0; rank < SEVERITY.length; rank++) {
      const level = SEVERITY[rank];
      if (dist <= outer * ZONE_FRAC[level]) {
        // pick more-severe rank; tie-break on nearer distance
        if (!best || rank < best.rank || (rank === best.rank && dist < best.distanceKm)) {
          best = { rank, level, eventId: f.id, distanceKm: dist };
        }
        break; // most-severe zone for this fireball found
      }
    }
  }
  if (!best) return null;
  return { criticality: best.level, nearestEventId: best.eventId, distanceKm: best.distanceKm };
};

export const assessExposure = (fireballsResponse, vessels) => {
  const fireballs = parseFireballs(fireballsResponse);
  const affectedVessels = [];
  for (const v of vessels ?? []) {
    const hit = assessVessel(v, fireballs);
    if (hit) {
      affectedVessels.push({
        id: v.id,
        name: v.name,
        latitude: v.latitude,
        longitude: v.longitude,
        criticality: hit.criticality,
        nearestEventId: hit.nearestEventId,
        distanceKm: Math.round(hit.distanceKm * 10) / 10,
      });
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
      summary: "No watched vessels fall within any fireball hazard zone.",
    };
  }

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
    summary: `${affectedAssetCount} vessel(s) within the ${worst.criticality} hazard zone of fireball ${worst.nearestEventId}.`,
  };
};
