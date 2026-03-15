# RouteAI

## Overview

RouteAI is an AI-driven route optimization and fleet management system designed to streamline logistics operations. Its primary purpose is to provide an efficient and intelligent solution for businesses managing delivery fleets. Key capabilities include advanced route optimization, real-time fleet tracking, sustainability insights, and AI-powered operational assistance. The project aims to reduce operational costs, minimize environmental impact through CO₂ emission tracking, and enhance delivery efficiency and customer satisfaction.

## User Preferences

- I prefer clear and concise communication.
- I expect the agent to prioritize high-level architectural and design considerations.
- I prefer an iterative development approach.
- The agent should ask for confirmation before implementing significant changes or making major architectural decisions.
- I need detailed explanations for complex solutions or reasoning behind specific technical choices.
- Do not make changes to the `lib/api-spec` folder.
- Do not make changes to the `pnpm-workspace.yaml` file.

## System Architecture

RouteAI is built as a pnpm workspace monorepo using Node.js 24 and TypeScript 5.9. The core API is developed with Express 5 and WebSockets, utilizing PostgreSQL with Drizzle ORM for data persistence.

**UI/UX Decisions:**
The frontend, `artifacts/route-ai`, is a React + Vite application featuring a dark/light theme UI with sidebar toggle. It incorporates Leaflet maps with OpenStreetMap tiles for route visualization and leverages `react-leaflet-cluster` for marker clustering. UI components include `recharts` for data visualization, `react-hook-form` for forms, and `lucide-react` for icons. The application supports internationalization (i18n) with Swedish (default) and English languages. A Command Palette (Ctrl+K) provides quick search functionality. Route polylines are status-colored to visually represent their state (draft, active, completed, cancelled, delayed).

**Technical Implementations:**
- **Monorepo Structure:** Organizes deployable applications (`artifacts/`), shared libraries (`lib/`), and utility scripts (`scripts/`) using pnpm workspaces.
- **TypeScript Configuration:** All packages extend a base `tsconfig.base.json` with `composite: true` for efficient type-checking across the monorepo.
- **API Design:** RESTful API endpoints are designed under `/api` with comprehensive CRUD operations for vehicles, stops, routes, and drivers.
- **WebSocket Integration:** A `/ws` endpoint provides real-time updates for vehicle positions, route statuses, and stop completion events, with per-organization subscriptions. Includes a disruption pipeline that handles `disruption` messages (traffic_delay, vehicle_breakdown, stop_added, stop_cancelled) with debounced auto-reoptimization (5s), broadcasts `routes:reoptimized` events, and creates system notifications.
- **Database Schema:** PostgreSQL schema includes tables for organizations, vehicles (fossil and electric types), customers, routes, stops, route history, drivers, geofence events, notifications, users (with RBAC), route templates, and delivery notifications. Key fields include location data, time windows, and status tracking.
- **Validation:** Zod is used for API request and response validation, with schemas generated from an OpenAPI specification using Orval.
- **Build System:** `esbuild` is used for CJS bundling; `tsc` is primarily used for declaration emission during type-checking.

