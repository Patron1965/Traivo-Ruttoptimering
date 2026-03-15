# RouteAI — Systemrapport

**Fullständig teknisk rapport över systemets arkitektur, funktionalitet och teknik**

---

## 1. Sammanfattning

RouteAI är ett AI-drivet system för ruttoptimering och fordonsflotthantering, byggt för logistikföretag. Systemet kombinerar avancerade optimeringsalgoritmer, realtidsspårning, hållbarhetsanalys och AI-assistans i en enhetlig plattform.

Systemet är byggt som en TypeScript-monorepo med React-frontend, Express-backend, PostgreSQL-databas och WebSocket-kommunikation i realtid.

---

## 2. Teknisk arkitektur

### 2.1 Övergripande struktur

```
RouteAI Monorepo (pnpm workspace)
├── artifacts/
│   ├── api-server/        — Express 5 REST API + WebSocket-server
│   └── route-ai/          — React + Vite frontend-applikation
├── lib/
│   ├── api-spec/          — OpenAPI-specifikation + Orval-kodgenerering
│   ├── api-client-react/  — Autogenererad React Query-klient
│   ├── api-zod/           — Autogenererade Zod-valideringsscheman
│   └── db/                — Drizzle ORM databasschema
└── scripts/               — Verktyg och migrations-skript
```

### 2.2 Teknikstack

| Lager | Teknologi |
|---|---|
| **Språk** | TypeScript 5.9, Node.js 24 |
| **Frontend** | React 19, Vite 7, Tailwind CSS 4, Radix UI, Framer Motion |
| **Backend** | Express 5, WebSocket (ws) |
| **Databas** | PostgreSQL med Drizzle ORM |
| **AI/ML** | OpenAI GPT-5-mini (chatt), Whisper-1 (röst) |
| **Kartor** | Leaflet, React Leaflet, OSRM (routing-motor) |
| **Diagram** | Recharts |
| **Validering** | Zod (v4) med Drizzle-Zod-integration |
| **API-design** | OpenAPI 3.0 med Orval-kodgenerering |
| **Routing (frontend)** | Wouter |
| **Datahantering** | TanStack React Query |
| **i18n** | i18next (svenska + engelska) |

---

## 3. Databas — PostgreSQL-schema

Systemet använder 14 databastabeller:

### 3.1 Kärntabeller

**organizations** — Fleranvändarstöd (multi-tenant)
- `id` (UUID), `name`, `email`, `created_at`
- Alla övriga tabeller har en `organization_id`-referens hit

**users** — Systemanvändare med rollbaserad åtkomstkontroll
- `id`, `organization_id`, `name`, `email`
- `role`: admin, dispatcher eller driver
- `driver_profile_id`: valfri koppling till förarprofil

### 3.2 Fordonsflotta

**vehicles** — Fordon i flottan
- Identifiering: `name`, `license_plate`
- Typ: `vehicle_type` (fossil / electric)
- Kapacitet: `capacity_kg`, `capacity_volume` (m³)
- EV-specifikt: `battery_capacity_kwh`, `current_battery_percent`, `range_km`
- Status: `is_active`

**drivers** — Förarprofiler
- `name`, `phone`, `email`
- `vehicle_id`: tilldelat fordon
- `is_active`: tillgänglighetsstatus

**driver_preferences** — Förarönskemål och nöjdhetspoäng
- Arbetstidspreferenser: `preferred_start_time`, `preferred_end_time`
- Körregler: `max_driving_hours_per_day`, `break_frequency_minutes`
- `avoid_night_driving`: undviker nattarbete
- `happiness_score`: automatiskt beräknad nöjdhetspoäng (0–100%)

### 3.3 Rutter och leveranser

**routes** — Leveransrutter
- `vehicle_id`, `name`, `date`
- `status`: draft → optimized → in_progress → completed / cancelled
- Mätvärden: `total_distance_km`, `total_duration_min`, `total_stops`, `co2_emissions_kg`

**stops** — Enskilda leveranspunkter
- Position: `latitude`, `longitude`, `address`
- Tidsfönster: `time_window_start`, `time_window_end`
- Last: `weight_kg`, `volume_m3`, `service_duration_min`
- `status`: pending → in_progress → completed / failed / skipped
- `sequence_order`: ordning i rutten
- `tracking_code`: unik kod för kundspårning

