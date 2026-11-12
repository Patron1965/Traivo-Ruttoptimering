import { useTranslation } from "react-i18next";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { Camera, PenTool, ScanBarcode, Clock } from "lucide-react";
import { ProofPreview } from "./ProofPreview";

interface Proof {
  id: string;
  proofType: string;
  fileUrl: string | null;
  data: string | null;
  notes?: string | null;
  capturedAt: string;
}

interface ProofDisplayProps {
  proofs: Proof[];
  compact?: boolean;
}

const API_BASE = import.meta.env.VITE_API_URL || "";

export function ProofDisplay({ proofs, compact = false }: ProofDisplayProps) {
  const { t } = useTranslation();

  if (proofs.length === 0) return null;

  const icon = (type: string) => {
    switch (type) {
      case "photo": return <Camera className="h-3.5 w-3.5" />;
      case "signature": return <PenTool className="h-3.5 w-3.5" />;
      case "barcode": return <ScanBarcode className="h-3.5 w-3.5" />;
      default: return null;
    }
  };

  const label = (type: string) => {
    switch (type) {
      case "photo": return t("pod.photo");
      case "signature": return t("pod.signature");
      case "barcode": return t("pod.barcode");
      default: return type;
    }
  };

  const getImageSrc = (proof: Proof) => {
    if (proof.fileUrl) {
      return `${API_BASE}/api/storage${proof.fileUrl}`;
    }
    if (proof.data && proof.data.startsWith("data:")) {
      return proof.data;
    }
    return null;
  };

  if (compact) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {proofs.map((p) => (
          <ProofPreview
            key={p.id}
            proofs={[p]}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary"
          >
            {icon(p.proofType)}
            {label(p.proofType)}
          </ProofPreview>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        {t("pod.title")}
        <span className="text-xs font-normal text-muted-foreground">({proofs.length})</span>
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {proofs.map((proof) => {
          const imgSrc = getImageSrc(proof);
          return (
            <div key={proof.id} className="rounded-xl border border-border bg-card overflow-hidden">
              {imgSrc && (proof.proofType === "photo" || proof.proofType === "signature") && (
                <div className={proof.proofType === "signature" ? "bg-white p-2" : ""}>
                  <WorkspaceImage
                    src={imgSrc}
                    alt={label(proof.proofType)}
                    className="w-full max-h-40 object-contain"
                  />
                </div>
              )}
              <div className="p-2.5 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  {icon(proof.proofType)}
                  {label(proof.proofType)}
                </div>
                {proof.proofType === "barcode" && proof.data && (
                  <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{proof.data}</span>
                )}
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {new Date(proof.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
              {proof.notes && (
                <p className="border-t border-border px-2.5 py-2 text-xs text-muted-foreground">
                  {proof.notes}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