**Feature Specifications:**
- **Route Optimization:** Uses ALNS (Adaptive Large Neighborhood Search) metaheuristic with a 30-second time budget. Destroy operators: random removal, worst removal, Shaw removal, charging station removal. Repair operators: greedy insertion, regret-2 insertion, charging station insertion. Clarke-Wright Savings generates the initial solution. Multi-objective cost function balances distance/cost, CO₂ emissions, and ETA precision with configurable weights. EV charging stations (10 built-in locations) are treated as first-class ALNS-insertable nodes with partial charging support. Distance matrix caching avoids recomputation. Incremental re-optimization endpoint (`/api/optimize/reoptimize`) handles disruptions by re-optimizing only affected routes. Predictive route risk analysis flags high-risk routes based on traffic patterns, time windows, and battery state. **Continuous Optimization:** A `ContinuousOptimizer` service (`artifacts/api-server/src/services/continuous-optimizer.ts`) wraps `runALNS` in a background loop with 100ms micro-iterations, yielding with `setImmediate` to avoid blocking the event loop. API endpoints: `POST /api/optimize/continuous/start`, `POST /api/optimize/continuous/stop`, `GET /api/optimize/continuous/status`. Improvements are broadcast via WebSocket (`optimization:improvement` event). Auto-stops after 5 minutes of no improvement or 30 minutes total. Frontend component on the Routes page shows live iterations, improvement percentage, elapsed time, and recent improvement history.
- **Traffic Prediction Heatmap:** A prediction service generates congestion heatmap data for Stockholm's road network based on time-of-day rush-hour patterns and known hotspots (T-Centralen, Norrmalm, Södermalm, etc.). REST endpoint `GET /api/predictions/traffic?bounds=lat1,lng1,lat2,lng2&horizon=30` returns grid cells with congestionScore, predictedDelayMin, and confidence. WebSocket broadcasts predictions every 30s via `traffic:predictions` message. Frontend `PredictionLayer` component renders colored rectangles on the Leaflet map with tooltips showing congestion level, delay, and confidence. Toggle button ("Trafikprediktion") available on both LiveMap and RoutePlanner pages.
- **Fleet Tracking:** Simulated live vehicle positions displayed on the map, updated via WebSockets or polling. Geofence events provide entry/exit tracking.
- **Sustainability Dashboard:** Visualizes CO₂ emissions breakdown per vehicle type (EV, hybrid, fossil) with "Trees Equivalent" savings calculation. Includes ETA Precision & Time-Window Performance section with metrics (avgTimeWindowSlackMin, stopsOnTime, stopsLate, avgDurationMin). Built with `recharts`. **Environmental Impact Beyond CO₂:** Noise impact scoring (0-100) based on time-of-day (night 22-06 = high impact) with visual level bars. PM2.5 particle emission estimation per route using vehicle-type-specific factors (EV = tyre+brake only, fossil = tyre+brake+exhaust). Environmental Score (0-100) combining CO₂ (50%), noise (25%), PM2.5 (25%) with semicircular SVG gauge. Night routes flagged with residential impact warning. Per-route environmental scores shown as compact shield badges on Routes page. **Electricity Price Optimization:** Integrates spot prices for Swedish price areas SE1-SE4 with simulated ENTSO-E-style data (fallback). `energy_prices` table caches prices, auto-refreshed every 6 hours. API endpoints: `GET /api/energy/prices?area=SE3&hours=24`, `GET /api/energy/current?area=SE3`, `GET /api/energy/optimal-window?area=SE3&duration=60&deadline=...`. Sustainability page shows 24h price curve (AreaChart), KPI cards (avg/min/max price, savings %), and optimal charging window recommendation. ALNS `chargingStationInsertion` has comment for future price-aware insertion.
- **AI Integration:** An AI chat assistant (`/api/ai/chat`) provides SSE streaming responses, leveraging fleet context. Proactive AI insights (`/api/insights`) on the dashboard offer deterministic checks and AI-enhanced recommendations. **Voice Input:** `POST /api/voice/transcribe` accepts audio (webm/wav/mp4) via multipart form-data, sends to OpenAI Whisper API for transcription with auto-detected or hinted language (Swedish/English). `VoiceButton.tsx` component uses `navigator.mediaDevices.getUserMedia` + MediaRecorder API with visual feedback (pulsing ring during recording, spinner during transcription). Integrated in ChatPanel next to send button. Works on desktop and DriverView (mobile). Uses `multer` for server-side file handling.
- **Data Management:** Supports bulk import of stops from Excel/CSV with column matching and export of route data as CSV.
- **User Management:** Role-based access control (admin, dispatcher, driver) with corresponding UI visibility.
- **Public Tracking:** A public-facing tracking page (`/track/:code`) allows customers to monitor delivery status.
- **Route Templates:** Functionality to save existing routes as templates and apply them to create new routes.
- **Dispatch Gantt Timeline:** A specialized interface for dispatchers with map and timeline split, enabling drag-and-drop stop reassignment between drivers.
- **Driver Preferences & Happiness Score:** A `driver_preferences` table stores per-driver preferences (preferred start/end time, max driving hours, break frequency/duration, avoid night driving). API endpoints `GET/PUT /api/drivers/:id/preferences` manage preferences with Zod validation and org-scoping. A Happiness Score (0-1, displayed as 0-100%) is auto-computed based on route history vs preferences (time match 60%, overtime penalty 40%). Score is exposed via `/api/drivers/:id/stats` endpoint. DriverPerformance page shows an expandable preferences form and a circular gauge for the score. DriverView (mobile) shows the score badge and a compact preferences editor.
- **Driver Mobile View:** A simplified, touch-friendly interface for drivers to manage deliveries.
- **Analytics:** Route analytics with date range filters and trend/breakdown charts.
- **Theme Toggle:** Dark/light theme support with localStorage persistence and sun/moon toggle in the sidebar.
- **Route Comparison:** Planned vs actual route comparison page with KPI delta cards, dual-polyline Leaflet map, and stop breakdown charts.
- **PDF Reports:** Client-side PDF export (jspdf + jspdf-autotable) for analytics summaries and driver performance reports.
- **Return Handling:** Reschedule failed delivery stops into a new draft route for the next day via POST `/api/routes/:id/reschedule-failed`.
- **Proof of Delivery (PoD):** Drivers can capture photo, signature, or barcode proof at each stop. `delivery_proofs` table stores proof records linked to stops. API endpoints: `POST /api/stops/:id/proof` (JSON with proofType, data, notes; 10MB body limit for base64 images), `GET /api/stops/:id/proofs`. Photos/signatures upload to object storage via presigned URLs; barcodes stored as text. Frontend components: `SignaturePad` (canvas-based touch drawing), `PhotoCapture` (camera/file input with preview), `BarcodeInput` (text input). DriverView shows a 4-button grid (PoD + Delivered/Failed/Skip) for the active stop. RouteDetail shows proof count badges per stop. Public tracking page displays proofs when delivery status is completed. i18n keys for SV/EN included.
- **Automated Customer Notifications with Live ETA:** Email notification service (`artifacts/api-server/src/services/email.ts`) sends approaching/delivered/failed emails to customers with tracking links. Console-logged in dev mode. Stops table extended with `contactName` and `contactEmail` fields. Routes table has `notifyApproaching`, `notifyDelivered`, `notifyFailed` boolean columns (default true). Geofence pipeline in `ws.ts` auto-triggers approaching notifications on zone entry and delivered notifications on zone exit. Failed notifications triggered via stop status update in `PUT /stops/:id`. Public tracking page (`/track/:code`) enhanced with live ETA countdown (computed from route progress and time windows), route progress indicator, and notification timeline showing all delivery events. RouteDetail page has notification settings panel (toggle switches for each notification type) and notification history viewer showing sent emails. `delivery_notifications` table records all sent notifications. i18n keys for SV/EN included.

