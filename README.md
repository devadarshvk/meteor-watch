# Meteor Debris Watch

**Domain:** `meteor` | **Platform:** ZAP (ZeroNorth Agentic Platform) | **Stack:** Node.js · React · OpenAPI · deck.gl

A ZAP domain that connects real NASA/JPL atmospheric fireball data to live maritime
vessel positions, runs geometric hazard-zone analysis, and drives a two-gate
human-in-the-loop approval flow that ends in an actual reroute of a real stage vessel —
all from a single natural-language prompt.

---

## Written pitch

We built a ZAP domain that monitors real NASA/JPL fireball detections, cross-references
them against live vessel positions using concentric hazard-zone geometry, and — after
two human approval gates — executes an actual zone-avoiding reroute on a real stage
vessel using the existing `voyage_*` routing tools. What surprised us most was that the
voyage engine has no runtime "avoid this polygon" input, so we engineered a
`safeWaypoint` via-point algorithm from scratch: equirectangular projection, closest-
approach computation, and radial push to `zoneRadius + 25 km` — all so the route
physically arcs around the debris field without any backend polygon registration.

---

## Architecture overview

```
┌───────────────────────────────────────────────────────────┐
│                   ZAP Platform (zap serve)                 │
│  ┌──────────────┐  ambient knowledge   ┌───────────────┐  │
│  │ meteor domain│◄─────────────────────│ zap/knowledge │  │
│  │              │  OpenAPI + x-zap     │ /meteor.md    │  │
│  └──────┬───────┘◄── openapi.json     └───────────────┘  │
│         │ tool calls                                       │
│  ┌──────▼───────┐  voyage_* (remote)  ┌───────────────┐  │
│  │    Agent     │◄────────────────────│ voyage domain │  │
│  └──────┬───────┘                     └───────────────┘  │
│         │ widget renders                                   │
│  ┌──────▼──────────────────────────────────────────────┐  │
│  │ Chat UI (zap-widgets / React + Zod)                 │  │
│  │ meteor_fireball_map · fireball_list · fireball_detail│  │
│  │ meteor_response_approval (approval input widget)    │  │
│  └─────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
           ▲ HTTP :9001
┌─────────────────────┐   ┌───────────────────────────┐
│  Meteor Tool Server │──►│ NASA/JPL Fireball Data API │
│  (tool-server/)     │   └───────────────────────────┘
│  + demo fireball    │   ┌───────────────────────────┐
│    inject           │──►│ SMARTShip API (optional)  │
└─────────────────────┘   └───────────────────────────┘
```

---

## Staged reroute flow (7 steps)

1. **Detect** — calls `meteor_get_fireballs` and `meteor_list_vessels` in parallel,
   then renders `meteor_fireball_map` with vessels coloured by the most-severe zone
   they fall within. The map also shows concentric hazard rings around each detection.
2. **Assess** — `meteor_assess_exposure` runs haversine zone intersection across every
   fireball and vessel pair. Returns each affected vessel with `criticality`, `distanceKm`,
   `threatScore` (0–100), `estimatedRiskReductionPercent`, and a computed `safeWaypoint`
   — a detour coordinate placed just outside the hazard zone boundary.
3. **Approval #1 (alert)** — `meteor_submit_response_decision` renders the
   `meteor_response_approval` widget. The operator sees the threat summary, a bulleted
   list of recommended actions, and three decision metrics — threat score, affected
   asset count, estimated risk reduction — before any routing is computed.
4. **Reroute** — on approval, `voyage_generate_route` is called with the full `voyage_*`
   tool chain (weather, bunker prices, safety params, AIS trail) plus the vessel's
   `safeWaypoint` as `itinerary.viaPoints`. Before/after routes shown in `route_comparison`
   with hazard zones overlaid — the operator can visually confirm the new route clears them.
5. **Approval #2 (activation)** — a second `meteor_submit_response_decision` before
   any voyage data is written. The agent waits for an explicit approval at this gate too.
6. **Activate** — `voyage_save_voyage_optimisation_plan` applies the reroute to the
   live voyage plan in the backend.
