import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanBarcode, Check } from "lucide-react";

interface BarcodeInputProps {
  onCapture: (value: string) => void;
  onCancel: () => void;
}

export function BarcodeInput({ onCapture, onCancel }: BarcodeInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <ScanBarcode className="h-4 w-4" />
        {t("pod.barcodeInstruction")}
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("pod.barcodePlaceholder")}
        className="w-full px-3 py-2.5 rounded-xl border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        autoFocus
      />
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded-xl border border-border text-sm font-medium hover:bg-muted/50 transition-colors"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={() => value.trim() && onCapture(value.trim())}
          disabled={!value.trim()}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold disabled:opacity-40 transition-colors"
        >
          <Check className="h-4 w-4" />
          {t("pod.confirm")}
        </button>
      </div>
    </div>
  );
}
