# Meteor Debris Watch

A ZAP (ZeroNorth Agentic Platform) demo domain. The agent monitors atmospheric
fireball / bolide detections from the NASA/JPL Fireball Data API, computes which
vessels' planned voyages cross an event's debris hazard zones, alerts the operator
for approval, and — on approval — reroutes the threatened voyage via the real
`voyage` routing tools, gated by a second approval before activation.

## What it does (staged reroute flow)

1. **Detect** — `meteor_get_fireballs` + `meteor_list_vessels`, rendered on the
   `meteor_fireball_map` widget.
2. **Route** — `voyage_generate_route` computes each vessel's current (original)
   route first, so exposure can be tested against the **real path** the ship will
   sail (the one drawn on the map), not a straight line. This route is kept and
   reused in the comparison.
3. **Assess (route-aware)** — `meteor_assess_exposure` is called with each vessel's
   original route waypoints (`route`). A voyage is flagged when that real path
   crosses a zone — catching ships heading into a zone before they arrive. Returns
   affected vessels, each tagged `critical`/`high`/`medium`/`low`, plus a
   `threatScore`, `estimatedRiskReductionPercent`, a `safeWaypoint` (detour point
   clear of the zone, placed relative to the route), and `hazardZones` (the avoided
   zones as map circles). Without a `route` it falls back to a straight
   current-position → destination leg.
4. **Approval #1 (alert)** — `meteor_submit_response_decision` renders the
   `meteor_response_approval` widget. Operator approves / rejects / asks for more.
5. **Reroute (zone-avoiding)** — on approval, `voyage_generate_route` runs again
   with the vessel's `safeWaypoint` passed as an itinerary `viaPoint` so the route
   is **forced to steer clear of the meteor zone** (not merely weather-re-optimised).
   Original (step 2) vs avoidance route shown in the `route_comparison` widget, with
   the critical zone drawn as a red overlay.
6. **Approval #2 (activation)** — a second `meteor_submit_response_decision`.
7. **Activate** — on approval, `voyage_save_voyage_optimisation_plan` applies it.
8. **Halt** — any rejection / `more_analysis_requested` / routing failure stops
   the flow with no changes made.

The flow is encoded as ambient knowledge in `zap/knowledge/meteor.md`; the agent
runs it from a single prompt such as:

> Check for fireball threats to our fleet, alert me, and if I approve, reroute the
> affected vessels clear of the hazard zone.

**Broadened trigger:** the flow fires on *any* exposure or fleet-safety question,
not just explicit reroute requests. Vague, status-style prompts — e.g. "are any of
my voyages heading into a critical meteor zone?", "is the fleet safe from
fireballs?", "check meteor exposure" — still carry all the way to the first
approval gate. If
`meteor_assess_exposure` flags one or more vessels, the agent proactively raises
the reroute approval rather than just reporting the exposure and stopping.

## Repository layout

```
meteor_watch/
├── zap.config.mjs              # CLI config: stage env, local meteor domain, widgets path
├── scripts/
│   ├── create-task-and-turn.sh # create a v2 task + first turn via the API
│   ├── create-task.json        # default task body (meteor domain, hero vessel)
│   └── create-turn.json        # default turn message
├── zap/
│   ├── domain.yaml             # domain id: meteor
│   ├── knowledge/meteor.md     # ambient knowledge (tools + staged flow)
│   ├── tasks/
│   │   └── geofencing.md       # task template (id: geofencing; {{vessel}}, {{position}}, {{severity}})
│   └── evals/                  # hello.eval.ts (sample)
└── tool-server/                # zero-dep node:http tool server
    ├── server.mjs              # /fireballs, /vessels, /exposure, /response/decision
    ├── exposure.mjs            # pure zone math + safeWaypoint detour calc (unit-tested)
    ├── exposure.test.mjs       # node:test unit tests
    ├── openapi.json            # OpenAPI 3.0 spec with x-zap extensions
    ├── .env.example            # PORT, NASA_FIREBALL_API
    └── package.json
```

## Tools (meteor domain)

| Tool | Endpoint | Purpose |
| --- | --- | --- |
| `meteor_get_fireballs` | `GET /fireballs` | Proxy NASA/JPL Fireball Data API (located events, newest first). |
| `meteor_list_vessels` | `GET /vessels` | The watched fleet (id, name, position, destination). |
| `meteor_assess_exposure` | `POST /exposure` | Which vessels' voyages cross a fireball's hazard zones + threat scoring + a `safeWaypoint` detour and `hazardZones` overlay for each affected voyage. |
| `meteor_submit_response_decision` | `POST /response/decision` | Operator approval gate (`meteor_response_approval` widget). |

Routing uses the remote **`voyage`** domain (`voyage_generate_route`,
`voyage_save_voyage_optimisation_plan`, plus its supporting `voyage_*` tools) and
the `route_comparison` widget — all loaded from stage zap-sources, not in this
repo.

### How the reroute avoids the zone

The voyage engine has no inline "avoid this circle" input — `polygonRestrictions`
only reference pre-registered backend polygons, and none of the `voyage_*` tools
create one. So avoidance is done with **via points** instead: `meteor_assess_exposure`
computes a `safeWaypoint` for each affected voyage — a point on the side away from
the fireball, at the hazard-zone boundary (zone radius + 25 km margin). The
closest-approach geometry comes from the **real route polyline** passed in (so the
detour is placed against the path actually sailed, not a straight line). Placement
depends on where the ship is relative to the zone:

