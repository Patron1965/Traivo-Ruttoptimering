# Traivo Route

## Overview

Traivo Route is an AI-driven route optimization and fleet management system designed to streamline logistics operations. Its primary purpose is to provide an efficient and intelligent solution for businesses managing delivery fleets. Key capabilities include advanced route optimization, real-time fleet tracking, sustainability insights, and AI-powered operational assistance. The project aims to reduce operational costs, minimize environmental impact through CO₂ emission tracking, and enhance delivery efficiency and customer satisfaction. The business vision is to become the leading intelligent logistics platform, offering significant market potential by improving efficiency and sustainability for delivery-based businesses.

## User Preferences

- I prefer clear and concise communication.
- I expect the agent to prioritize high-level architectural and design considerations.
- I prefer an iterative development approach.
- The agent should ask for confirmation before implementing significant changes or making major architectural decisions.
- I need detailed explanations for complex solutions or reasoning behind specific technical choices.
- Do not make changes to the `lib/api-spec` folder.
- Do not make changes to the `pnpm-workspace.yaml` file.

## System Architecture

Traivo Route is built as a pnpm workspace monorepo using Node.js 24 and TypeScript 5.9. The core API is developed with Express 5 and WebSockets, utilizing PostgreSQL with Drizzle ORM for data persistence.

**UI/UX Decisions:**
The frontend, `artifacts/route-ai`, is a React + Vite application featuring a dark/light theme UI. It incorporates Leaflet maps for route visualization and `react-leaflet-cluster` for marker clustering. UI components include `recharts` for data visualization and `lucide-react` for icons. The application supports internationalization with Swedish (default) and English languages. A Command Palette provides quick search functionality. Route polylines are status-colored to visually represent their state.

**Technical Implementations:**
- **Monorepo Structure:** Organizes deployable applications (`artifacts/`), shared libraries (`lib/`), and utility scripts (`scripts/`) using pnpm workspaces.
- **API Design:** RESTful API endpoints for CRUD operations.
- **WebSocket Integration:** A `/ws` endpoint provides real-time updates and handles disruption-triggered re-optimization.
- **Database Schema:** PostgreSQL schema includes tables for organizations, vehicles, customers, routes, stops, and drivers, with comprehensive tracking and notification features.
- **Validation:** Zod is used for API request and response validation, with schemas generated from an OpenAPI specification.

