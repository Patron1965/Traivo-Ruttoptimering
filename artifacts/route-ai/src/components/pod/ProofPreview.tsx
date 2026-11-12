import { useState, type ReactNode } from "react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorkspaceImage } from "@/components/WorkspaceImage";

export interface PreviewProof {
  id: string;
  proofType: string;
  fileUrl?: string | null;
  data?: string | null;
  notes?: string | null;
}

function PreviewImage({ proof }: { proof: PreviewProof }) {
  const [failed, setFailed] = useState(false);
  const base = import.meta.env.VITE_API_URL || import.meta.env.BASE_URL.replace(/\/$/, "");
  const src = proof.fileUrl ? `${base}/api/storage${proof.fileUrl}`
    : proof.data?.startsWith("data:") ? proof.data : null;
  if (!src || failed) return <p role="alert">Bilden kunde inte visas. Stäng och försök igen.</p>;
  return <WorkspaceImage src={src} alt={proof.proofType === "signature" ? "Chaufförens insamlade signatur" : "Chaufförens foto"}
    onError={() => setFailed(true)} className="mx-auto max-h-[65dvh] w-full object-contain rounded bg-white" />;
}

export function ProofPreview({ proofs, children, className, testId }: {
  proofs: PreviewProof[]; children: ReactNode; className?: string; testId?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={`${className ?? ""} cursor-pointer hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary`}
          data-testid={testId} aria-label="Visa chaufförens bilagor">{children}</button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Chaufförens bilagor</DialogTitle>
          <DialogDescription>Foto, signatur eller annan dokumentation för stoppet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {proofs.map(proof => <div key={proof.id} className="space-y-2">
            {proof.proofType === "photo" || proof.proofType === "signature"
              ? <PreviewImage proof={proof} />
              : <p className="break-all">{proof.data || "Ingen bilagedata tillgänglig."}</p>}
            {proof.notes && <p className="whitespace-pre-wrap text-sm">{proof.notes}</p>}
          </div>)}
        </div>
      </DialogContent>
    </Dialog>
  );
}
