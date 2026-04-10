# 🚀 Traivo Ruttplanering — Komplett Produktdokumentation

> **Version:** 1.0  
> **Datum:** 2026-04-10  
> **Status:** Aktiv utveckling  
> **Plattform:** Dedikerad server / molnhosting  
> **Målgrupp:** Medelstora till stora företag med 10–500 fordon

---

## Innehållsförteckning

1. [Översikt & Vision](#1-översikt--vision)
2. [Målgrupp & Användarprofil](#2-målgrupp--användarprofil)
3. [Nuvarande Implementation](#3-nuvarande-implementation)
4. [Avancerade Algoritmer](#4-avancerade-algoritmer)
5. [Innovativa Features](#5-innovativa-features)
6. [Teknisk Arkitektur](#6-teknisk-arkitektur)
7. [Realtidsoptimering](#7-realtidsoptimering)
8. [Miljö & Hållbarhet](#8-miljö--hållbarhet)
9. [AI & Maskininlärning](#9-ai--maskininlärning)
10. [Skalbarhet & Prestanda](#10-skalbarhet--prestanda)
11. [Feature Roadmap](#11-feature-roadmap)
12. [Konkurrensfördelar](#12-konkurrensfördelar)
13. [KPI:er & Målsättningar](#13-kpier--målsättningar)
14. [Skillnader mot Traivo One](#14-skillnader-mot-traivo-one)

---

## 1. Översikt & Vision

### Vad är Traivo Ruttplanering?

Traivo Ruttplanering är ett **avancerat, AI-drivet ruttoptimeringssystem** byggt för medelstora och stora leveransflottor. Det kombinerar klassisk Operations Research med modern maskininlärning för att leverera optimala rutter i realtid.

### Vision

> **"Det smartaste ruttplaneringssystemet för svenska SMB — som blir bättre för varje leverans."**

Traivo Ruttplanering strävar efter att vara:
- 🧠 **Intelligent** — AI som lär sig av varje leverans
- 🌱 **Hållbart** — Aktivt miljöoptimerade rutter (CO₂, buller, partiklar)
- ⚡ **Realtid** — Levande rutter som anpassar sig till verkligheten
- 📊 **Prediktivt** — Förutsäga problem innan de uppstår

### Kärnlöfte

| Dimension | Löfte |
|-----------|-------|
| **Ruttkvalitet** | 95%+ av matematiskt optimal lösning |
| **Hastighet** | 500 stopp optimerade på < 30 sekunder |
| **ETA-precision** | ± 4 minuters noggrannhet |
| **CO₂-besparing** | 25–35% jämfört med manuell planering |
| **Realtidsreaktion** | < 10 sekunders anpassning vid störning |

---

## 2. Målgrupp & Användarprofil

### Primär målgrupp

| Segment | Storlek | Exempel |
|---------|---------|----------|
| **Paketleverans** | 20–200 fordon | Regionala paketbolag |
| **Dagligvarudistribution** | 10–50 fordon | Matgrossister, livsmedel |
| **Fältservice** | 10–100 tekniker | Installation, underhåll |
| **Hemtjänst (stor)** | 50–300 personal | Kommunala hemtjänstbolag |
| **E-handel (stor)** | 30–200 fordon | D2C med egna leveranser |
| **Avfallshantering** | 20–100 fordon | Sophämtning, återvinning |

### Användarroller

| Roll | Beskrivning |
|------|-------------|
| **Admin** | Systemkonfiguration, användare, prenumerationer |
| **Dispatcher** | Daglig planering, realtidsövervakning, beslut |
| **Förare** | Ruttexekvering, statusrapportering, navigering |
| **Analytiker** | Rapporter, KPI-uppföljning, optimeringsinsikter |
| **Kund-API** | Tredjepartssystem som integrerar via API/webhook |

---

## 3. Nuvarande Implementation

### 3.1 Arkitekturöversikt

| Komponent | Teknologi | Mognad |
|-----------|-----------|--------|
| Backend API | Express 5, Node.js 24 | ⭐⭐⭐⭐ Solid |
| Frontend | React 19, Vite 7, Tailwind CSS 4 | ⭐⭐⭐⭐ Modern |
| Databas | PostgreSQL + Drizzle ORM | ⭐⭐⭐⭐ Välstrukturerad |
| Optimeringsmotor | ALNS (TypeScript, 1 388 rader) | ⭐⭐⭐ Bra grund |
| AI-integration | OpenAI GPT-5-mini | ⭐⭐⭐ Grundläggande |
| Kartor/Routing | Leaflet + OSRM | ⭐⭐⭐ Funktionellt |
| Realtid | WebSocket | ⭐⭐⭐ Grundläggande |
| API-design | OpenAPI 3.0 + Orval + Zod | ⭐⭐⭐⭐ Professionellt |
| Förarapp | React Native (Expo) | ⭐⭐⭐ Tidig fas |
| Hållbarhet | CO₂, PM2.5, buller | ⭐⭐⭐⭐ Unikt och starkt |

### 3.2 Implementerade funktioner

#### ✅ Optimeringsmotor — ALNS

- **Adaptive Large Neighborhood Search** med simulated annealing
- **4 destroy-operatorer:** Random, Worst, Shaw (spatial), Charging Station removal
- **3 repair-operatorer:** Greedy insertion, Regret-2 insertion, Charging station insertion
- **Multi-objektiv kostnadsfunktion:**
  - Distans: 45%
  - CO₂-utsläpp: 25%
  - ETA-precision: 15%
  - Förarnöjdhet: 15%
- **Clarke-Wright savings** för initiallösning
- **k-means klustring** för instanser > 100 stopp
- **EV-stöd:** Automatisk laddstationsinsättning med räckviddsberäkning
- **Inkrementell re-optimering** för störningar
- **Continuous Optimizer** med progressiva WebSocket-uppdateringar
- **Tidsberoende ETA** med hastighetsprofiler per timme

#### ✅ Hållbarhetsmodul (unik styrka)

- CO₂-emissionsberäkning per fordonstyp (diesel, el, hybrid) med well-to-wheel-faktor
- Partikelutsläpp (PM2.5) med broms-/däckslitage och avgasfaktorer
- Bulleranalys med natt-/bostadsområdesdetektering
- Miljöpoäng per rutt (0–100)
- Trädequivalenter för CO₂-besparingar

#### ✅ Intelligent Insights Engine

- 12+ automatiska insiktstyper
- Realtidsvarningar (sena leveranser, låg batterinivå, kapacitetsöverskridande)
- Prediktiv riskanalys (rushtid, trånga tidsfönster, historisk misslyckanderate)
- AI-berikade rekommendationer via GPT-5-mini

#### ✅ AI Chat Assistant

- Kontextuell chatbot med full flottöversikt
- Streaming SSE-svar
- Proaktiva insikter i konversationen

#### ✅ Fullständig SaaS-plattform

- Multi-tenant arkitektur
- Rollbaserad åtkomst (admin, dispatcher, driver)
- Prenumerationsplaner (starter / pro / enterprise)
- Shopify-integration
- Webhook-system
- Leveransbevis (signatur, foto, streckkod)
- Kundnotifieringar & spårningssida
- i18n (svenska/engelska)
- Gantt-tidslinje för dispatch

### 3.3 Styrkor

1. **Sofistikerad ALNS** — Adaptiv operatorviktning, SA-acceptans, multi-objektiv
2. **Hållbarhetsfokus som differentiator** — PM2.5, bulleranalys, miljöpoäng
3. **Full vertikal integration** — Optimering → förarapp → kundspårning
4. **Modern teknikstack** — TypeScript end-to-end, autogenererade API-klienter
5. **SaaS-redo** — Multi-tenant, prenumerationer, webhooks
6. **Prediktiv insiktsmotor** — Historisk misslyckanderate per adress/område

### 3.4 Kända begränsningar att åtgärda

#### 🔴 Kritiska

| # | Begränsning | Påverkan | Åtgärd |
|---|-------------|----------|--------|
| 1 | **Haversine-avstånd i optimeringsloopen** | 15–30% felberäkning | OSRM Table API med LRU-cache |
| 2 | **Simulerad trafikprediktion** | Opålitliga ETA:er | HERE/TomTom Traffic API |
| 3 | **Statiska ETA-profiler** | Ignorer fordonstyp, väder, last | ML-modell (Transformer/GBM) |
| 4 | **k-means bryter global optimering** | Suboptimala klustergränser | DBSCAN + konsensusklustring |
| 5 | **ALNS i TypeScript** | Begränsar skalbarhet | Rust/WASM-port |

#### 🟡 Viktiga

| # | Begränsning | Åtgärd |
|---|-------------|--------|
| 6 | Ingen riktig realtidsoptimering | Event-driven disruption engine |
| 7 | Max 5 laddstationer per rutt | Dynamisk gräns |
| 8 | Saknar pickup & delivery (PDP) | PDP-stöd i ALNS |
| 9 | Ingen multi-depot | Multi-depot support |
| 10 | Ingen väder-/säsongsintegrering | SMHI API |
| 11 | Saknar kör-/vilotidsregler | EU-regelmodul |
| 12 | Shaw-removal bara spatial | Utöka med temporal/kapacitet |
| 13 | Regret-2 bör vara Regret-k | Implementera Regret-k |

---

## 4. Avancerade Algoritmer

### 4.1 ALNS+ — Utökad metaheuristik

#### Nya destroy-operatorer

```typescript
interface ExtendedDestroyOperators {
  // 4-dimensionell relatedness removal
  relatedRemoval(solution, count, weights: {
    spatial: 0.4,     // Avstånd
    temporal: 0.3,    // Tidsfönster-överlapp
    capacity: 0.2,    // Liknande lastvikt
    historical: 0.1   // Samma rutt i historik
  }): ALNSNode[];

  // Ta bort hela rutter
  routeRemoval(solution, numRoutes): ALNSNode[];

  // Tidsfönster-baserad removal
  timeWindowRemoval(solution, count): ALNSNode[];

  // Proximity — stopp nära slumpmässig punkt
  proximityRemoval(solution, count, radius): ALNSNode[];

  // Historik-driven — stopp som ofta ändras
  historicalRemoval(solution, count, history): ALNSNode[];
}
```

#### Nya repair-operatorer

```typescript
interface ExtendedRepairOperators {
  // Regret-k med konfigurerbart k
  regretKInsertion(solution, nodes, k: number): void;

  // Deep insertion — flytta befintliga stopp för att göra plats
  deepInsertion(solution, nodes, maxDepth): void;

  // Parallell insertion med branching
  parallelInsertion(solution, nodes, numThreads): void;
}
```

#### Post-ALNS förbättringsoperatorer

- **2-opt** — Vänder delsegment av rutten
- **or-opt** — Flyttar sekvenser av 1–3 stopp
- **relocate** — Flyttar enskilda stopp mellan rutter
- **cross-exchange** — Byter segment mellan två rutter

### 4.2 Pareto-Front Multi-Objective Optimization

Istället för viktad summa genereras en **Pareto-front** med icke-dominerade lösningar:

```
Kostnad ↑
│   ●
│  ● ●
│ ●   ●            Pareto-front
│●     ●───────●   (icke-dominerade lösningar)
│       ●     ●
│        ●  ●
└──────────────── CO₂ →
```

Dispatchern presenteras 3–5 alternativa ruttplaner:
- **"Snabbaste":** 4h 20min, 45 kg CO₂
- **"Grönaste":** 4h 55min, 28 kg CO₂
- **"Balanserad":** 4h 35min, 35 kg CO₂

**Implementation:** NSGA-II-inspirerad selektion i ALNS med population av lösningar.

### 4.3 Branch-and-Price Hybrid

För små instanser (< 30 stopp) — **bevisbart optimala** lösningar:

1. **Master Problem:** Set Partitioning — välj bästa delmängd av rutter
2. **Pricing Problem:** Shortest Path with Resource Constraints (SPPRC)
3. **Branching:** Arc-flow-variabler

För större instanser: fallback till ALNS med rapporterad "optimality gap".

### 4.4 Konsensus-baserad Klustring

Ersätter k-means:
1. Kör klustring N gånger med olika seeds
2. Beräkna "pair-frequency matrix" — hur ofta hamnar stopp i samma kluster
3. Hierarkisk klustring på frequency-matrisen
4. Mjuka klustergränser — stopp med 40–60% frekvens kan tillhöra båda kluster

### 4.5 Smart Klustring med Temporal Medvetenhet

Ersätt k-means med DBSCAN/HDBSCAN som tar hänsyn till:
- **Geografi** — stopp nära varandra
- **Tidsfönster** — inkompatibla tidsfönster separeras
- **Kapacitet** — kluster respekterar fordonskapacitet
- **Vägstruktur** — stopp på samma sida av motorvägen

---

## 5. Innovativa Features

### 5.1 🧠 "Traivo Brain" — Hybrid AI-Optimization Engine

Tre-lagers optimeringsarkitektur:

```
┌─────────────────────────────────────────────────┐
│         LAGER 3: ML PREDICTION LAYER            │
│  • GNN för lösningskvalitetsprediktion          │
│  • RL-baserad operatorval                       │
│  • Transformer-baserad ETA                      │
│  • Historisk mönsterigenkänning                  │
└─────────────────┬───────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────┐
│         LAGER 2: ALNS+ METAHEURISTIC            │
│  • Utökade destroy/repair-operatorer            │
│  • ML-styrd temperaturschedulering              │
│  • Pareto-front multi-objektiv optimering       │
│  • Parallel neighborhood exploration            │
└─────────────────┬───────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────┐
│         LAGER 1: EXACT SOLVER FOUNDATION        │
│  • Branch-and-Price för små instanser (<30)     │
│  • Column Generation för nedre gränser          │
│  • Set Covering för initial partitionering      │
└─────────────────────────────────────────────────┘
```

### 5.2 🌐 "Living Routes" — Realtids-Event-Driven Architecture

Rutter som lever och anpassar sig i realtid:

```
                    ┌─────────────────┐
                    │  Event Stream   │
                    │  (Kafka/Redis)  │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Traffic    │   │   Vehicle    │   │   Customer   │
│   Events     │   │   Telemetry  │   │   Events     │
│ • Olyckor    │   │ • GPS pos    │   │ • Avbokning  │
│ • Köer       │   │ • Batteri    │   │ • Ny order   │
│ • Vägarbeten │   │ • Hastighet  │   │ • Ändrat TW  │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       └──────────────────┬──────────────────┘
                          ▼
              ┌──────────────────────┐
              │   Disruption Engine  │
              │   (Impact Analysis)  │
              └──────────┬───────────┘
                         ▼
              ┌──────────────────────┐
              │   Decision Engine    │
              │   • Re-route?        │
              │   • Swap vehicle?    │
              │   • Skip stop?       │
              │   • Alert only?      │
              └──────────┬───────────┘
                         ▼
              ┌──────────────────────┐
              │   Micro-Reoptimizer  │
              │   (Delta ALNS)       │
              └──────────────────────┘
```

**Nyckelkoncept:**

- **Disruption Impact Score (0–100):** Lågpåverkan → justera ETA. Mellannivå → micro-reoptimering. Hög → full reoptimering.
- **Delta ALNS:** Identifierar exakt vilka rutter som påverkas och kör ALNS bara på dem med frozen constraints.
- **Prediktiv disruption:** ML-modell som förutser störningar. T.ex. "16:30 på E4 norr om Södertälje: 73% sannolikhet för > 15 min fördröjning."
- **Customer-Initiated Rescheduling:** Kunder kan via spårningssidan begära nytt tidsfönster.

### 5.3 🗺️ "Street-Level Intelligence"

- **OSRM i optimeringsloopen** med aggressiv cache (100k entries)
- **Road Segment Intelligence** — vägtyp, hastighetsdata per timme, viktbegränsningar
- **Spatial-Temporal Traffic Model** — H3-hexagoner med trafik per timme/veckodag
- **Parking Intelligence** — ML-modell som lär sig parkeringstid per adress
- **Turn Penalty Optimization** — Undviker vänstersvängar (sparar 3–5% bränsle)

### 5.4 📊 "Tomorrow's Routes Today" — Prediktiv Demand

- **Demand Forecasting** med Prophet/NeuralProphet per zon
- **Recurring Pattern Detection** — automatiska ruttmallar
- **Service Duration Learning** — ML-prediktion per stoppkategori
- **Delivery Success Prediction** — sannolikhet att kund är hemma

### 5.5 🏢 "Fleet DNA" — Organisationsspecifik ML

Varje kund bygger sin egen ML-modell:
- Servicetider per adresstyp (deras historik)
- Trafikmönster i deras körområde
- Förarnas individuella mönster
- Kundbeteenden (hemma/ej hemma-sannolikhet)

> **Ju längre de använder Traivo, desto bättre blir optimeringen. Lock-in genom value, inte contract.**

### 5.6 🎮 "Time Machine" — Simulering & What-If

Dispatchers kan ställa frågor:
- "Vad händer om vi lägger till 15 stopp i Södermalm?"
- "Hur ser det ut om vi byter 2 dieselbilar mot elbilar?"
- "Vad hade hänt om vi startat 1 timme tidigare?"

### 5.7 Ytterligare innovationer

| Feature | Beskrivning |
|---------|-------------|
| **Green Score** | Verifierbara hållbarhetsrapporter, ESG, branschjämförelse |
| **Smart Zones** | Automatisk identifiering av leveranszoner från historik |
| **Collaborative Routing** | Kundmedverkan: tidsfönsterval, leveransinstruktioner med foto |
| **Route Replay** | Visuell uppspelning: planerat vs faktiskt, avvikelsepunkter |
| **Autonomous Dispatch** | Tre nivåer: Assist → Autopilot → Full automation |
| **Gamification** | Poäng, leaderboard, utmaningar för förare |
| **Last-Mile Marketplace** | SMBs delar överkapacitet automatiskt |

---

## 6. Teknisk Arkitektur

### 6.1 Nuvarande stack

| Lager | Teknologi |
|-------|----------|
| Frontend | React 19, Vite 7, Tailwind CSS 4, Leaflet |
| Backend | Express 5, Node.js 24, TypeScript |
| Databas | PostgreSQL + Drizzle ORM |
| API-spec | OpenAPI 3.0 + Orval + Zod |
| AI | OpenAI GPT-5-mini |
| Realtid | WebSocket |
| Förarapp | React Native (Expo) |

### 6.2 Framtida mikroservice-evolution

```
┌─────────────────────────────────────────────────────┐
│                    API GATEWAY                       │
│              (Rate Limiting, Auth, Routing)           │
└───────────┬──────────┬──────────┬───────────────────┘
            ▼          ▼          ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │  Fleet   │ │  Route   │ │  Track   │
     │  Service │ │  Service │ │  Service │
     │ (CRUD)   │ │ (ALNS+)  │ │ (GPS)    │
     └────┬─────┘ └────┬─────┘ └────┬─────┘
          │            │            │
     ┌────▼────────────▼────────────▼────┐
     │         Event Bus (Redis Streams)  │
     └────┬────────────┬────────────┬────┘
          ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │  Insight │ │  ML      │ │  Notify  │
     │  Engine  │ │  Service │ │  Service │
     └──────────┘ └──────────┘ └──────────┘
```

> **Strategi:** Behåll monoliten tills skalningen kräver separation. Mikroservice bara om optimeringsmotor, ML-service eller GPS-tracking behöver skalas oberoende.

### 6.3 Caching-arkitektur (tre lager)

```
┌─────────────────────────────────────┐
│  L1: In-Memory LRU Cache            │
│  • Avstånd/tid-matriser             │
│  • Senaste optimeringsresultat      │
│  • TTL: 5 min                       │
├─────────────────────────────────────┤
│  L2: Redis Cache                     │
│  • OSRM-resultat                    │
│  • Trafikprofiler per H3-hexagon    │
│  • TTL: 1 timme                     │
├─────────────────────────────────────┤
│  L3: PostgreSQL Materialized Views   │
│  • Historiska trafik-aggregat       │
│  • Kundleveransmönster              │
│  • Refresh: dagligen                │
└─────────────────────────────────────┘
```

### 6.4 Datamodell — 18+ tabeller

Det avancerade systemet har en rik datamodell som inkluderar:

| Kategori | Tabeller |
|----------|----------|
| **Kärna** | organizations, users, vehicles, drivers, driver_preferences |
| **Leverans** | customers, routes, stops, route_history, route_templates |
| **Bevis & Notis** | delivery_proofs, delivery_notifications, notifications |
| **Geografi** | geofence_events |
| **EV & Energi** | energy_prices |
| **Integration** | webhooks, shopify_integrations |
| **SaaS** | subscriptions |

---

## 7. Realtidsoptimering

### 7.1 Event-driven arkitektur

| Händelse | Impact Score | Åtgärd |
|----------|-------------|--------|
| Trafikolycka i ruttens väg | 60–90 | Delta ALNS re-optimering |
| Kundavbokning | 20–40 | Ta bort stopp, micro-optimera |
| Ny akut order | 30–60 | Infoga i bästa rutt |
| Fordonsfel | 80–100 | Full omfördelning |
| Föraren sen 10+ min | 30–50 | Uppdatera ETA:er, varna kunder |
| GPS-signal förlorad | 10–20 | Alert, vänta på återuppkoppling |

### 7.2 Delta ALNS — Inkrementell reoptimering

Istället för att optimera hela flottan vid varje störning:

1. **Identifiera påverkade rutter** — vilka fordon/stopp påverkas?
2. **Frys levererade stopp** — kan inte ändras
3. **Kör ALNS bara på påverkade** — snabbare, stabilare
4. **Minimera förändringar** — förare föredrar stabilitet

### 7.3 Prediktiv disruption

ML-modell som förutser störningar:
- Tränad på historisk trafikdata + händelseloggar
- Tidspecifik: "Kl 16:30 på E4 norr om Södertälje: 73% sannolikhet för > 15 min fördröjning"
- Proaktiv omplanering *innan* problemet uppstår

---

## 8. Miljö & Hållbarhet

### 8.1 Nuvarande hållbarhetsmodul

| Mätning | Metod |
|---------|-------|
| **CO₂-utsläpp** | Per fordonstyp (diesel, el, hybrid) med well-to-wheel-faktor |
| **PM2.5 (partiklar)** | Broms-/däckslitage + avgasfaktorer |
| **Bulleranalys** | Natt-/bostadsområdesdetektering |
| **Miljöpoäng** | 0–100 per rutt (viktad CO₂/buller/partiklar) |
| **Trädequivalenter** | Visualisering av CO₂-besparingar |

### 8.2 Planerade förbättringar — "Carbon Zero Routes"

#### Eco-Routing med topografi
Integrera höjddata (SRTM/Copernicus). En rutt som är 2 km längre men 200 m lägre i höjd kan spara 15% bränsle för tunga lastbilar.

#### Dynamisk EV-laddstrategi
- Realtids-elprispriser (redan i DB)
- Ladda vid billigaste tidpunkt
- Planera laddning vid stopp med lång servicetid
- Optimal SoC (State of Charge) per rutt

#### Carbon Budget per rutt
CO₂-budgetar som **hård constraint**, inte bara en vikt:
> "Denna rutt FÅR inte överskrida 50 kg CO₂."

#### Multi-modal routing
Kombinera fordonstyper:
- Lastbil → hub → cykelbud → slutkund
- Optimera hela kedjan för lägsta totala utsläpp

#### Ytterligare miljöfeatures

| Feature | Beskrivning |
|---------|-------------|
| Scope 3 Emissions | Indirekta utsläpp (packmaterial, lager, returer) |
| Regenerativ bromsning (EV) | Energiåtervinning i räckviddsberäkning |
| Green Score-certifikat | Verifierbara rapporter för ESG |
| Branschjämförelse | Jämför CO₂/leverans med genomsnittet |

---

## 9. AI & Maskininlärning

### 9.1 Graph Neural Network (GNN)

**Syfte:** Warm-start för ALNS — ersätt Clarke-Wright med GNN-predikterad initiallösning.

- **Input:** Stop-graf med features (position, tidsfönster, vikt)
- **Output:** Sannolikhet att två stopp ska vara på samma rutt
- **Fördel:** 30–50% snabbare konvergens i ALNS

### 9.2 Reinforcement Learning (RL) för operatorval

**Syfte:** Ersätt adaptiv viktning med DQN/PPO-agent.

- **State:** Lösningens nuvarande tillstånd (klustring, belastning, tidsfönster-slack)
- **Action:** Vilken destroy/repair-operator att använda
- **Reward:** Förbättring i lösningskvalitet
- **Fördel:** Lär sig problemspecifika mönster

### 9.3 Transformer-baserad ETA

**Syfte:** Exakt ETA med konfidensintervall.

- **Input:** Position, tid, väderprognos, veckodag, fordonstyp
- **Output:** ETA ± konfidensintervall
- **Modellstorlek:** ~10M parametrar
- **Mål:** ± 4 min precision (från nuvarande ± 15 min)

### 9.4 Service Duration Learning

ML-modell per stoppkategori:
- **Input:** Adresstyp, paketantal, kundhistorik, tid på dygnet, väder
- **Output:** Predikterad servicetid med osäkerhetsintervall
- **Fördel:** Eliminerar "10 min för alla stopp"-approximationen

### 9.5 Delivery Success Prediction

- Förutser sannolikhet att kund är hemma
- Baserat på historik, tid, kundtyp
- Möjliggör "smart retry" — omplanera missade leveranser till optimal tid

---

## 10. Skalbarhet & Prestanda

### 10.1 Rust/WASM-optimeringsmotor

Mest kritiska performance-förbättringen:

```
┌──────────────────────────────────────┐
│  TypeScript API Layer (orchestration) │
│  • Input validation                   │
│  • Result formatting                  │
│  • WebSocket progress updates         │
└───────────────┬──────────────────────┘
                ▼
┌──────────────────────────────────────┐
│  Rust/WASM ALNS Engine               │
│  • 10–50x snabbare iteration         │
│  • Native parallellism               │
│  • Kan köras i browser & server      │
│  • ~5000 stopp inom 30 sekunder      │
└──────────────────────────────────────┘
```

**Alternativ:** OR-Tools (Google) via gRPC som separat service.

### 10.2 Skalningsstrategi

| Storleksnivå | Strategi |
|-------------|----------|
| < 100 stopp | Branch-and-Price (exakt lösning) |
| 100–500 stopp | ALNS+ med DBSCAN-klustring |
| 500–2 000 stopp | Rust/WASM ALNS med parallel neighborhoods |
| 2 000–10 000 stopp | Distributed ALNS med konsensusklustring |

### 10.3 Edge Computing

Flytta viss logik till förarens enhet:
- Lokal re-sekvensering av 3–5 kommande stopp
- Offline-kapabel med cachad ruttdata
- Kamerabaserad adressverifiering (OCR)

---

## 11. Feature Roadmap

### Sprint 1 (Vecka 1–2): Foundation Fix

| Dag | Uppgift | Prioritet |
|-----|---------|----------|
| 1–2 | OSRM i optimeringsloopen (Table API + LRU-cache) | P0 |
| 3–4 | Nya ALNS-operatorer (relatedRemoval, regret3, routeRemoval) | P0 |
| 5 | DBSCAN + temporal klustring | P0 |
| 6–7 | 2-opt/or-opt post-processing | P1 |
| 8 | Shaw removal med fler dimensioner (tid, kapacitet) | P1 |
| 9 | Fix: Geohash-baserad distanscache | P1 |
| 10 | Fix: Dynamisk EV-laddstationsgräns | P2 |

### Sprint 2 (Vecka 3–6): Realtid & Trafik

| Uppgift | Prioritet |
|---------|----------|
| Verklig trafikdataintegration (HERE/TomTom) | P0 |
| Event-driven disruption engine (Redis Streams) | P0 |
| Delta ALNS (inkrementell med frozen constraints) | P1 |
| Live GPS tracking med geofence | P1 |
| SMHI väderintegration | P2 |

### Sprint 3 (Vecka 7–12): ML & Prediktion

| Uppgift | Prioritet |
|---------|----------|
| Service Duration ML-modell | P0 |
| ETA Prediction Model (Transformer/GBM) | P0 |
| Demand Forecasting (NeuralProphet) | P1 |
| Delivery Success Prediction | P1 |
| RL-baserad operatorval i ALNS | P2 |
| GNN warm-start | P2 |

### Framtida sprints

| Sprint | Fokus |
|--------|-------|
| Sprint 4 | Rust/WASM-port, Multi-depot, PDP-stöd |
| Sprint 5 | Time Machine, Green Score, Eco-routing |
| Sprint 6 | Förarkompetensmodell, Gamification, Customer portal |
| Sprint 7 | Multi-modal routing, Last-Mile Marketplace |

---

## 12. Konkurrensfördelar

### 12.1 Jämförelse med konkurrenter

| Feature | Traivo | Route4Me | OptimoRoute | Routific |
|---------|--------|----------|-------------|----------|
| ALNS-optimering | ✅ | ❌ | ✅ | ✅ |
| CO₂-optimering | ✅ | ❌ | ❌ | ❌ |
| PM2.5/Bulleranalys | ✅ | ❌ | ❌ | ❌ |
| AI Chat Assistant | ✅ | ❌ | ❌ | ❌ |
| Prediktiv insiktsmotor | ✅ | ❌ | Delvis | ❌ |
| EV-laddstrategi | ✅ | ❌ | Delvis | ❌ |
| Fleet DNA (org-ML) | 🔜 | ❌ | ❌ | ❌ |
| Living Routes (realtid) | 🔜 | Delvis | Delvis | ❌ |
| Green Score-certifikat | 🔜 | ❌ | ❌ | ❌ |
| Svenskanpassat | ✅ | ❌ | ❌ | ❌ |
| Shopify-integration | ✅ | ❌ | ✅ | ✅ |

### 12.2 Unika differentiatorerer

1. **Hållbarhetsfokus** — Enda systemet med integrerad CO₂/PM2.5/buller-optimering
2. **Fleet DNA** — Systemet blir smartare ju mer det används (lock-in through value)
3. **Living Routes** — Event-driven realtidsanpassning, inte bara batch-optimering
4. **Hybrid AI** — GNN + RL + ALNS — bästa av alla världar
5. **Svenskt & lokalt** — Anpassat för svenska förhållanden (väder, infrastruktur, regler)
6. **Full vertikal integration** — Planering → exekvering → bevis → analys i ett system
7. **Enkel uppgraderingsväg** — Från Traivo One till Ruttplanering sömlöst

### 12.3 Affärsmodell som differentiator

| Aspekt | Traivo |
|--------|--------|
| **Prissättning** | Per fordon/månad (skalbar) |
| **Free tier** | Traivo One (bygger pipeline) |
| **Lock-in** | Fleet DNA — data = värde |
| **Upsell** | One → Ruttplanering automatisk |
| **Green premium** | Hållbarhetsfeatures motiverar högre pris |

---

## 13. KPI:er & Målsättningar

| KPI | Nuvarande | Mål 6 mån | Mål 12 mån |
|-----|-----------|-----------|------------|
| Ruttkvalitet (vs optimal) | ~85% | 92% | 96% |
| Optimeringstid 100 stopp | ~15 sek | 5 sek | 2 sek |
| Optimeringstid 500 stopp | ~120 sek | 30 sek | 10 sek |
| ETA-precision (±min) | ±15 min | ±8 min | ±4 min |
| CO₂-besparing vs naiv | ~15% | 25% | 35% |
| Realtids-reaktionstid | N/A | < 30 sek | < 10 sek |
| Maximal problemstorlek | ~500 stopp | 2 000 stopp | 10 000 stopp |
| Kundnöjdhet (NPS) | N/A | +30 | +50 |

---

## 14. Skillnader mot Traivo One

| Aspekt | Traivo One | Traivo Ruttplanering |
|--------|-----------|---------------------|
| **Målgrupp** | 1–10 fordon (SMB) | 10–500 fordon |
| **Plattform** | Replit | Dedikerad server / moln |
| **Algoritm** | NN + 2-opt | ALNS+ med 12+ operatorer |
| **AI/ML** | Nej | GNN, RL, Transformer-ETA |
| **Optimeringstid** | < 2 sek (30 stopp) | < 30 sek (500 stopp) |
| **Lösningskvalitet** | ~85–90% | ~95–96% |
| **Realtidstrafik** | Nej | HERE/TomTom |
| **Hållbarhet** | Enkel CO₂ (framtida) | CO₂, PM2.5, buller, Green Score |
| **EV-stöd** | Nej | Laddstrategi, SoC, räckvidd |
| **Datamodell** | 7 tabeller | 18+ tabeller |
| **Realtidsoptimering** | Nej | Living Routes, Delta ALNS |
| **Prediktiv** | Nej | Demand forecasting, Fleet DNA |
| **Pris** | Gratis / billig | Premium SaaS |

> **Uppgraderingsväg:** Traivo One-kunder kan sömlöst uppgradera till Traivo Ruttplanering. Datamodellen är kompatibel, och övergången är additiv — inget data förloras.

---

> **Sammanfattning:** Traivo Ruttplanering strävar efter att bli det *smartaste*, *grönaste* och mest *anpassningsbara* ruttoptimeringssystemet för svenska medelstora företag. Genom att kombinera ALNS+, AI/ML, realtidshändelser och unikt hållbarhetsfokus skapar vi ett system som inte bara planerar rutter — det *lär sig* och blir bättre för varje leverans.

---

> **Kontakt:** Traivo-teamet  
> **Nästa steg:** Starta Sprint 1 — Foundation Fix (OSRM, ALNS-operatorer, klustring)
