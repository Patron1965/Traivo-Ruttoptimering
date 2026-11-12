# Traivo Route — granskningsversion

Detta är en källkodsbild för granskning, inte en driftsättning eller en fullständig säkerhetscertifiering.

## Granskningsfokus

- `artifacts/api-server/src/services/import-route-workflow.ts`: målprofiler, resursval och persistens.
- `artifacts/api-server/src/services/alns/`: kostnadsfunktion, lösningsjämförelse, konstruktion och sökning.
- `artifacts/api-server/src/services/geoapify-road.ts`: riktade vägmatriser och väggeometri.
- `artifacts/route-ai/src/components/import/Step7Adjust.tsx`: granskning och justering av importerade rutter.
- `lib/api-spec/openapi.yaml`: API-kontrakt; genererade klienter finns i `lib/`.
- `artifacts/driver-app/`: chaufförsappen.

Kontrollera särskilt att geografiska mål inte åsidosätts av dold arbetstidsbalansering,
att onödig körning inte förbättrar målfunktionen och att kapacitet, tidsfönster,
laddning, låsningar och obligatoriska uppdrag bevaras.

## Begränsningar

Denna gren innehåller endast granskningshistorik, inte projektets tidigare historik. Kundexporter, uppladdade underlag, interna
anteckningar, rapporter, skärmbilder, lokala verktygsinstallationer och manuella
kundprovisioneringsskript ingår inte. Ursprungliga Markdown-dokument är utelämnade.
Vissa dokumentlänkar och manuella hjälpskript kan därför saknas.

Ingen databas eller hemlig miljökonfiguration ingår. En lokal installation behöver
egna testuppgifter och konfiguration; anslut inte till en kunddatabas för granskning.
Testkod kan innehålla fasta syntetiska testvärden och publika testadresser.

En mönsterbaserad kontroll av vanliga nycklar, privata nycklar och autentiserade
URL:er har utförts. Detta ersätter inte en fullständig sekretess- eller säkerhetsgranskning.

Begär gärna fynd med fil, rad, reproduktion, allvarlighetsgrad och föreslagen åtgärd.

## Uppdatering 2026-11-12: fem profiler och separat resursval

- Gemensamma namngivna profiler i `services/alns/planning-profiles.ts`.
- Giltighet och stopptäckning prioriteras före mjuka mål.
- Resurskravet ändras inte automatiskt när målet ändras, varken i serverns
  normalisering eller i importens steg 6 och 7.
- Vägbaserade medoidgrupper används som startlösningar för stora namngivna
  profiler; de är inte permanenta områdesgränser.
- Återanvändning av tidigare giltiga lösningar jämför enligt den valda profilen.
- Monoton balansering bevaras: extra körning belönas inte för att jämna ut arbetstid.

### Utförda kontroller

35 riktade tester passerade för profiler, monotonicitet, resursval, vägdataspärr,
bevarande av stopp och återanvändning av tidigare giltiga planer.
API och webbserver startade. Nya kontroller bakom inloggning har inte
webbläsartestats. Fullständig typkontroll har befintliga fel utanför ändringen.

Samma frysta underlag med 154 leveranser, två resurser och en riktad Geoapify-matris
användes för samtliga profiler. Råunderlaget följer inte med i detta repo.
Alla fem körningar gav 154/154 planerade stopp och två giltiga rutter.

| Profil | Vägsträcka km | Stopp per resurs | Arbetsdagar min |
| --- | ---: | --- | --- |
| Balanserad | 95,371 | 77 / 77 | 479,7 / 481,2 |
| Kortast körning | 87,092 | 73 / 81 | 442,5 / 508,4 |
| Geografiska områden | 86,506 | 71 / 83 | 430,4 / 520,0 |
| Sammanhållna områden och arbetstid | 85,255 | 38 / 116 | 225,4 / 719,7 |
| Färre fordon, båda resurserna krävs | 87,248 | 73 / 81 | 443,0 / 508,3 |

Med oanvända resurser tillåtna gav Färre fordon också två giltiga rutter,
75/79 stopp och 93,758 km. Detta bevisar inte minsta möjliga fordonsantal.

### Granska särskilt

1. Kombinationen områden/arbetstid prioriterar områden före jämna arbetsdagar;
   testet gav mycket ojämna arbetsdagar. Är den prioriteringen lämplig?
2. Kortast körning hittade inte den kortaste planen bland alla profiler.
   Den begränsade heuristiska sökningen garanterar inte globalt optimum.
3. Sökbudget är inte total tidsbudget. Slutkontroller och matrisinläsning tillkommer.
4. Jämförelsen omfattar inte blandade skift, elfordon eller alla komplexa tidsfönster.
5. Visuell likhet med ett tidigare systems karta har inte verifierats.

Fynd ska skilja mellan observerade fel, förbättringsförslag och obestyrkta antaganden.