**customers** — Mottagare av leveranser
- `name`, `email`, `phone`, `address`

**route_templates** — Sparade ruttmallar
- `stop_data` (JSONB): stoppdata för återanvändning
- `vehicle_type`: fordonstyp mallen gäller för

**route_history** — Arkiv för slutförda rutter
- `stops_snapshot` (JSONB): ögonblicksbild av alla stopp
- Prestandamätvärden för historisk analys

### 3.4 Händelser och meddelanden

**geofence_events** — Automatisk loggning av fordons ankomst/avgång
- `event_type`: entered / exited
- Kopplingar: `vehicle_id`, `stop_id`, `route_id`

**notifications** — Systemvarningar för operatörer
- `type`, `title`, `message`, `is_read`

**delivery_notifications** — Kundkommunikation
- `type`: approaching, delivered, etc.
- `channel`: kommunikationskanal

### 3.5 Extern data

**energy_prices** — Elpriscache
- `price_area` (SE1–SE4), `timestamp`, `price_eur_mwh`
- Automatisk uppdatering var 6:e timme

---

## 4. Backend-tjänster (Services)

### 4.1 ALNS Ruttoptimerare (`alns.ts` — 1 131 rader)

Hjärtat i systemet. Implementerar **Adaptive Large Neighborhood Search (ALNS)**, en metaheuristisk optimeringsalgoritm.

**Hur det fungerar:**

1. **Initial lösning** genereras med Clarke-Wright Savings-algoritmen
2. **30-sekunders tidsbudget** för iterativ förbättring
3. Varje iteration: välj en förstörelseoperator → reparationsoperator → utvärdera

**Förstörelseoperatorer** (tar bort stopp från rutter):
- Random Removal — slumpmässigt urval
- Worst Removal — tar bort stopp med högst kostnad
- Shaw Removal — tar bort liknande/närliggande stopp
- Charging Station Removal — optimerar laddstationer

**Reparationsoperatorer** (sätter tillbaka stopp i bästa position):
- Greedy Insertion — billigaste insättning
- Regret-2 Insertion — beaktar alternativkostnad
- Charging Station Insertion — infogar laddstationer vid behov

**Flermålsoptimering** — Kostnadsfunktionen balanserar:
- Avstånd/körkostnad
- CO₂-utsläpp
- ETA-precision (tidsfönsterpålitlighet)

**EV-laddningsstöd:**
- 10 inbyggda laddstationspositioner i Stockholmsområdet
- Laddstationer behandlas som fullvärdiga ALNS-insättningsbara noder
- Stöd för delvis laddning baserat på batterinivå och fordonets räckvidd

**Avståndmatris-cache:** Undviker omberäkning vid upprepade optimeringar.

### 4.2 Kontinuerlig optimerare (`continuous-optimizer.ts`)

Bakgrundsprocess som kör ALNS i 100ms-mikroiterationer med `setImmediate` för att inte blockera serverns event loop.

- Auto-stoppar efter 5 minuter utan förbättring eller 30 minuter totalt
- Förbättringar broadcastas via WebSocket (`optimization:improvement`)
- Starta/stoppa via API

### 4.3 Trafikprediktioner (`prediction.ts`)

Genererar trafikprognos-heatmapdata för Stockholms vägnät:
- Tidsberoende rusningsmodeller (morgon- och kvällstrafik)
- Kända trafikhotspots: T-Centralen, Norrmalm, Södermalm, Slussen, m.fl.
- Returnerar rutnätsceller med kongestionspoäng, förväntad försening och konfidensnivå
- WebSocket-broadcast var 30:e sekund

### 4.4 Hållbarhetstjänst (`sustainability.ts`)

Beräknar miljöpåverkan utöver CO₂:

**Bullermodell** (`calculateNoiseImpact`):
- Poängsättning 0–100 baserat på tid på dygnet
- Natt (22:00–06:00): baspoäng 40 + 15 per nattimme
- Bostadsområdesdetektering via stoppaddresser (svenska/engelska nyckelord)
- Bostadsbonus: +20 nattetid, +5 dagtid

