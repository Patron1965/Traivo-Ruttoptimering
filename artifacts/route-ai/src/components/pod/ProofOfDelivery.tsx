import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, PenTool, ScanBarcode, CheckCircle2, X } from "lucide-react";
import { SignaturePad } from "./SignaturePad";
import { PhotoCapture } from "./PhotoCapture";
import { BarcodeInput } from "./BarcodeInput";

const API_BASE = import.meta.env.VITE_API_URL || "";

interface ProofOfDeliveryProps {
  stopId: string;
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

export function ProofOfDelivery({ stopId, onClose, onComplete }: ProofOfDeliveryProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ProofMode>(null);
  const [collected, setCollected] = useState<{ type: string; count: number }[]>([]);

  const { data: existingProofs = [] } = useQuery<Proof[]>({
    queryKey: ["proofs", stopId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/stops/${stopId}/proofs`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  const submitProof = useMutation({
    mutationFn: async ({ proofType, data }: { proofType: string; data: string }) => {
      const res = await fetch(`${API_BASE}/api/stops/${stopId}/proof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proofType, data }),
      });
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: (_data, vars) => {
      setCollected((prev) => {
        const existing = prev.find((c) => c.type === vars.proofType);
        if (existing) return prev.map((c) => c.type === vars.proofType ? { ...c, count: c.count + 1 } : c);
        return [...prev, { type: vars.proofType, count: 1 }];
      });
      setMode(null);
      queryClient.invalidateQueries({ queryKey: ["proofs", stopId] });
    },
  });

  const totalProofs = existingProofs.length + collected.reduce((s, c) => s + c.count, 0);

  const handleCapture = (proofType: string, data: string) => {
    submitProof.mutate({ proofType, data });
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-sm">{t("pod.title")}</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {submitProof.isPending && (
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
          onCapture={(data) => handleCapture("photo", data)}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === "signature" && (
        <SignaturePad
          onCapture={(data) => handleCapture("signature", data)}
          onCancel={() => setMode(null)}
        />
      )}

      {mode === "barcode" && (
        <BarcodeInput
          onCapture={(data) => handleCapture("barcode", data)}
          onCancel={() => setMode(null)}
        />
      )}
    </div>
  );
}
