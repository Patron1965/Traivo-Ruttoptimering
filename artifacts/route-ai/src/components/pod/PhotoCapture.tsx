import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Camera, X, Check } from "lucide-react";

interface PhotoCaptureProps {
  onCapture: (file: File, previewUrl: string) => void;
  onCancel: () => void;
}

export function PhotoCapture({ onCapture, onCancel }: PhotoCaptureProps) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<string | null>(null);
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const maxSize = 1200;
        let w = img.width;
        let h = img.height;
        if (w > maxSize || h > maxSize) {
          if (w > h) {
            h = Math.round((h / w) * maxSize);
            w = maxSize;
          } else {
            w = Math.round((w / h) * maxSize);
            h = maxSize;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        setPreview(dataUrl);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              setCapturedFile(new File([blob], file.name || "photo.jpg", { type: "image/jpeg" }));
            }
          },
          "image/jpeg",
          0.8,
        );
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-3">
      {!preview ? (
        <>
          <button
            onClick={() => inputRef.current?.click()}
            className="w-full flex flex-col items-center gap-3 py-8 rounded-xl border-2 border-dashed border-border hover:border-primary/50 hover:bg-primary/5 transition-colors"
          >
            <Camera className="h-10 w-10 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">{t("pod.takePhoto")}</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFile}
          />
          <button
            onClick={onCancel}
            className="w-full py-2 rounded-xl border border-border text-sm font-medium hover:bg-muted/50 transition-colors"
          >
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <>
          <div className="rounded-xl overflow-hidden border border-border">
            <img src={preview} alt="Preview" className="w-full max-h-48 object-cover" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setPreview(null); setCapturedFile(null); if (inputRef.current) inputRef.current.value = ""; }}
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl border border-border text-sm font-medium hover:bg-muted/50 transition-colors"
            >
              <X className="h-4 w-4" />
              {t("pod.retake")}
            </button>
            <button
              onClick={() => capturedFile && preview && onCapture(capturedFile, preview)}
              className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold transition-colors"
            >
              <Check className="h-4 w-4" />
              {t("pod.confirm")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