**Feature Specifications:**
- **Route Optimization:** Uses ALNS metaheuristic with configurable weights for distance, CO₂, ETA precision, and driver happiness. Driver constraints (max hours, night driving avoidance, preferred start/end times) are loaded from DB and penalize routes that violate driver preferences. Supports EV charging station integration and incremental re-optimization. A continuous optimizer runs in the background. Predictive route risk analysis is included. **OSRM Integration:** Real road distances via OSRM Table API are pre-computed before optimization starts, with geohash-keyed LRU cache (50k entries) and automatic Haversine fallback. OSRM travel durations used for ETA when available. Configure via `OSRM_BASE_URL` env var (defaults to public OSRM server). **Extended ALNS Operators:** Destroy ops: random, worst, Shaw (multi-dimensional relatedness: spatial+temporal+capacity), relatedness removal, route removal (removes worst cost-per-stop route), time-window removal (removes tightest-slack nodes), charging_remove. Repair ops: greedy, regret-k (k=3), charging_insert. **2-opt/or-opt local search** post-processing on best solution with full objective-aware acceptance and time-budgeted (3s cap). **Large-scale support (500+ stops):** DBSCAN consensus clustering (5 runs with varied parameters) uses a composite distance metric (60% geographic + 40% temporal) with adaptive eps to split stops into density-based clusters respecting time-window compatibility. Soft border stops (30-70% co-occurrence across runs) are identified and improved via cross-cluster relocation pass. Falls back to k-means if DBSCAN produces degenerate clusters. Each cluster optimized independently with ALNS, then merged. Async job system with `POST /api/optimize` (returns jobId) + `GET /api/optimize/status/:jobId` polling. Max timeBudgetMs raised to 120s. Frontend search/filter in stop list, progress indicator for large jobs.
- **Traffic Prediction Heatmap:** A service generates congestion heatmap data for Stockholm, displayed on the map with real-time updates.
- **Fleet Tracking:** Simulated live vehicle positions and geofence events for entry/exit tracking.
- **Sustainability Dashboard:** Visualizes CO₂ emissions, noise impact, PM2.5 particle estimation, and an Environmental Score. Integrates electricity spot prices for optimal EV charging.
- **AI Integration:** An AI chat assistant provides SSE streaming responses and proactive AI insights. Voice input (transcribed by OpenAI Whisper) is integrated into the chat.
- **Data Management:** Supports bulk import/export of route data.
- **User Management:** Role-based access control.
- **Public Tracking:** A public-facing page for customer delivery monitoring with live ETA.
- **Route Templates:** Save and apply route configurations.
- **Dispatch Gantt Timeline:** Drag-and-drop interface for stop reassignment.
- **Driver Preferences & Happiness Score:** Stores driver preferences and calculates a happiness score based on route adherence.
- **Driver Mobile View:** A simplified, touch-friendly interface for drivers to manage deliveries and proof of delivery.
- **Analytics:** Route analytics with date range filters and charts.
- **Route Comparison:** Compares planned vs. actual routes with KPIs.
- **PDF Reports:** Client-side PDF export for analytics and performance reports.
- **Return Handling:** Reschedule failed deliveries.
- **Proof of Delivery (PoD):** Drivers can capture photo, signature, or barcode proof at stops, displayed on the public tracking page.
- **Automated Customer Notifications with Live ETA:** Email notifications for approaching, delivered, or failed deliveries with tracking links and a notification history.
- **Native Driver App (Expo):** A React Native / Expo mobile app ("Traivo Route Driver") for drivers with route management, map visualization, and PoD capabilities. Features include: multi-route selector with vehicle info (name + license plate), OSRM road-following route polylines on the map, driver preferences editing (start/end time, max hours, night driving), happiness score gauge, and full proof-of-delivery (photo capture, touch-based signature pad, barcode entry).
- **Webhooks & Zapier Integration:** Configurable webhooks for external service integration with HMAC-SHA256 signing.
- **Shopify Order Import:** Connect Shopify stores via Admin API access token, import unfulfilled orders as delivery stops with geocoded addresses, track import history, and update fulfillment status back to Shopify when deliveries complete. Settings page at `/shopify`.

**System Design Choices:**
- **Rate Limiting:** Per-tenant rate limiting.
- **Security:** Helmet security headers and CORS.
- **Environment Variables:** Zod-based validation.
- **Service-Oriented Logic:** Business logic organized into services.
- **Subscription & Billing:** Three-tier plan system (Starter/Pro/Enterprise) with `subscription_plans` and `subscriptions` tables. Plan enforcement tracks vehicle, driver and stop limits per organization. Billing page at `/billing` shows current plan, usage meters, and plan comparison. Self-service signup with 14-day trial on Starter plan.

## External Dependencies

- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **API Framework:** Express 5
- **WebSockets:** `ws` library
- **Validation:** Zod (`zod/v4`), `drizzle-zod`
- **API Codegen:** Orval
- **Mapping:** Leaflet, `react-leaflet`, `react-leaflet-cluster`
- **Routing Engine:** OSRM
- **Charting:** Recharts
- **Drag and Drop:** `@hello-pangea/dnd`
- **Form Management:** `react-hook-form`
- **Icons:** `lucide-react`
- **Date Utilities:** `date-fns`
- **Internationalization:** `i18next`, `react-i18next`
- **Command Palette:** `cmdk`
- **AI Model:** OpenAI
- **PDF Generation:** `jspdf`, `jspdf-autotable`