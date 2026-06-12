// Standalone checker for the SMARTShip integration.
//   node --env-file=.env smartship-test.mjs token   # auth only
//   node --env-file=.env smartship-test.mjs upload   # auth + KML upload (parse)
//   node --env-file=.env smartship-test.mjs push     # auth + upload + create zone
//
// Uses the live fireball-hazard KML built by kml.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildKML } from "./kml.mjs";
import {
  getAccessToken,
  uploadCustomZoneKml,
  pushKmlAsCustomZone,
} from "./smartship.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] || "token";

async function fireballKml() {
  const url = new URL(
    process.env.NASA_FIREBALL_API || "https://ssd-api.jpl.nasa.gov/fireball.api"
  );
  url.searchParams.set("req-loc", "true");
  url.searchParams.set("sort", "-date");
  url.searchParams.set("limit", "5");
  const data = await (await fetch(url)).json();
  return Buffer.from(buildKML(data), "utf8");
}

try {
  if (cmd === "token") {
    const t = await getAccessToken();
    console.log("OK token (first 24 chars):", t.slice(0, 24) + "...");
  } else if (cmd === "upload") {
    const out = await uploadCustomZoneKml(await fireballKml());
    console.log("OK upload:", JSON.stringify(out, null, 2));
  } else if (cmd === "push") {
    const out = await pushKmlAsCustomZone(await fireballKml(), {
      zone_name: "Meteor Hazard Zone (test)",
    });
    console.log("OK push. zoneId =", out.zoneId);
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error("Unknown cmd. Use: token | upload | push");
    process.exit(2);
  }
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
