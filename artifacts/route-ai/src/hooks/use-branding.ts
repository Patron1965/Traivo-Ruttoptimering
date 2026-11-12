import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { brandingRequest } from "@/lib/branding-request";

export interface Brand {
  displayName: string | null;
  websiteUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  backgroundColor: string | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
}

export interface BrandingExtraction {
  sourceUrl: string;
  colors: string[];
  logos: Array<{ url: string; label: string }>;
  warnings: string[];
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "") + "/";

export function useBranding() {
  const { user } = useAuth();
  
  return useQuery<Brand | null>({
    queryKey: ["/api/branding", user?.organizationId],
    queryFn: async () => {
      const res = await brandingRequest(`${API_BASE}api/branding`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch branding");
      return res.json();
    },
    enabled: !!user?.organizationId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useSaveBranding() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (brand: Brand) => {
      const res = await brandingRequest(`${API_BASE}api/branding`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(brand),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save branding");
      }
      return res.json() as Promise<Brand>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/branding", user?.organizationId], data);
    },
  });
}

export function useResetBranding() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async () => {
      const res = await brandingRequest(`${API_BASE}api/branding`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to reset branding");
      }
      return res.json() as Promise<Brand>; // returns null default Brand properties from API
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["/api/branding", user?.organizationId], data);
    },
  });
}

export function useUploadLogo() {
  return useMutation({
    mutationFn: async ({ data, contentType }: { data: string; contentType: string }) => {
      const res = await brandingRequest(`${API_BASE}api/branding/logo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, contentType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to upload logo");
      }
      return res.json() as Promise<{ logoUrl: string }>;
    },
  });
}

export function useExtractBranding() {
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await brandingRequest(`${API_BASE}api/branding/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to extract branding");
      }
      return res.json() as Promise<BrandingExtraction>;
    },
  });
}

export function useImportLogo() {
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await brandingRequest(`${API_BASE}api/branding/logo/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to import logo");
      }
      return res.json() as Promise<{ logoUrl: string }>;
    },
  });
}