**Partikelmodell** (`estimateParticleEmissions`):
- PM2.5-uppskattning per fordonstyp
- Elbil: däck- och bromsslitage (0.012 g/km)
- Fossil: däck + bromsar + avgaser (0.014 + 0.045 g/km)
- Hastighetsfaktor: låg hastighet (<20 km/h) = 40% högre utsläpp
- Bromsfaktor: 2 bromshändelser per stopp × 0.002g per händelse

**Miljöpoäng** (`calculateEnvironmentalScore`):
- Viktad sammanslagning: CO₂ 50%, buller 25%, PM2.5 25%
- Skala 0–100 där 100 = minimal miljöpåverkan

### 4.5 Elprisoptimering (`electricity.ts`)

Integration med nordiska elmarknaden:
- Stöd för prisområden SE1–SE4
- ENTSO-E API-integration (UTC-format `YYYYMMDDHHMM`)
- Fallback-prisgenerering när API saknas
- Databaslagring med automatisk uppdatering var 6:e timme
- `getOptimalChargingWindow()`: beräknar billigaste laddfönstret

### 4.6 ETA-tjänst (`eta.ts`)

- Beräknar tidsfönstermarginaler per stopp
- Spårar i-tid- vs försenade leveranser
- Medelleveranstid och total ruttsstatistik

### 4.7 AI-insikter (`insights.ts`)

- Regelbaserade kontroller: förseningsrisker, effektiviseringsmöjligheter
- AI-berikade rekommendationer via OpenAI
- Prioriterade insikter med typ och allvarlighetsgrad

---

## 5. API-ändpunkter

Systemet exponerar 50+ REST-ändpunkter plus WebSocket:

### 5.1 Fordonshantering (`/api/vehicles`)
| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/vehicles` | Lista alla fordon |
| GET | `/vehicles/:id` | Hämta ett fordon |
| POST | `/vehicles` | Skapa nytt fordon |
| PUT | `/vehicles/:id` | Uppdatera fordon |
| DELETE | `/vehicles/:id` | Ta bort fordon |

### 5.2 Leveransstopp (`/api/stops`)
| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/stops` | Lista stopp (filtrering per rutt/organisation) |
| GET | `/stops/:id` | Hämta ett stopp |
| POST | `/stops` | Skapa nytt stopp |
| POST | `/stops/import` | Bulkimport från Excel/CSV |
| PUT | `/stops/:id` | Uppdatera stopp |
| DELETE | `/stops/:id` | Ta bort stopp |

### 5.3 Rutter (`/api/routes`)
| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/routes` | Lista rutter (statusfilter) |
| GET | `/routes/:id` | Hämta rutt |
| GET | `/routes/:id/stops` | Stopp i sekvensordning |
| GET | `/routes/:id/export` | CSV-export |
| GET | `/routes/:id/comparison` | Planerat vs faktiskt resultat |
| POST | `/routes` | Skapa rutt |
| POST | `/routes/:id/reschedule-failed` | Omboka misslyckade stopp |
| PUT | `/routes/:id` | Uppdatera rutt |
| PUT | `/routes/:id/reorder-stops` | Ändra stoppordning |
| DELETE | `/routes/:id` | Ta bort rutt |

### 5.4 Optimering (`/api/optimize`)
| Metod | Sökväg | Beskrivning |
|---|---|---|
| POST | `/optimize` | Kör ALNS-optimering |
| POST | `/optimize/reoptimize` | Inkrementell omoptimering |
| POST | `/optimize/continuous/start` | Starta bakgrundsoptimering |
| POST | `/optimize/continuous/stop` | Stoppa bakgrundsoptimering |

### 5.5 AI och röst
| Metod | Sökväg | Beskrivning |
|---|---|---|
| POST | `/ai/chat` | AI-chatt (SSE-streaming) |
| GET | `/insights` | AI-berikade insikter |
| POST | `/voice/transcribe` | Rösttranskribering (Whisper) |

### 5.6 Förare (`/api/drivers`)
| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/drivers` | Lista förare |
| GET | `/drivers/:id` | Hämta förare |
| GET | `/drivers/:id/stats` | Prestandastatistik + nöjdhetspoäng |
| GET | `/drivers/:id/preferences` | Hämta förarönskemål |
| POST | `/drivers` | Lägg till förare |
| PUT | `/drivers/:id` | Uppdatera förare |
| PUT | `/drivers/:id/preferences` | Uppdatera önskemål |
| DELETE | `/drivers/:id` | Ta bort förare |

