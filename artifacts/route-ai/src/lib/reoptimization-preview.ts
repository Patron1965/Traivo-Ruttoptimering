import { hasErrorCode } from "./localize-error.ts";

// Match only known server reasons. Never expose arbitrary server response text.
const REASONS = [
  ["Rutten saknar start- eller slutplats. Ange båda platserna hos resursen innan du ruttar om.",
    "Start- eller slutplats saknas. Ange båda platserna under Resurser och försök sedan igen."],
  ["Rutten saknar sparat depå- eller reservunderlag och kan inte planeras om säkert.",
    "Rutten saknar sparat planeringsunderlag. Skapa en ny plan från projektet med valda resurser och depå. Upprepade försök här kan inte reparera det saknade underlaget."],
  ["Rutten saknar sin optimeringsvalda aktiva chaufför. Ladda om och välj en explicit resursändring.",
    "Ruttens valda chaufför är inte längre aktiv på fordonet. Kontrollera resursen och välj ett uttryckligt resursbyte innan du ruttar om."],
  ["Rutten saknar ett aktivt bil–chaufförspar.",
    "Rutten saknar en aktiv resurs. Kontrollera fordon och chaufför innan du ruttar om."],
  ["Rutten har inga återstående väntande stopp.",
    "Rutten har inga återstående väntande stopp att optimera."],
  ["Rutten ändrades av någon annan. Ladda om och försök igen.",
    "Rutten ändrades under förhandsvisningen. Försök igen för att hämta den senaste versionen. Inget har sparats."],
  ["Den frysta rutten är inte längre genomförbar med aktuellt underlag.",
    "Rutten är fryst och kan inte genomföras med aktuella villkor. Granska låsningen och resursens villkor i projektet."],
] as const;

export function routePreviewFailure(error: unknown): string | undefined {
  return REASONS.find(([reason]) => hasErrorCode(error, reason))?.[1];
}

/** Read on each explicit attempt, including retries; never replay an apply. */
export async function previewCurrentRoute<R extends { id: string; planRevision: number }, P>(
  id: string,
  read: (id: string) => Promise<R>,
  preview: (route: R) => Promise<P>,
): Promise<{ route: R; result: P }> {
  const route = await read(id);
  const result = await preview(route);
  return { route, result };
}
