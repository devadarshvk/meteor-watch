const RADIUS_KM = 100;
const NUM_POINTS = 36;
const EARTH_RADIUS_KM = 6371;

function toSignedCoord(value, direction) {
  const n = parseFloat(value);
  return direction === "S" || direction === "W" ? -n : n;
}

function toSafeCoord(value) {
  const deg = Math.trunc(value);
  const decimalPart = Math.abs(value - deg);
  const minutes = Math.floor(decimalPart * 60);
  let seconds = (decimalPart * 60 - minutes) * 60;
  if (seconds >= 60) seconds = 59.9999;
  const normalized = deg + minutes / 60 + (seconds / 3600) * Math.sign(value || 1);
  return normalized.toFixed(6);
}

function circlePolygon(centerLat, centerLon, radiusKm, numPoints) {
  const coords = [];
  for (let i = 0; i <= numPoints; i++) {
    const angle = (i * 2 * Math.PI) / numPoints;
    const dLat = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI) * Math.cos(angle);
    const dLon =
      ((radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI) * Math.sin(angle)) /
      Math.cos((centerLat * Math.PI) / 180);
    coords.push(`${toSafeCoord(centerLon + dLon)},${toSafeCoord(centerLat + dLat)}`);
  }
  return coords.join(" ");
}

export function buildKML({ fields, data: records }) {
  const idx = Object.fromEntries(fields.map((f, i) => [f, i]));

  const placemarks = records
    .filter((r) => r[idx["lat"]] && r[idx["lon"]])
    .map((r) => {
      const lat = toSignedCoord(r[idx["lat"]], r[idx["lat-dir"]]);
      const lon = toSignedCoord(r[idx["lon"]], r[idx["lon-dir"]]);
      const date = r[idx["date"]];
      const coords = circlePolygon(lat, lon, RADIUS_KM, NUM_POINTS);
      return `  <Placemark>
    <name>${date}</name>
    <styleUrl>#main</styleUrl>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing>
          <coordinates>${coords}</coordinates>
        </LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:atom="http://www.w3.org/2005/Atom">
  <Document>
    <name>NASA JPL Fireball Events</name>
    <Style id="sub1">
      <LineStyle>
        <color>#d65c6b</color>
      </LineStyle>
      <PolyStyle>
        <color>#d65c6b33</color>
      </PolyStyle>
    </Style>
    <StyleMap id="main">
      <Pair>
        <key>normal</key>
        <styleUrl>#sub1</styleUrl>
      </Pair>
    </StyleMap>
${placemarks}
  </Document>
</kml>`;
}