### 5.7 Hållbarhet och energi
| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/sustainability/stats` | Miljömätvärden (CO₂, buller, PM2.5) |
| GET | `/energy/prices` | Elprishistorik per område |
| GET | `/energy/current` | Aktuellt spotpris |
| GET | `/energy/optimal-window` | Optimalt laddfönster |

### 5.8 Övriga ändpunkter
| Metod | Sökväg | Beskrivning |
|---|---|---|
| GET | `/dashboard/stats` | Dashboard-aggregat |
| GET | `/analytics` | Historisk analys med datumfilter |
| GET | `/notifications` | Systemnotifikationer |
| GET | `/track/:code` | Offentlig kundspårning |
| GET | `/osrm/route` | Vägföljande ruttgeometrier (OSRM-proxy) |
| GET | `/healthz` | Serverstatus, DB-latens, minnesanvändning |

### 5.9 WebSocket (`/ws`)

Realtidskommunikation per organisation:
- `vehicle:position` — Fordonspositionsuppdateringar
- `route:status` — Ruttstatusändringar
- `stop:completed` — Leveranser slutförda
- `disruption` — Störningar (traffic_delay, vehicle_breakdown, stop_added, stop_cancelled)
- `routes:reoptimized` — Resultat av automatisk omoptimering
- `optimization:improvement` — Kontinuerlig optimeringsframsteg
- `traffic:predictions` — Trafikprediktion-heatmap (var 30:e sekund)

---

## 6. Frontend — Sidor och användargränssnitt

### 6.1 Översikt (Dashboard) — `/`
- Nyckeltal: totalt avstånd, CO₂, aktiva förare/fordon, väntande stopp
- Aktiva rutter med statusindikatorer
- AI-drivna insikter och rekommendationer

### 6.2 Livekarta — `/map`
- Fullskärms interaktiv karta (Leaflet + OpenStreetMap)
- Fordonspositioner i realtid med riktning och batterinivå
- Kluster-gruppering vid utzoomning
- Trafikprediktion-heatmap (toggle-knapp)
- Ruttpolylinjer färgade efter status

### 6.3 Ruttplanerare — `/planner`
- Tilldela stopp till fordon
- Kör ALNS-optimering
- Visuell karta med rutt- och stoppöverlagring
- Trafikprediktion-toggle

### 6.4 Dispatch — `/dispatch`
- Gantt-tidslinje för förarscheman
- Karta + tidslinje delad vy
- Drag-and-drop stoppomtilldelning mellan förare

### 6.5 Alla rutter — `/routes`
- Ruttkort med fordon, förare, avstånd, tid
- Miljöpoäng-badge (grön/gul/röd) per rutt
- Live-optimeringswidget (start/stopp, iterationer, förbättring %)
- CSV-export och PDF-rapporter

### 6.6 Ruttdetalj — `/routes/:id`
- Karta med alla stopp och ruttlinje
- Stoppsekvens med tidsfönster
- Ruttmätvärden: avstånd, tid, CO₂

### 6.7 Ruttjämförelse — `/routes/:id/comparison`
- Planerat vs faktiskt: KPI-deltakort
- Dubbla polylinjer på kartan
- Stoppnedbrytningsdiagram

### 6.8 Hållbarhet — `/sustainability`
- **CO₂-översikt**: Total, fossil, EV, hybrid med cirkeldiagram
- **Optimeringsmått**: ALNS-algoritm, CO₂-besparing, antal rutter
- **Elprisoptimering**: 24h priskurva (SE1–SE4), KPI-kort, optimalt laddfönster
- **ETA-precision**: Tidsfönsterslack, i-tid/försenat, medellängd
- **Miljöpåverkan utöver CO₂**:
  - SVG-mätare för miljöpoäng (0–100)
  - Bullernivåstaplar med bostadsområdesvarning
  - PM2.5-panel med WHO-jämförelse
- **Trädmotsvarighet**: CO₂-besparingar uttryckt i planterade träd

### 6.9 Fordonsflotta — `/vehicles`
- Lista och hantera fordon
- EV-specifika fält: batteri, räckvidd

### 6.10 Förare — `/drivers`
- Förarlista med tilldelat fordon
- Förarprestation: nöjdhetspoäng, önskemålsformulär
- Cirkulär mätare för Happiness Score

### 6.11 Stopp — `/stops`
- Hantering av leveranspunkter
- Bulkimport från Excel/CSV med kolumnmatchning

### 6.12 Förarvy (mobil) — `/driver-view`
- Touch-vänligt gränssnitt
- Aktuellt stopp, navigering, ruttframsteg
- Nöjdhetspoäng-badge
- Kompakt önskemålsredigering
- Röstinmatning till AI-chatt

### 6.13 Kundspårning (publik) — `/track/:code`
- Ingen inloggning krävs
- Leveransstatus i realtid
- Beräknad ankomsttid

### 6.14 Analys — `/analytics`
- Historisk prestandadata
- Datumfilter och trenddiagram
- Nedbrytning per fordonstyp
- PDF-exportfunktion

### 6.15 Rutthistorik — `/route-history`
- Arkiv över slutförda rutter
- Prestandaöversikt per rutt

---

## 7. AI-funktioner

### 7.1 AI-chattassistent

- **Modell:** OpenAI GPT-5-mini
- **Strömmande svar** via Server-Sent Events (SSE)
- **Flottkontext:** Assistenten har tillgång till aktuell data om fordon, rutter, stopp och insikter
- **Tvåspråkig:** Svarar på svenska och engelska
- **Integration:** Flytande chattfönster tillgängligt på alla sidor

### 7.2 Röststyrning

- **Modell:** OpenAI Whisper-1
- **Mediaformat:** WebM, WAV, MP4
- **Flöde:** Mikrofon → MediaRecorder → Multipart upload → Whisper → Text → AI-chatt
- **UI-feedback:** Pulserande ring vid inspelning, spinner vid transkribering
- **Språk:** Automatisk detektering (svenska/engelska)

### 7.3 Proaktiva insikter

- Regelbaserade kontroller körs kontinuerligt
- AI-berikade rekommendationer med prioritering
- Insiktskategorier: förseningsrisker, kapacitetsvarningar, effektiviseringsförslag

---

## 8. Realtidssystem

### 8.1 WebSocket-arkitektur

- Per-organisationsprenumerationer
- Automatisk disruptions-pipeline:
  1. Mottar störning (trafikförsening, fordonsfel, nytt stopp)
  2. 5-sekunders debounce
  3. Automatisk omoptimering via ALNS
  4. Broadcast av resultatet
  5. Systemnotifikation skapas

### 8.2 Geofencing

- Automatisk detektering av fordons ankomst/avgång vid stopp
- Baserat på GPS-position och stoppradie
- Uppdaterar stoppstatus automatiskt (pending → in_progress → completed)
- Loggas i `geofence_events`-tabellen

### 8.3 Trafikprediktion

- Heatmap broadcastas var 30:e sekund
- Rutnätsceller med kongestionspoäng, försening och konfidens
- Visualiseras som färgade rektanglar på Leaflet-kartan
- Tillgänglig på livekarta och ruttplanerare

---

## 9. Säkerhet och systemdesign

| Aspekt | Implementering |
|---|---|
| **Multi-tenant** | Alla data scopas per organisation via `organization_id` |
| **RBAC** | Tre roller: admin, dispatcher, driver |
| **Rate limiting** | Per-tenant begränsningar på API-anrop |
| **Säkerhetsheaders** | Helmet.js konfigurerat |
| **CORS** | Konfigurerat för tillåtna origins |
| **Miljövariabler** | Centraliserad Zod-validering |
| **Validering** | Zod-scheman på alla API-ingångar och -utgångar |

---

## 10. Kodgenereringsflöde

```
OpenAPI-specifikation (lib/api-spec/openapi.yaml)
    ↓ Orval
