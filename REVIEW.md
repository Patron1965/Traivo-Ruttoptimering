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

Denna gren saknar tidigare historik. Kundexporter, uppladdade underlag, interna
anteckningar, rapporter, skärmbilder, lokala verktygsinstallationer och manuella
kundprovisioneringsskript ingår inte. Ursprungliga Markdown-dokument är utelämnade.
Vissa dokumentlänkar och manuella hjälpskript kan därför saknas.

Ingen databas eller hemlig miljökonfiguration ingår. En lokal installation behöver
egna testuppgifter och konfiguration; anslut inte till en kunddatabas för granskning.
Testkod kan innehålla fasta syntetiska testvärden och publika testadresser.

En mönsterbaserad kontroll av vanliga nycklar, privata nycklar och autentiserade
URL:er har utförts. Detta ersätter inte en fullständig sekretess- eller säkerhetsgranskning.

Begär gärna fynd med fil, rad, reproduktion, allvarlighetsgrad och föreslagen åtgärd.
