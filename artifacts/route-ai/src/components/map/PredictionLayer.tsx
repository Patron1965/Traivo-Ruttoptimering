import { useEffect, useState, useRef } from "react";
import { useMap, Rectangle, Tooltip } from "react-leaflet";
import { useTranslation } from "react-i18next";
import { onWsMessage } from "@/lib/ws-client";

interface PredictionCell {
  lat: number;
  lng: number;
  congestionScore: number;
  predictedDelayMin: number;
  confidence: number;
}

function getCongestionColor(score: number): string {
  if (score < 0.2) return "rgba(34, 197, 94, 0.25)";
  if (score < 0.4) return "rgba(250, 204, 21, 0.35)";
  if (score < 0.6) return "rgba(249, 115, 22, 0.45)";
  if (score < 0.8) return "rgba(239, 68, 68, 0.55)";
  return "rgba(185, 28, 28, 0.65)";
}

function getCongestionLabel(score: number, t: (key: string) => string): string {
  if (score < 0.2) return t("predictions.levelLow");
  if (score < 0.4) return t("predictions.levelModerate");
  if (score < 0.6) return t("predictions.levelHigh");
  if (score < 0.8) return t("predictions.levelVeryHigh");
  return t("predictions.levelExtreme");
}

const CELL_SIZE = 0.008;

export function PredictionLayer({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [cells, setCells] = useState<PredictionCell[]>([]);
  const map = useMap();
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!visible) return;

    const apiBase = import.meta.env.VITE_API_URL || "/api";
    const bounds = map.getBounds();
    const boundsStr = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    fetch(`${apiBase}/predictions/traffic?bounds=${boundsStr}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.predictions) setCells(d.predictions);
      })
      .catch(() => {});

    unsubRef.current = onWsMessage("traffic:predictions", (data: PredictionCell[]) => {
      setCells(data);
    });

    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, [visible, map]);

  if (!visible || cells.length === 0) return null;

  return (
    <>
      {cells.map((cell) => {
        const bounds: [[number, number], [number, number]] = [
          [cell.lat - CELL_SIZE / 2, cell.lng - CELL_SIZE / 2],
          [cell.lat + CELL_SIZE / 2, cell.lng + CELL_SIZE / 2],
        ];
        return (
          <Rectangle
            key={`${cell.lat}-${cell.lng}`}
            bounds={bounds}
            pathOptions={{
              fillColor: getCongestionColor(cell.congestionScore),
              fillOpacity: 1,
              stroke: false,
              interactive: true,
            }}
          >
            <Tooltip direction="top" sticky>
              <div className="text-xs space-y-1">
                <div className="font-bold">{getCongestionLabel(cell.congestionScore, t)}</div>
                <div>{t("predictions.delay")}: +{cell.predictedDelayMin} min</div>
                <div>{t("predictions.confidence")}: {Math.round(cell.confidence * 100)}%</div>
              </div>
            </Tooltip>
          </Rectangle>
        );
      })}
    </>
  );
}
