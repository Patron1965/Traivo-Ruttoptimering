import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AddressCorrectionInput, AddressPreview, PlannerRecommendations } from "@/lib/planner-corrections";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api/planner-corrections";
async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/${path}`, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Begäran misslyckades (${response.status}).`);
  return data as T;
}

/** Request-only mutations: never run on mount/hover and never retry a confirmation. */
export function usePlannerCorrections() {
  const client = useQueryClient();
  const recommendations = useMutation({
    retry: false, mutationFn: (body: { stopId: string; routeIds: string[] }) =>
      request<PlannerRecommendations>("recommendations", body),
  });
  const address = useMutation({
    retry: false, mutationFn: (body: AddressCorrectionInput) => request<AddressPreview>("address/preview", body),
  });
  const confirm = useMutation({
    retry: false, mutationFn: (body: { token: string; confirmed: true }) => request<{ kind: string }>("confirm", body),
    onSuccess: async () => { await client.invalidateQueries(); },
  });
  return { recommendations, address, confirm };
}
