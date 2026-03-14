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
The frontend, `artifacts/route-ai`, is a React + Vite application featuring a dark-mode UI with sidebar navigation. It incorporates Leaflet maps with OpenStreetMap tiles for route visualization and leverages `react-leaflet-cluster` for marker clustering. UI components include `recharts` for data visualization, `react-hook-form` for forms, and `lucide-react` for icons. The application supports internationalization (i18n) with Swedish (default) and English languages. A Command Palette (Ctrl+K) provides quick search functionality. Route polylines are status-colored to visually represent their state (draft, active, completed, cancelled, delayed).

**Technical Implementations:**
- **Monorepo Structure:** Organizes deployable applications (`artifacts/`), shared libraries (`lib/`), and utility scripts (`scripts/`) using pnpm workspaces.
- **TypeScript Configuration:** All packages extend a base `tsconfig.base.json` with `composite: true` for efficient type-checking across the monorepo.
- **API Design:** RESTful API endpoints are designed under `/api` with comprehensive CRUD operations for vehicles, stops, routes, and drivers.
- **WebSocket Integration:** A `/ws` endpoint provides real-time updates for vehicle positions, route statuses, and stop completion events, with per-organization subscriptions.
- **Database Schema:** PostgreSQL schema includes tables for organizations, vehicles (fossil and electric types), customers, routes, stops, route history, drivers, geofence events, notifications, users (with RBAC), route templates, and delivery notifications. Key fields include location data, time windows, and status tracking.
- **Validation:** Zod is used for API request and response validation, with schemas generated from an OpenAPI specification using Orval.
- **Build System:** `esbuild` is used for CJS bundling; `tsc` is primarily used for declaration emission during type-checking.

**Feature Specifications:**
- **Route Optimization:** Utilizes a nearest-neighbor heuristic with constraints for time windows, vehicle capacity (weight/volume), and EV range. Includes automatic EV charging station insertion and CO₂ emission estimates (well-to-wheel factors, load-adjusted).
- **Fleet Tracking:** Simulated live vehicle positions displayed on the map, updated via WebSockets or polling. Geofence events provide entry/exit tracking.
- **Sustainability Dashboard:** Visualizes CO₂ emissions breakdown and sustainability KPIs using `recharts`.
- **AI Integration:** An AI chat assistant (`/api/ai/chat`) provides SSE streaming responses, leveraging fleet context. Proactive AI insights (`/api/insights`) on the dashboard offer deterministic checks and AI-enhanced recommendations.
- **Data Management:** Supports bulk import of stops from Excel/CSV with column matching and export of route data as CSV.
- **User Management:** Role-based access control (admin, dispatcher, driver) with corresponding UI visibility.
- **Public Tracking:** A public-facing tracking page (`/track/:code`) allows customers to monitor delivery status.
- **Route Templates:** Functionality to save existing routes as templates and apply them to create new routes.
- **Dispatch Gantt Timeline:** A specialized interface for dispatchers with map and timeline split, enabling drag-and-drop stop reassignment between drivers.
- **Driver Mobile View:** A simplified, touch-friendly interface for drivers to manage deliveries.
- **Analytics:** Route analytics with date range filters and trend/breakdown charts.

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