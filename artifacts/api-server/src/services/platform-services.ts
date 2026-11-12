import { operationalProviderKind, operationalProviderConfigured } from "./operational-provider-config";
import { getRoutingConfigurationStatus } from "./routing-provider-config";
import { configuredProvider } from "./sms";
import { isEmailConfigured, isRecoveryEmailConfigured } from "./email";
import { cuoptConfiguration } from "../lib/cuopt-nvcf";

type ServiceState = "enabled" | "disabled" | "incomplete" | "available";
export function getPlatformServices() {
  // Inventory describes installation configuration, not the platform
  // operator's own organization's runtime permissions.
  const road = operationalProviderKind("inherit");
  const sms = configuredProvider("inherit");
  const routing = getRoutingConfigurationStatus();
  const cuopt = cuoptConfiguration();
  const item = (id: string, name: string, description: string, state: ServiceState, detail: string) =>
    ({ id, name, description, state, detail });
  return [
    item("openai", "OpenAI · AI-assistent", "Tolkar frågor och hjälper planeraren i AI-chatten. Själva vägberäkningen görs av vägdatatjänsten.",
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ? "enabled" : "incomplete",
      process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
        ? "AI-anslutning konfigurerad. Inget AI-anrop eller kostnadsprov görs här." : "AI-anslutningens konfiguration är ofullständig."),
    item("sentry", "Sentry · felrapportering", "Samlar tekniska applikationsfel för felsökning och driftuppföljning.",
      process.env.SENTRY_DSN ? "enabled" : "disabled",
      process.env.SENTRY_DSN ? "Felrapportering konfigurerad. Mottagningen är inte testad här." : "Felrapportering till Sentry är inte konfigurerad."),
    ...(["geoapify", "osrm"] as const).map(provider => item(
      provider, provider === "geoapify" ? "Geoapify · ruttplanering" : "OSRM · ruttplanering",
      "Beräknar köravstånd och körtider på vägnätet som underlag för ruttoptimering.",
      road !== provider ? "disabled" : operationalProviderConfigured("inherit") ? "enabled" : "incomplete",
      road !== provider ? "Inte vald för den operativa ruttplaneringen." : operationalProviderConfigured("inherit")
        ? "Vald och konfigurerad. Anslutning, kvot och planeringskvalitet är inte verifierade här."
        : "Vald, men godkänd serverkonfiguration eller API-nyckel saknas."
    )),
    item("district-osrm", "OSRM · distriktsplanering", "Ger vägavstånd för distriktsindelning och geografiska planeringsjobb.",
      routing.shared.configured ? "enabled" : "incomplete",
      routing.shared.configured ? "Gemensam server konfigurerad. Kundspecifika serverval hanteras per företag." : "Gemensam server är inte fullständigt konfigurerad."),
    item("google", "Google Maps · adressökning", "Söker och kontrollerar adresser samt omvandlar dem till kartkoordinater.",
      process.env.GOOGLE_MAPS_API_KEY ? "enabled" : "disabled",
      process.env.GOOGLE_MAPS_API_KEY ? "API-nyckel finns. Behörighet och kvot är inte testade." : "API-nyckel saknas."),
    item("nominatim", "Nominatim · adressökning", "OpenStreetMap-baserad adressökning, reservsökning och omvänd sökning från koordinater till adress.",
      "enabled", "Tillgänglig i adressflödet utan API-nyckel. Tillgänglighet och användningsgränser är inte testade."),
    item("cuopt", "NVIDIA cuOpt", "Konfiguration och separat anslutningstest. Ingen cuOpt-motor är inkopplad i den ordinarie planeringen.",
      cuopt.state === "not_checked" ? "available" : "incomplete",
      cuopt.state === "not_checked" ? "Konfigurerad för separat anslutningstest. Planeringen använder inte cuOpt." : "Nyckel och giltig funktionskonfiguration krävs för anslutningstest. Planeringen använder inte cuOpt."),
    ...(["linkmobility", "twilio", "46elks"] as const).map(provider => item(
      `sms-${provider}`, { linkmobility: "LINK Mobility", twilio: "Twilio", "46elks": "46elks" }[provider] + " · SMS",
      provider === "linkmobility"
        ? "LINK Common API med Basic Auth: användarnamn, lösenord, service-ID, gate-ID och godkänt avsändarnamn krävs."
        : "Skickar SMS med förarmeddelanden och kundaviseringar. Kundföretagets aviseringsinställningar gäller också.",
      sms === provider ? "enabled" : process.env.SMS_PROVIDER?.trim().toLowerCase() === provider ? "incomplete" : "disabled",
      sms === provider ? "Vald SMS-leverantör med nödvändig konfiguration. Leverans är inte verifierad."
        : process.env.SMS_PROVIDER?.trim().toLowerCase() === provider ? "Vald, men nödvändig åtkomst eller avsändare saknas." : "Inte aktiv SMS-leverantör."
    )),
    item("sendgrid", "SendGrid · kundaviseringar", "Skickar e-post om leveranser och andra kundaviseringar.",
      isEmailConfigured() ? "enabled" : "disabled",
      isEmailConfigured() ? "API-nyckel finns. Avsändarbehörighet och leverans är inte verifierade." : "API-nyckel för aviseringsflödet saknas."),
    item("sendgrid-recovery", "SendGrid · lösenordsåterställning", "Skickar återställningsmejl via den separata SendGrid-anslutningen.",
      isRecoveryEmailConfigured() ? "available" : "incomplete",
      isRecoveryEmailConfigured() ? "Avsändare är inställd. Anslutningens behörighet och leverans är inte verifierade här." : "Avsändare saknas. Installerad anslutning innebär inte att återställningsmejl kan skickas."),
    item("map-tiles", "OpenStreetMap, Esri och CARTO · bakgrundskartor",
      "Visar vägkarta, ljus/mörk bakgrund och satellitbilder. Kartbilder beräknar inte rutter.",
      "available", "Används efter kartans valda bakgrund. Ingen anslutningskontroll görs här."),
  ];
}