7. **Halt** — any rejection, `more_analysis_requested`, or routing failure stops the
   flow immediately with no side effects. The agent explicitly confirms zero changes.

Trigger prompt: *"Check for fireball threats to our fleet, alert me, and if I approve,
reroute the affected vessels clear of the hazard zone."*

**Broadened trigger:** ambient knowledge encodes a rule that any fleet-safety question —
however vague — carries to the first approval gate if any vessel is flagged. Prompts like
*"is the fleet safe from fireballs?"* or *"check meteor exposure"* trigger the full flow,
not just a status report.

---

## ZAP platform features used

| Feature | How |
| --- | --- |
| **Domain** (`domain.yaml`) | `id: meteor` registered alongside remote `voyage`. |
| **Tool server** (OpenAPI 3.0) | 4 tools, `x-zap: { enabled: true }`, zero npm dependencies. |
| **`x-zap-approval-widget`** | `meteor_response_approval` gates every `submit_response_decision` call. |
| **Ambient knowledge** (`mode: ambient`) | `meteor.md` — 7-step flow, safeWaypoint wiring, broadened trigger rule, injected every turn. |
| **Task template** | `geofencing.md` (`taskTemplateId: geofencing`); variables: `{{vessel}}`, `{{position}}`, `{{severity}}`. |
| **Multi-domain** | `meteor` (local) + `voyage` (remote, stage zap-sources) cooperate in one agent turn. |
| **4 custom widgets** | Map, list, detail, approval — Zod schemas + `defineWidgetView` + Storybook stories + `check:schema-meta`. |
| **Evals** | `hello.eval.ts` with `@0north/zap-eval-harness`; `MockTools`-based domain evals documented. |
| **Task API** | `scripts/create-task-and-turn.sh` — `POST /tasks/` then `POST /tasks/{id}/turns`. |

---

## Repository layout

```
meteor-watch/
├── zap.config.mjs              # stage env, local meteor domain, ../zap-widgets path
├── data/fireballs.kml          # auto-generated on start, refreshed every 6 h
├── scripts/
│   ├── create-task-and-turn.sh # POST /tasks/ then POST /tasks/{id}/turns
│   ├── create-task.json        # domainId: meteor, taskTemplateId: geofencing, autoStart: true
│   └── create-turn.json        # default exposure-check message
├── zap/
│   ├── domain.yaml             # id: meteor
│   ├── knowledge/meteor.md     # ambient knowledge — tools, 7-step flow, broadened trigger
│   ├── tasks/geofencing.md     # task template: {{vessel}}, {{position}}, {{severity}}
│   └── evals/hello.eval.ts     # sample eval (zap-eval-harness + MockTools)
└── tool-server/                # zero-dependency node:http server
    ├── server.mjs              # /fireballs /vessels /exposure /response/decision /kml /smartship/*
    ├── exposure.mjs            # haversine zone math + equirectangular safeWaypoint
    ├── exposure.test.mjs       # node:test — 5 cases, zero test-runner dependencies
    ├── kml.mjs                 # NASA columnar → KML circle polygons (100 km radius)
    ├── smartship.mjs           # Auth0 token cache + geo-custom-zone client
    ├── openapi.json            # OpenAPI 3.0, x-zap, x-zap-approval-widget
    └── .env.example            # PORT, NASA_FIREBALL_API, SMARTSHIP_*
```

Widgets: `zap-widgets/src/meteor/` (sibling repo, path resolved by `zap.config.mjs`).

---

## Tools

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `meteor_get_fireballs` | `GET /fireballs` | NASA/JPL proxy. `date_min`, `date_max`, `energy_min`, `limit`. Prepends synthetic 500 kt demo fireball ~25 km from hero vessel. |
| `meteor_list_vessels` | `GET /vessels` | Fleet — id, name, lat/lon, destination + coordinates. |
| `meteor_assess_exposure` | `POST /exposure` | Returns `affectedVessels` (with `criticality`, `distanceKm`, `safeWaypoint`), `threatScore`, `affectedAssetCount`, `estimatedRiskReductionPercent`. |
| `meteor_submit_response_decision` | `POST /response/decision` | Approval gate. Records `approved` / `rejected` / `more_analysis_requested` + ISO timestamp. |
| `GET /kml` | — | Exports `fireballs.kml` (100 km circle per event). Auto-saved to `data/` every 6 h. |

