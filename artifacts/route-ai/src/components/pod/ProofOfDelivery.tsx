import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, PenTool, ScanBarcode, CheckCircle2, X } from "lucide-react";
import { SignaturePad } from "./SignaturePad";
import { PhotoCapture } from "./PhotoCapture";
import { BarcodeInput } from "./BarcodeInput";
import { useAuth } from "@/lib/auth-context";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface ProofOfDeliveryProps {
  stopId: string;
  planVersion: number;
  onClose: () => void;
  onComplete?: () => void;
}

type ProofMode = null | "photo" | "signature" | "barcode";

interface Proof {
  id: string;
  proofType: string;
  fileUrl: string | null;
  data: string | null;
  capturedAt: string;
}

export function ProofOfDelivery({ stopId, planVersion, onClose, onComplete }: ProofOfDeliveryProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ProofMode>(null);
  const [collected, setCollected] = useState<{ type: string; count: number }[]>([]);

  const { data: existingProofs = [] } = useQuery<Proof[]>({
    queryKey: ["proofs", organizationId, stopId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/stops/${stopId}/proofs?organizationId=${organizationId}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!organizationId,
  });

  const onProofSuccess = (proofType: string) => {
    setCollected((prev) => {
      const existing = prev.find((c) => c.type === proofType);
      if (existing) return prev.map((c) => c.type === proofType ? { ...c, count: c.count + 1 } : c);
      return [...prev, { type: proofType, count: 1 }];
    });
    setMode(null);
    queryClient.invalidateQueries({ queryKey: ["proofs", organizationId, stopId] });
  };

  const submitPhotoProof = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("photo", file);
      formData.append("clientEventId", `${stopId}_web_photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      formData.append("planVersion", String(planVersion));
      formData.append("occurredAt", new Date().toISOString());
      if (!organizationId) throw new Error("Authenticated organization is required");
      const res = await fetch(`${API_BASE}/api/stops/${stopId}/proof?organizationId=${organizationId}`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => onProofSuccess("photo"),
  });

  const submitJsonProof = useMutation({
    mutationFn: async ({ proofType, data }: { proofType: string; data: string }) => {
      if (!organizationId) throw new Error("Authenticated organization is required");
      const res = await fetch(`${API_BASE}/api/stops/${stopId}/proof?organizationId=${organizationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proofType,
          data,
          clientEventId: `${stopId}_web_${proofType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          planVersion,
          occurredAt: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: (_data, vars) => onProofSuccess(vars.proofType),
  });

  const isPending = submitPhotoProof.isPending || submitJsonProof.isPending;
  const totalProofs = existingProofs.length + collected.reduce((s, c) => s + c.count, 0);

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">{t("pod.title")}</h3>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          {t("pod.uploading")}
        </div>
      )}

      {mode === null && (
        <>
          {totalProofs > 0 && (
            <div className="flex items-center gap-2 text-xs text-emerald-500 font-medium">
              <CheckCircle2 className="h-4 w-4" />
              {t("pod.proofsCollected", { count: totalProofs })}
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setMode("photo")}
              className="flex flex-col items-center gap-2 py-4 px-2 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors"
            >
              <Camera className="h-6 w-6 text-blue-500" />
              <span className="text-xs font-medium">{t("pod.photo")}</span>
            </button>
            <button
              onClick={() => setMode("signature")}
              className="flex flex-col items-center gap-2 py-4 px-2 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors"
            >
              <PenTool className="h-6 w-6 text-violet-500" />
              <span className="text-xs font-medium">{t("pod.signature")}</span>
            </button>
            <button
              onClick={() => setMode("barcode")}
              className="flex flex-col items-center gap-2 py-4 px-2 rounded-xl border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors"
            >
              <ScanBarcode className="h-6 w-6 text-amber-500" />
              <span className="text-xs font-medium">{t("pod.barcode")}</span>
            </button>
          </div>

          {totalProofs > 0 && (
            <button
              onClick={() => { onComplete?.(); onClose(); }}
              className="w-full py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-bold transition-colors hover:bg-emerald-600"
            >
              {t("pod.done")}
            </button>
          )}
        </>
      )}

      {mode === "photo" && (
        <PhotoCapture
          onCapture={(file) => submitPhotoProof.mutate(file)}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === "signature" && (
        <SignaturePad
          onCapture={(data) => submitJsonProof.mutate({ proofType: "signature", data })}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === "barcode" && (
        <BarcodeInput
          onCapture={(data) => submitJsonProof.mutate({ proofType: "barcode", data })}
          onCancel={() => setMode(null)}
        />
      )}
    </div>
  );
}
