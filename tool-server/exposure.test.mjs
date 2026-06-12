import { test } from "node:test";
import assert from "node:assert/strict";
import { assessExposure, outerRangeKm, severityOf } from "./exposure.mjs";

// A single high-energy fireball at (0,0). impact-e = 2 kt → "high" severity.
// outer zone = clamp(120*cbrt(2),30,500) ≈ 151.2 km; high zone = 0.4*outer ≈ 60.5 km.
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
  // Vessel at 0.3°N of (0,0) ≈ 33 km, heading east; the leg's closest approach to
  // the fireball is its start (33 km) < 60.5 km high-zone radius.
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
  // Vessel 0.3°N of (0,0), destination far east. impact-e=2 → outer≈151.2 km,
  // high-zone radius (0.4*outer)≈60.5 km. Waypoint must clear that radius.
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

  // Distance from the fireball (0,0) to the waypoint must exceed the high-zone
  // radius (~60.5 km). outer = clamp(120*cbrt(2)) ≈ 151.2; high = 0.4*outer.
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

  // Waypoint must be FORWARD toward the destination (east here), never behind the
  // vessel — the ship is already inside the zone and must exit moving toward port.
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