**Reused external services:** `voyage_generate_route` · `voyage_save_voyage_optimisation_plan` (stage zap-sources). SMARTShip `/v1.2/geo-custom-zone` API. NASA/JPL `ssd-api.jpl.nasa.gov/fireball.api`.

---

## Reused services

We wrote zero routing logic, zero geofencing logic, and zero weather modelling. Every
heavyweight capability in this domain is delegated to an existing production service.
Our contribution is the glue: domain registration, haversine zone-intersection math,
the `safeWaypoint` geometry, and the ambient knowledge that orchestrates these services
into a coherent, approval-gated agent flow.

### Weather Routing API (ZeroNorth voyage domain)

**Tools used:** `voyage_generate_route`, `voyage_save_voyage_optimisation_plan`, and
the full supporting `voyage_*` tool chain (loaded from stage zap-sources).

When the operator approves the reroute alert, the agent calls `voyage_generate_route`
with the affected vessel's current position as origin, its destination port as
destination, and the computed `safeWaypoint` injected as an `itinerary.viaPoints`
entry. The routing engine takes it from there — it fetches its own weather windows,
bunker prices, safety parameters, and AIS trail via its own `voyage_*` sub-tools, and
returns a fully weather-optimised route that is physically forced to pass through the
safe waypoint and therefore arc around the debris field.

The before/after routes are displayed in the `route_comparison` widget with fireball
hazard zones overlaid, so the operator can visually verify the new route clears the
zone before giving the second approval.

Once the operator approves activation, `voyage_save_voyage_optimisation_plan` writes
the new route to the live voyage plan in the backend. The meteor domain never touches
the routing engine internals — it only passes a via-point and trusts the existing
service to produce the best possible weather-optimised path.

### SMARTShip Geofencing API

**Endpoints used:** `POST /v1.2/geo-custom-zone/upload`, `POST /v1.2/geo-custom-zone`,
`POST /smartship/push-hazard-zones` (our wrapper).

SMARTShip is ZeroNorth's voyage management platform. It has an existing geofencing
system that allows operators to define custom navigable zones visible in the voyage UI.
We call this system directly to register live fireball hazard zones as custom geo-zones,
so the debris threat becomes visible inside SMARTShip alongside the vessel's route —
not just inside ZAP.

The flow is: the tool server generates a KML file with one 100 km circle polygon per
fireball detection, uploads it to SMARTShip's `/geo-custom-zone/upload` endpoint (which
parses the KML and returns boundaries and metadata), then calls `/geo-custom-zone` to
create the zone with those boundaries. No new zone storage schema, no new polygon
format — the entire geofencing capability is already built into SMARTShip. We supply
the hazard data; SMARTShip handles the rest.

Authentication uses the ZeroNorth `api-login` Auth0 flow. The `smartship.mjs` client
caches the RS256 bearer token with a 60 s pre-expiry refresh and retries once on 401,
so token management is fully handled without any manual intervention.

### NASA/JPL Fireball Data API

**Endpoint used:** `GET https://ssd-api.jpl.nasa.gov/fireball.api`

The Center for Near Earth Object Studies (CNEOS) at NASA/JPL publishes a public API
of atmospheric fireball and bolide detections recorded by US government sensors. Each
record includes the detection date, geographic coordinates, total radiated energy
(×10¹⁰ J), impact energy (kt TNT equivalent), entry altitude (km), and entry velocity
(km/s). The API is proxied as-is — we request located events sorted newest-first and
pass the response directly to the widgets and exposure engine without transforming or
caching the data.

The only addition is a synthetic demo fireball (500 kt, ~25 km from the hero vessel)
prepended to every response so the demo is reliable on every run regardless of where
real fireballs have been detected recently.

### Zone hazard math

`exposure.mjs` constants are byte-for-byte in sync with `meteor-fireball-map.layers.ts` in `zap-widgets` so server numbers and map colours always agree.

