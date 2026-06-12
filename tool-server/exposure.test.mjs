import { test } from "node:test";
import assert from "node:assert/strict";
import { assessExposure, outerRangeKm, severityOf } from "./exposure.mjs";

const FB = {
  signature: { version: "1.2", source: "NASA/JPL Fireball Data API" },
  count: "1",
  fields: ["date", "energy", "impact-e", "lat", "lat-dir", "lon", "lon-dir", "alt", "vel"],
  data: [["2026-06-11 00:00:00", "20", "2", "0.0", "N", "0.0", "E", "30", "18"]],
};

test("severityOf buckets impact energy", () => {
  assert.equal(severityOf(15), "critical");
  assert.equal(severityOf(2), "high");
  assert.equal(severityOf(0.2), "medium");
  assert.equal(severityOf(0.01), "low");
});

test("outerRangeKm clamps and scales by cube root", () => {
  assert.ok(Math.abs(outerRangeKm(2) - 151.2) < 1);
  assert.equal(outerRangeKm(0), 30);        // clamped to min
  assert.equal(outerRangeKm(1e9), 500);     // clamped to max
});

test("voyage whose closest approach is in the high zone is labelled high", () => {

  const vessels = [
    { id: "V1", name: "Near", latitude: 0.3, longitude: 0.0, destination: { name: "East", latitude: 0.3, longitude: 40.0 } },
  ];
  const out = assessExposure(FB, vessels);
  assert.equal(out.affectedAssetCount, 1);
  assert.equal(out.affectedVessels[0].criticality, "high");
  assert.equal(out.affectedVessels[0].nearestEventId, "2026-06-11 00:00:00");
  assert.equal(out.worstEventId, "2026-06-11 00:00:00");
  assert.ok(out.threatScore >= 55 && out.threatScore <= 100);
});

test("affected vessel with a destination gets a safeWaypoint outside the zone", () => {

  const vessels = [
    {
      id: "V1",
      name: "Near",
      latitude: 0.3,
      longitude: 0.0,
      destination: { name: "East", latitude: 0.3, longitude: 40.0 },
    },
  ];
  const out = assessExposure(FB, vessels);
  const wp = out.affectedVessels[0].safeWaypoint;
  assert.ok(wp, "expected a safeWaypoint");

  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(wp.latitude - 0);
  const dLon = toRad(wp.longitude - 0);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(0) * Math.cos(toRad(wp.latitude)) * Math.sin(dLon / 2) ** 2;
  const distKm = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  const highZoneKm = 0.4 * Math.min(500, Math.max(30, 120 * Math.cbrt(2)));
  assert.ok(distKm >= highZoneKm, `waypoint ${distKm.toFixed(1)}km must clear zone ${highZoneKm.toFixed(1)}km`);

  assert.ok(wp.longitude > 0, `waypoint must be east (toward dest), got lon ${wp.longitude}`);
});

test("vessel without a destination is not assessed (no voyage to reroute)", () => {
  const vessels = [{ id: "V3", name: "NoDest", latitude: 0.3, longitude: 0.0 }];
  const out = assessExposure(FB, vessels);
  assert.equal(out.affectedAssetCount, 0);
});

test("exposure emits a hazardZones nogo-circle for the affected event", () => {
  const vessels = [
    { id: "V1", name: "Near", latitude: 0.3, longitude: 0.0, destination: { name: "East", latitude: 0.3, longitude: 40.0 } },
  ];
  const out = assessExposure(FB, vessels);
  assert.equal(out.hazardZones.length, 1);
  const zone = out.hazardZones[0];
  assert.equal(zone.type, "nogo");
  assert.equal(zone.geojson.type, "Feature");
  assert.equal(zone.geojson.geometry.type, "Polygon");

  // Ring is closed (first == last) and is a [lon,lat] circle centred on (0,0).
  const ring = zone.geojson.geometry.coordinates[0];
  assert.ok(ring.length >= 5, "circle ring should have several points");
  assert.deepEqual(ring[0], ring[ring.length - 1], "ring must be closed");

  // Every ring vertex sits ~ the high-zone radius (0.4*outer) from the fireball.
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const highZoneKm = 0.4 * Math.min(500, Math.max(30, 120 * Math.cbrt(2)));
  for (const [lon, lat] of ring) {
    const a =
      Math.sin(toRad(lat) / 2) ** 2 +
      Math.cos(0) * Math.cos(toRad(lat)) * Math.sin(toRad(lon) / 2) ** 2;
    const distKm = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    assert.ok(Math.abs(distKm - highZoneKm) < 1, `vertex ${distKm.toFixed(1)}km ~ ${highZoneKm.toFixed(1)}km`);
  }
});

