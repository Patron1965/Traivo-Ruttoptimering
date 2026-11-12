/** Keep failed edits in the caller; never redirect or retry writes on auth errors. */
export async function brandingRequest(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, credentials: "include" });
  if (response.status === 401) {
    throw new Error("Din inloggning är inte längre giltig. Logga in igen i en ny flik och försök sedan igen här. Dina osparade ändringar finns kvar så länge du inte laddar om sidan.");
  }
  if (response.status === 403) {
    throw new Error("Du behöver vara administratör för att ändra kundanpassningen.");
  }
  return response;
}