- **Already inside the zone** → the waypoint is at the zone's *exit* edge, forward
  along the route, so the ship steers to the safe side and leaves the zone moving
  toward its destination (no backtracking).
- **Still approaching** (voyage path crosses the zone ahead) → the waypoint is at
  the zone's *near* edge, so the route turns off its original line **before** it
  would enter the zone.

The flow passes that point as an `itinerary.viaPoints` entry to
`voyage_generate_route`, so the engine routes origin → safeWaypoint → destination,
weather-optimised but forced to pass clear of the zone. It's a single-waypoint
detour (sufficient for the demo), not a multi-segment arc.

## Demo data

For a reliable end-to-end demo the tool server is wired to a single **real** stage
vessel that has an active voyage leg, so the `voyage_*` routing tools have backend
data to act on:

- **Hero vessel:** `Harvest Time` (IMO 9643881), bound for Rotterdam.
- **Injected fireball:** `meteor_get_fireballs` prepends a synthetic high-energy
  fireball ~25 km from the hero vessel — squarely on its voyage to Rotterdam — so
  `meteor_assess_exposure` reliably flags the voyage `critical`.

The original 8-vessel synthetic fleet is kept commented out in `server.mjs` for
multi-vessel demos.

## Prerequisites

- Node.js (the tool server runs on v20+; the ZAP CLI prefers v22/24).
- `@0north/zap-cli` installed and on PATH (GitHub Packages, needs a PAT with
  `read:packages`).
- AWS access to stage SSM (`aws sso login`) — required by `zap serve` to resolve
  `/stage/*` parameters.

## Running locally

**1. Tool server** (separate process, port 9001):

```bash
cd tool-server
node server.mjs                      # uses defaults
# or, to load tool-server/.env (copy from .env.example first):
node --env-file=.env server.mjs
```

Env vars (both optional, defaults shown in `.env.example`):
- `PORT` — listen port (default `9001`; must match `openApiUrl` in `zap.config.mjs`).
- `NASA_FIREBALL_API` — upstream API base (default JPL fireball API).

**2. ZAP platform** (from this directory):

```bash
aws sso login                        # if the stage SSM token has expired
zap serve --remote-domains           # local meteor + remote voyage/vessel domains
```

> ⚠️ **`--remote-domains` is required.** This CLI build suppresses remote
> zap-sources by default; without the flag only the local `meteor` and built-in
> `vessel` domains load and the routing step has no `voyage_*` tools.

UI: `http://localhost:3000/zap`.

> The platform reads the OpenAPI spec and ambient knowledge **once at startup** —
> restart `zap serve` after editing `openapi.json` or `zap/knowledge/meteor.md`.
> Tool-server data changes (fleet, fireball) take effect on the next tool call, no
> `zap serve` restart needed.

## Creating a task via the API

With `zap serve` running, you can create a v2 task and post the first turn from
the shell instead of driving the UI manually. The script in `scripts/` calls
`POST /zap/api/v2/tasks/` then `POST /zap/api/v2/tasks/{id}/turns`.

**Prerequisites**

- `zap serve` (and the tool server) running as above.
- `ZAP_TOKEN` — an Auth0 bearer JWT for the stage environment (same token the UI
  uses). Export it before running the script.

**Run with defaults**

The defaults target the demo hero vessel (`Harvest Time`, IMO 9643881) and a
turn message that kicks off the fireball exposure flow:

```bash
export ZAP_TOKEN="eyJ..."          # your stage Auth0 JWT
./scripts/create-task-and-turn.sh
```

This reads `scripts/create-task.json` and `scripts/create-turn.json`. On
success it prints the created task id and the formatted turn response.

**Custom bodies**

Pass JSON file paths as arguments to override the defaults:

```bash
./scripts/create-task-and-turn.sh ./scripts/create-task.json ./scripts/create-turn.json
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZAP_BASE_URL` | `http://localhost:3000` | ZAP API base URL |
| `ZAP_TOKEN` | (required) | Auth0 bearer JWT |

**Default task body** (`create-task.json`):

```json
{
  "domainId": "meteor",
  "taskTemplateId": "geofencing",
  "autoStart": true,
  "data": {
    "vessel": { "id": "9643881", "name": "Harvest Time" },
    "position": "21.88, -111.54",
    "severity": "critical"
  },
  "priority": "medium"
}
```

`autoStart: true` starts the agent immediately after the task is created. Edit
`data` to match another vessel or scenario; keep `domainId` as `meteor`.

**Default turn message** (`create-turn.json`):

```json
{
  "message": "Check for recent fireball detections and assess vessel exposure."
}
```

For the full staged reroute flow (alert → reroute → activate), use a message
like the prompt in [What it does](#what-it-does-staged-reroute-flow) above.

**Help**

```bash
./scripts/create-task-and-turn.sh --help
```

## Testing

Unit tests for the exposure zone math:

```bash
cd tool-server
node --test exposure.test.mjs
```

Spec lint:

```bash
zap lint http://localhost:9001/openapi.json
```

End-to-end is verified manually in the live UI (drive the prompt above; check the
widget render order and the reject path).
