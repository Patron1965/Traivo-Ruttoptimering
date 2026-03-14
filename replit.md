# RouteAI

## Overview

AI-driven route optimization and fleet management system. Built as a pnpm workspace monorepo using TypeScript.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Database Schema

The database uses PostgreSQL with Drizzle ORM. Schema files are in `lib/db/src/schema/`:

- **organizations** — multi-tenant organizations (id, name, email)
- **vehicles** — fleet vehicles with support for fossil + electric types (capacity, battery, range)
- **customers** — delivery customers (name, address, contact info)
- **routes** — delivery routes with status tracking (draft, optimized, in_progress, completed, cancelled)
- **stops** — individual delivery stops with coordinates, time windows, weight/volume, and sequence ordering
- **routeHistory** — historical route records with snapshots

- **drivers** — fleet drivers (name, phone, email, vehicleId assignment, isActive)
- **geofenceEvents** — geofence entry/exit events (vehicleId, stopId, routeId, eventType, vehicleName, stopAddress, timestamp)
- **notifications** — system notifications (type, title, message, relatedEntityId, isRead)
- **stops.trackingCode** — customer-facing tracking code (format: `RT-XXXX`, generated during optimization)

Key enums: `vehicle_type` (fossil, electric), `route_status`, `stop_status`

## API Endpoints

All endpoints under `/api`:
- `GET /api/healthz` — health check
- `GET/POST /api/vehicles` — list/create vehicles (query: organizationId)
- `GET/PUT/DELETE /api/vehicles/:id` — get/update/delete vehicle
- `GET/POST /api/stops` — list/create stops (query: organizationId, optional routeId)
- `GET/PUT/DELETE /api/stops/:id` — get/update/delete stop
- `GET/POST /api/routes` — list/create routes (query: organizationId)
- `GET/PUT/DELETE /api/routes/:id` — get/update/delete route
- `GET /api/routes/:id/stops` — get stops for a route (ordered by sequenceOrder)
- `POST /api/optimize` — optimize route assignments using Clarke-Wright Savings algorithm (VRP with capacity, time windows, EV range + charging)
- `GET /api/dashboard/stats` — aggregated dashboard statistics
- `POST /api/stops/import` — bulk import stops from Excel/CSV data (transactional, supports weightKg/volumeM3)
- `GET /api/routes/:id/export` — export route stops as CSV download
- `GET /api/sustainability/stats` — CO₂ emissions breakdown (fossil vs EV, trees equivalent)
- `POST /api/ai/chat` — AI chat assistant (SSE streaming), accepts `{ organizationId, messages }`, streams response chunks
- `GET /api/insights` — Proactive AI fleet insights (query: organizationId, enhance=true/false). Returns deterministic fleet checks with optional AI-enhanced recommendations
- `GET/POST /api/drivers` — list/create drivers (query: organizationId)
- `GET/PUT/DELETE /api/drivers/:id` — get/update/delete driver
- `GET /api/vehicles/positions` — simulated live vehicle positions along active/optimized routes (query: organizationId)
- `GET /api/geofence/events` — recent geofence entry/exit events (query: organizationId, limit)
- `GET /api/notifications` — notifications with unread count (query: organizationId, limit)
- `PUT /api/notifications/:id/read` — mark notification as read
- `PUT /api/notifications/read-all` — mark all notifications as read (query: organizationId)
- `GET /api/track/:code` — public tracking page endpoint (no auth needed)
- `GET /api/osrm/route` — OSRM proxy for road-following route geometries (query: coords=lng,lat;lng,lat;...)

## Route Optimization

The optimize endpoint uses a nearest-neighbor heuristic with:
- Time-window-aware stop sorting
- Vehicle capacity constraints (weight + volume)
- EV range constraints (90% threshold)
- Automatic EV charging station insertion when range insufficient (10 mock Stockholm-area stations)
- 30-minute charging stop duration, resets remaining range after charging
- Haversine distance calculations
- CO2 emission estimates (0.21 kg/km fossil, 0.02 kg/km electric)

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers (health, vehicles, stops, routes, dashboard, optimize)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec. Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec.

### `artifacts/route-ai` (`@workspace/route-ai`)

React + Vite frontend for RouteAI. Dark-mode UI with sidebar navigation.

- Pages: Dashboard (`/`), Live Map (`/map`), Route Planner (`/planner`), Dispatch (`/dispatch`), All Routes (`/routes`), Create Route (`/routes/create`), Route Detail (`/routes/:id`), Fleet (`/vehicles`), Drivers (`/drivers`), Stops (`/stops`), CO₂ Dashboard (`/sustainability`), Route History (`/history`), Public Tracking (`/track/:code`)
- Uses `@workspace/api-client-react` generated React Query hooks for all API calls
- Leaflet map with OpenStreetMap tiles for route visualization
- Hardcoded ORG_ID: `63e7175d-af1d-4dc3-be62-842a8b3dc9f8` (Stockholm Logistics AB)
- Key deps: react-leaflet, leaflet, @hello-pangea/dnd, recharts, react-hook-form, lucide-react, date-fns, i18next, react-i18next
- Features: Route detail page with stop status management (mark delivered/failed/skipped, progress bar, OSRM map, auto route status transitions), clickable route cards on Routes page, EV battery bars on Fleet page, Excel/CSV import with column matching on Stops page (3-step wizard: upload → match columns → preview, auto-detects common Swedish/English header aliases, supports .xlsx/.xls/.csv with semicolon/tab/comma delimiters, RFC4180-compliant CSV parsing), route CSV export on Routes page, CO₂ sustainability dashboard with Recharts charts, AI chat assistant (floating panel with SSE streaming), proactive AI insights on dashboard, live vehicle tracking on map (3s polling), geofence circles around active stops, driver management with vehicle assignment, notification bell with dropdown, public delivery tracking page with status stepper + mini-map, tracking codes on stops, Dispatch Gantt Timeline (map+timeline split with resizable divider, driver rows, stop blocks, driving bars, stop detail panel, shift+click multi-select, drag & drop stop reassignment between drivers), OSRM road-following route polylines on map
- i18n: Swedish (default) and English via react-i18next. Translation files in `src/i18n/locales/`. Language persists via localStorage key `routeai-lang`. Language switcher (SV/EN toggle) in sidebar bottom. Config in `src/i18n/index.ts`.
- AI Chat: Floating button bottom-right opens slide-over panel. Uses `@workspace/integrations-openai-ai-server` (gpt-5-mini model). Sends fleet context + active insights with each request.
- AI Insights: Dashboard shows collapsible panel with auto-generated fleet insights (late-risk stops, battery warnings, CO₂ suggestions, capacity utilization). Deterministic checks + AI-enhanced recommendations.
- `pnpm --filter @workspace/route-ai run dev` — run the dev server

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`.

Available scripts:
- `seed` — Seeds the database with sample Stockholm-area data (organization, 4 vehicles, 12 customers, 12 stops, 2 routes)

## Seed Data

The seed creates:
- 1 organization: "Stockholm Logistics AB"
- 4 vehicles: 2 fossil (Volvo FH16, Scania R500), 2 electric (Tesla Semi, Volvo FE Electric)
- 12 customers across Stockholm
- 12 delivery stops with real Stockholm coordinates
- 2 pre-assigned routes: "Northern Stockholm Route" (fossil) and "Central Stockholm EV Route" (electric)