test("no affected vessels → empty hazardZones", () => {
  const vessels = [{ id: "V2", name: "Far", latitude: 10, longitude: 10 }];
  const out = assessExposure(FB, vessels);
  assert.deepEqual(out.hazardZones, []);
});

test("vessel outside all zones is not affected", () => {
  const vessels = [{ id: "V2", name: "Far", latitude: 10, longitude: 10 }];
  const out = assessExposure(FB, vessels);
  assert.equal(out.affectedAssetCount, 0);
  assert.equal(out.affectedVessels.length, 0);
});

test("voyage whose PATH crosses a zone is flagged even when the vessel is outside it", () => {
  // FB at (0,0). Vessel 0.3° east-ish but here far west at lon -2 (~222 km, outside
  // the high zone ~60.5 km) heading to lon 40 — its straight path runs through (0,0).
  const vessels = [
    { id: "P1", name: "Crosser", latitude: 0.0, longitude: -2.0, destination: { name: "East", latitude: 0.0, longitude: 40.0 } },
  ];
  const out = assessExposure(FB, vessels);
  assert.equal(out.affectedAssetCount, 1, "path crossing the zone must be flagged");
  // Vessel is outside, so the detour turns BEFORE entering → waypoint west of the fireball.
  assert.ok(out.affectedVessels[0].safeWaypoint.longitude < 0, "approaching vessel turns before the zone (west of fireball)");
});

test("voyage that neither sits in nor crosses any zone is not affected", () => {
  const vessels = [
    { id: "P2", name: "Clear", latitude: 10, longitude: 10, destination: { name: "NE", latitude: 20, longitude: 20 } },
  ];
  assert.equal(assessExposure(FB, vessels).affectedAssetCount, 0);
});

test("route-aware: the real route polyline is assessed, not the straight leg", () => {
  const farNorthRoute = [
    { latitude: 5.0, longitude: -5.0 },
    { latitude: 5.0, longitude: 5.0 },
  ];
  const vessels = [
    { id: "R1", name: "Detour", latitude: 0.3, longitude: -5.0, destination: { name: "E", latitude: 0.3, longitude: 5.0 }, route: farNorthRoute },
  ];
  assert.equal(assessExposure(FB, vessels).affectedAssetCount, 0, "route polyline (lat 5) clears the zone");

  const throughRoute = [
    { latitude: 0.3, longitude: -5.0 },
    { latitude: 0.0, longitude: 0.0 },
    { latitude: 0.3, longitude: 5.0 },
  ];
  const out = assessExposure(FB, [
    { id: "R2", name: "Through", latitude: 0.3, longitude: -5.0, destination: { name: "E", latitude: 0.3, longitude: 5.0 }, route: throughRoute },
  ]);
  assert.equal(out.affectedAssetCount, 1);
  assert.equal(out.affectedVessels[0].criticality, "critical");
});

test("route-aware: the avoidance leg origin→waypoint→destination clears the zone", () => {

  const O = { lat: 0.0, lon: -5.0 };
  const D = { lat: 0.0, lon: 5.0 };
  const route = [O, { latitude: 0.0, longitude: 0.0 }, D].map((p) =>
    p.latitude !== undefined ? p : { latitude: p.lat, longitude: p.lon },
  );
  const out = assessExposure(FB, [
    { id: "A1", name: "Avoider", latitude: O.lat, longitude: O.lon, destination: { name: "E", latitude: D.lat, longitude: D.lon }, route },
  ]);
  assert.equal(out.affectedAssetCount, 1);
  const wp = out.affectedVessels[0].safeWaypoint;

  // impact-e=2 → critical-zone radius = 0.2*outer. Both reroute legs must clear it.
  const criticalZoneKm = 0.2 * Math.min(500, Math.max(30, 120 * Math.cbrt(2)));
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const hav = (a, b) => {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const x =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  };
  const segMin = (A, B) => {
    let m = Infinity;
    for (let i = 0; i <= 300; i++) {
      const f = i / 300;
      m = Math.min(m, hav({ lat: 0, lon: 0 }, { lat: A.lat + f * (B.lat - A.lat), lon: A.lon + f * (B.lon - A.lon) }));
    }
    return m;
  };
  const W = { lat: wp.latitude, lon: wp.longitude };
  assert.ok(segMin(O, W) >= criticalZoneKm, `leg O→W ${segMin(O, W).toFixed(1)}km must clear ${criticalZoneKm.toFixed(1)}km`);
  assert.ok(segMin(W, D) >= criticalZoneKm, `leg W→D ${segMin(W, D).toFixed(1)}km must clear ${criticalZoneKm.toFixed(1)}km`);
});
