# Meteor Debris Watch

A ZAP (ZeroNorth Agentic Platform) demo domain. The agent monitors atmospheric
fireball / bolide detections from the NASA/JPL Fireball Data API, computes which
vessels fall inside an event's debris hazard zones, alerts the operator for
approval, and — on approval — reroutes the threatened vessel via the real
`voyage` routing tools, gated by a second approval before activation.

## What it does (staged reroute flow)

1. **Detect** — `meteor_get_fireballs` + `meteor_list_vessels`, rendered on the
   `meteor_fireball_map` widget (vessels coloured by the severity of the zone
   they fall in).
2. **Assess** — `meteor_assess_exposure` runs the same zone math as the map
   widget and returns affected vessels, each tagged `critical`/`high`/`medium`/
   `low`, plus a `threatScore` and `estimatedRiskReductionPercent`.
3. **Approval #1 (alert)** — `meteor_submit_response_decision` renders the
   `meteor_response_approval` widget. Operator approves / rejects / asks for more.
4. **Reroute** — on approval, `voyage_generate_route` computes a new route for the
   affected vessel; old vs new shown in the `route_comparison` widget.
5. **Approval #2 (activation)** — a second `meteor_submit_response_decision`.
6. **Activate** — on approval, `voyage_save_voyage_optimisation_plan` applies it.
7. **Halt** — any rejection / `more_analysis_requested` / routing failure stops
   the flow with no changes made.

The flow is encoded as ambient knowledge in `zap/knowledge/meteor.md`; the agent
runs it from a single prompt such as:

> Check for fireball threats to our fleet, alert me, and if I approve, reroute the
> affected vessels clear of the hazard zone.

## Repository layout

```
meteor_watch/
├── zap.config.mjs              # CLI config: stage env, local meteor domain, widgets path
├── zap/
│   ├── domain.yaml             # domain id: meteor
│   ├── knowledge/meteor.md     # ambient knowledge (tools + staged flow)
│   └── evals/                  # hello.eval.ts (sample)
└── tool-server/                # zero-dep node:http tool server
    ├── server.mjs              # /fireballs, /vessels, /exposure, /response/decision
    ├── exposure.mjs            # pure fireball→vessel zone math (unit-tested)
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
| `meteor_assess_exposure` | `POST /exposure` | Which vessels fall in a fireball's hazard zones + threat scoring. |
| `meteor_submit_response_decision` | `POST /response/decision` | Operator approval gate (`meteor_response_approval` widget). |

Routing uses the remote **`voyage`** domain (`voyage_generate_route`,
`voyage_save_voyage_optimisation_plan`, plus its supporting `voyage_*` tools) and
the `route_comparison` widget — all loaded from stage zap-sources, not in this
repo.

## Demo data

For a reliable end-to-end demo the tool server is wired to a single **real** stage
vessel that has an active voyage leg, so the `voyage_*` routing tools have backend
data to act on:

- **Hero vessel:** `Harvest Time` (IMO 9643881), bound for Rotterdam.
- **Injected fireball:** `meteor_get_fireballs` prepends a synthetic high-energy
  fireball ~25 km from the hero vessel, so `meteor_assess_exposure` reliably flags
  it `critical`.

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