┌───────────────────────────────┐
│ lib/api-client-react/         │ → React Query hooks & TypeScript-typer
│ lib/api-zod/                  │ → Zod-valideringsscheman
└───────────────────────────────┘
```

En central OpenAPI-specifikation definierar alla API-kontrakt. Orval genererar automatiskt:
- **React Query hooks** med fullständiga TypeScript-typer
- **Zod-valideringsscheman** för runtime-validering
- Ingen manuell typsynkronisering behövs mellan frontend och backend

---

## 11. Internationalisering (i18n)

- **Ramverk:** i18next med react-i18next
- **Språk:** Svenska (standard) och engelska
- **Omfattning:** Alla UI-texter, navigering, felmeddelanden, enheter
- **Växling:** Språkväxlare i sidopanelen (SV/EN)

---

## 12. Systemets nyckeltal

| Mätvärde | Värde |
|---|---|
| Antal källkodsfiler | ~460 TypeScript/TSX-filer |
| ALNS-optimerare | 1 131 rader |
| Databastabeller | 14 stycken |
| API-ändpunkter | 50+ REST + WebSocket |
| Frontend-sidor | 18 sidor |
| Backend-tjänster | 7 specialtjänster |
| Stödda språk | 2 (svenska, engelska) |
| Fordonstyper | 3 (fossil, electric, hybrid) |
| Optimeringsoperatorer | 4 förstörelse + 3 reparation |
| Elområden | 4 (SE1–SE4) |
| Laddstationer | 10 (Stockholm) |

---

## 13. Funktionsöversikt — Komplett lista

1. **ALNS Ruttoptimering** — Adaptiv metaheuristik med 30s tidsbudget
2. **Kontinuerlig bakgrundsoptimering** — 100ms-iterationer utan att blockera servern
3. **Inkrementell omoptimering** — Hanterar störningar i realtid
4. **EV-laddningsplanering** — Automatisk infogning av laddstationer
5. **Trafikprediktion-heatmap** — Stockholms vägnät med kongestionsdata
6. **Realtidsflottspårning** — WebSocket-baserade fordonspositioner
7. **Geofencing** — Automatisk ankomst/avgångsdetektering
8. **CO₂-hållbarhetspanel** — Utsläppspårning per fordonstyp
9. **Miljöpoäng** — Sammanvägt buller, PM2.5 och CO₂ per rutt
10. **Bullermodellering** — Nattruttsdetektering + bostadsområdesanalys
11. **PM2.5-partikelutsläpp** — Hastighets- och bromsfaktorbaserat
12. **Elprisoptimering** — ENTSO-E-priser (SE1–SE4) med optimalt laddfönster
13. **AI-chattassistent** — GPT-5-mini med flottkontext och SSE-streaming
14. **Röststyrning** — OpenAI Whisper med MediaRecorder
15. **Proaktiva AI-insikter** — Regelbaserade + AI-berikade rekommendationer
16. **Förarpreferenser** — Önskemål och automatisk nöjdhetspoäng (Happiness Score)
17. **Dispatch Gantt-tidslinje** — Drag-and-drop stoppomtilldelning
18. **Excel/CSV-import** — Bulkimport med kolumnmatchning
19. **CSV/PDF-export** — Rutter, analys och förarrapporter
20. **Ruttjämförelse** — Planerat vs faktiskt med deltakort
21. **Ruttmallar** — Spara och återanvänd ruttmönster
22. **Kundspårning** — Publik sida utan inloggning
23. **Leveransnotifikationer** — Automatiska statusuppdateringar
24. **Rutthistorik** — Arkiv med prestandaöversikt
25. **Return Handling** — Omboka misslyckade stopp till nästa dag
26. **Kommandopalett** — Ctrl+K snabbsökning
27. **Mörkt/ljust tema** — Temabyte med localStorage
28. **Rollbaserad åtkomst** — Admin, dispatcher, driver
29. **Multi-tenant** — Organisationsisolering
30. **Mobilanpassad förarvy** — Touch-vänlig leveranslista

---

*Rapport genererad 2026-03-15*
*RouteAI v1.0 — Stockholm Logistics AB*
