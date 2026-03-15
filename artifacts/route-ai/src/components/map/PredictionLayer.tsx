import { useEffect, useState, useRef } from "react";
import { useMap, CircleMarker, Tooltip } from "react-leaflet";
import { useTranslation } from "react-i18next";
import { onWsMessage, subscribePredictions, unsubscribePredictions, ensureWsInitialized } from "@/lib/ws-client";
import { ORG_ID } from "@/lib/constants";

interface PredictionCell {
  lat: number;
  lng: number;
  congestionScore: number;
  predictedDelayMin: number;
  confidence: number;
}

function getCongestionColor(score: number): string {
  if (score < 0.2) return "#22c55e";
  if (score < 0.4) return "#eab308";
  if (score < 0.6) return "#f97316";
  if (score < 0.8) return "#ef4444";
  return "#b91c1c";
}

function getCongestionLabel(score: number, t: (key: string) => string): string {
  if (score < 0.2) return t("predictions.levelLow");
  if (score < 0.4) return t("predictions.levelModerate");
  if (score < 0.6) return t("predictions.levelHigh");
  if (score < 0.8) return t("predictions.levelVeryHigh");
  return t("predictions.levelExtreme");
}

export function PredictionLayer({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [cells, setCells] = useState<PredictionCell[]>([]);
  const [opacity, setOpacity] = useState(0.6);
  const map = useMap();
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!visible) {
      setCells([]);
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      unsubscribePredictions();
      return;
    }

    ensureWsInitialized(ORG_ID);

    const apiBase = import.meta.env.VITE_API_URL || "/api";
    const bounds = map.getBounds();
    const boundsStr = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    fetch(`${apiBase}/predictions/traffic?bounds=${boundsStr}`)
      .then((r) => r.json())
      .then((data: PredictionCell[]) => {
        if (Array.isArray(data)) setCells(data);
      })
      .catch(() => {});

    subscribePredictions();

    unsubRef.current = onWsMessage("predictions:update", (data: unknown) => {
      if (Array.isArray(data)) setCells(data as PredictionCell[]);
    });

    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      unsubscribePredictions();
    };
  }, [visible, map]);

  if (!visible || cells.length === 0) return null;

  return (
    <>
      {cells.map((cell) => (
        <CircleMarker
          key={`${cell.lat}-${cell.lng}`}
          center={[cell.lat, cell.lng]}
          radius={Math.max(8, 18 * cell.congestionScore)}
          pathOptions={{
            fillColor: getCongestionColor(cell.congestionScore),
            fillOpacity: opacity * cell.congestionScore,
            color: getCongestionColor(cell.congestionScore),
            weight: 0,
            opacity: opacity,
          }}
        >
          <Tooltip direction="top" sticky>
            <div className="text-xs space-y-1">
              <div className="font-bold">{getCongestionLabel(cell.congestionScore, t)}</div>
              <div>{t("predictions.delay")}: +{cell.predictedDelayMin} min</div>
              <div>{t("predictions.confidence")}: {Math.round(cell.confidence * 100)}%</div>
            </div>
          </Tooltip>
        </CircleMarker>
      ))}

      <PredictionControls opacity={opacity} onOpacityChange={setOpacity} />
    </>
  );
}

function PredictionControls({ opacity, onOpacityChange }: { opacity: number; onOpacityChange: (v: number) => void }) {
  const { t } = useTranslation();

  return (
    <div className="leaflet-bottom leaflet-left" style={{ pointerEvents: "auto" }}>
      <div className="leaflet-control bg-card/95 backdrop-blur-md rounded-xl border border-border shadow-xl p-3 mb-4 ml-3" style={{ minWidth: 180 }}>
        <div className="text-xs font-bold mb-2 text-foreground">{t("predictions.heatmap")}</div>

        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] text-muted-foreground">0%</span>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(opacity * 100)}
            onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
            className="flex-1 h-1.5 accent-primary cursor-pointer"
          />
          <span className="text-[10px] text-muted-foreground">100%</span>
        </div>

        <div className="space-y-1">
          {[
            { color: "#22c55e", label: t("predictions.levelLow") },
            { color: "#eab308", label: t("predictions.levelModerate") },
            { color: "#ef4444", label: t("predictions.levelHigh") },
          ].map((item) => (
            <div key={item.color} className="flex items-center gap-2 text-[10px]">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
              <span className="text-muted-foreground">{item.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