- **Native Driver App (Expo):** A React Native / Expo mobile app (`artifacts/driver-app`) for delivery drivers. Three-tab layout: Routes (active route with stop list, status updates, PoD access), Map (react-native-maps with route visualization, next-stop navigation, platform-safe web fallback), Settings (driver happiness score gauge, preference editor, driver switch). Driver login screen selects from API driver list, persists to AsyncStorage. Stop status updates (delivered/failed/skip) with haptic feedback. Proof of Delivery screen with camera/image picker, barcode input, and batch submission. Uses `@tanstack/react-query` for data fetching, Inter font, green/amber color scheme. Platform-specific map component (NativeMap.tsx / NativeMap.web.tsx) avoids react-native-maps web incompatibility. Connects to existing API server endpoints.

- **Webhooks & Zapier Integration:** Webhook management system for connecting RouteAI to external services. `webhooks` table stores per-organization webhook configurations with URL, event subscriptions, HMAC-SHA256 signing secret, and active status. Dispatch service (`artifacts/api-server/src/services/webhooks.ts`) delivers payloads with HMAC-SHA256 signatures (X-RouteAI-Signature header) and 10s timeout. Events: route.created/optimized/started/completed/cancelled, stop.completed/failed/skipped, vehicle.position, notification.sent. CRUD API at `/api/webhooks` with `/api/webhooks/:id/test` for targeted single-webhook test delivery. Frontend Webhooks page (`/webhooks`, admin-only) with create form, event selector, secret management, Zapier integration guide. i18n keys for SV/EN included.

**System Design Choices:**
- **Rate Limiting:** Per-tenant rate limiting implemented in the API server.
- **Security:** Helmet security headers and CORS are configured.
- **Environment Variables:** Centralized Zod-based environment variable validation.
- **Service-Oriented Logic:** Business logic is extracted into services for better organization and reusability.

## External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **API Framework:** Express 5
- **WebSockets:** `ws` library
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval (from OpenAPI spec)
- **Mapping:** Leaflet, `react-leaflet`, `react-leaflet-cluster`
- **Routing Engine:** OSRM (for road-following route geometries)
- **Charting:** Recharts
- **Drag and Drop:** `@hello-pangea/dnd`
- **Form Management:** `react-hook-form`
- **Icons:** `lucide-react`
- **Date Utilities:** `date-fns`
- **Internationalization:** `i18next`, `react-i18next`
- **Command Palette:** `cmdk`
- **AI Model:** OpenAI (specifically `gpt-5-mini` mentioned in context of AI Chat)
- **PDF Generation:** `jspdf`, `jspdf-autotable`