| Severity | Impact energy | Zone fraction | Threat base |
| --- | --- | --- | --- |
| `critical` | ≥ 10 kt | 20 % of outer radius | 80 |
| `high` | ≥ 1 kt | 40 % | 55 |
| `medium` | ≥ 0.1 kt | 66 % | 30 |
| `low` | < 0.1 kt | 100 % (= outer) | 10 |

Outer radius: `clamp(120 × ∛(impactE), 30, 500)` km. Threat score: `min(100, BASE[worst] + (affectedCount − 1) × 5)`.

### Zone-avoidance safeWaypoint algorithm

1. Project the vessel's origin→destination line onto an equirectangular frame centred on the fireball.
2. Find the closest point on that line to the fireball (maximum exposure point).
3. Push a waypoint radially outward to `zoneRadius + 25 km` on the side away from the hazard.
4. If the vessel is already inside the zone, push toward the destination rather than back through it.
5. Convert to decimal degrees (4 d.p.) and pass as `itinerary.viaPoints` to `voyage_generate_route`.

---

## Widgets

| Widget | Description |
| --- | --- |
| `meteor_fireball_map` | deck.gl + MapLibre GL global map. Fireballs sized by radiated energy, coloured by impact energy (red/orange/yellow/green). Concentric hazard rings per detection. Vessels inside zones shown as triangles coloured by worst criticality; out-of-range hidden. Hover tooltip: energy, kt, velocity, altitude. Camera auto-fits to all plotted features. |
| `meteor_fireball_list` | 420 × 480 px scrollable list. Severity filter tabs (All/Critical/High/Medium/Low); rows sorted by impact energy descending. Each row: ocean/hemisphere region, coordinates, date, kt (colour-coded), velocity. |
| `meteor_fireball_detail` | Single-event readout: kinematics (altitude km, velocity km/s, radiated energy ×10¹⁰ J, impact kt), all four zone radii in km, severity-keyed mariner advisory (NO-GO · AVOID · CAUTION · ADVISORY), vessels ranked by proximity. |
| `meteor_response_approval` | **Approval input widget.** Situation summary + recommended actions (bulleted) + three metrics (threat score, affected assets, risk reduction %). Buttons: Approve · Reject · Request more analysis. Read-only after submission with colour-coded decision banner (green/grey/amber). Output: `{ decision: "approved" \| "rejected" \| "more_analysis_requested" }`. |

---

## Prerequisites

- **Node.js** v20+ (tool server); v22/24 preferred for the ZAP CLI.
- **`@0north/zap-cli`** on PATH — GitHub Packages, PAT with `read:packages`.
- **AWS SSO** access to stage — `aws sso login` required by `zap serve` for SSM parameter resolution.
- **`zap-widgets`** checked out at `../zap-widgets` (relative to this repo) with `NODE_AUTH_TOKEN` set before `pnpm install`.

## Running locally

```bash
# 1. Tool server (port 9001)
cd tool-server && cp .env.example .env
node --env-file=.env server.mjs    # or: npm start

# 2. ZAP platform
aws sso login
zap serve --remote-domains         # ⚠️ required — loads voyage_* tools from stage
# UI → http://localhost:3000/zap

# 3. Task API (optional, non-UI flow)
export ZAP_TOKEN="eyJ..."
./scripts/create-task-and-turn.sh
```

Restart `zap serve` after editing `openapi.json` or `meteor.md`. Tool-server data
changes (fleet list, fireball values) take effect on the next tool call without restart.

---

## Testing

```bash
cd tool-server && node --test exposure.test.mjs    # 5 unit tests, zero extra deps
zap lint http://localhost:9001/openapi.json         # OpenAPI + x-zap spec lint
# In zap-widgets: pnpm typecheck && pnpm lint && pnpm build && pnpm check:schema-meta
```

Tests cover: severity bucket thresholds · `outerRangeKm` cube-root scaling and clamps ·
vessel-in-zone labelling with correct `criticality` and `threatScore` · `safeWaypoint`
geometry (distance from fireball must exceed zone radius) · no waypoint when vessel has
no destination · `affectedAssetCount: 0` when vessel is out of range.
