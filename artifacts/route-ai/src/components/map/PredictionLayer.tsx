import { useEffect, useState, useRef } from "react";
import { useMap, CircleMarker, Tooltip } from "react-leaflet";
import { useTranslation } from "react-i18next";
import { onWsMessage, subscribePredictions, unsubscribePredictions, ensureWsInitialized } from "@/lib/ws-client";
import { useAuth } from "@/lib/auth-context";

interface PredictionCell {
  lat: number;
  lng: number;
  congestionScore: number;
  predictedDelayMin: number;
}

interface PredictionResponse {
  metadata: {
    source: "simulation";
    mode: "simulation";
    isSimulation: true;
    generatedAt: string;
    horizonMinutes: number;
  };
  cells: PredictionCell[];
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

type PredictionStatus = "loading" | "ready" | "empty" | "error" | "unavailable";

function isPredictionCell(value: unknown): value is PredictionCell {
  if (!value || typeof value !== "object") return false;
  const cell = value as Record<string, unknown>;
  return (
    typeof cell.lat === "number" &&
    Number.isFinite(cell.lat) &&
    typeof cell.lng === "number" &&
    Number.isFinite(cell.lng) &&
    typeof cell.congestionScore === "number" &&
    Number.isFinite(cell.congestionScore) &&
    cell.congestionScore >= 0 &&
    cell.congestionScore <= 1 &&
    typeof cell.predictedDelayMin === "number" &&
    Number.isFinite(cell.predictedDelayMin) &&
    cell.predictedDelayMin >= 0
  );
}

function isSimulationResponse(value: unknown): value is PredictionResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  const metadata = response.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  return (
    meta.source === "simulation" &&
    meta.mode === "simulation" &&
    meta.isSimulation === true &&
    typeof meta.generatedAt === "string" &&
    typeof meta.horizonMinutes === "number" &&
    Number.isFinite(meta.horizonMinutes) &&
    Array.isArray(response.cells) &&
    response.cells.every(isPredictionCell)
  );
}

export function PredictionLayer({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const [cells, setCells] = useState<PredictionCell[]>([]);
  const [status, setStatus] = useState<PredictionStatus>("loading");
  const [opacity, setOpacity] = useState(0.6);
  const map = useMap();
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!visible) {
      setCells([]);
      setStatus("empty");
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      unsubscribePredictions();
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setCells([]);
    setStatus("loading");

    if (!organizationId) {
      setStatus("unavailable");
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    ensureWsInitialized(organizationId);

    const apiBase = import.meta.env.VITE_API_URL || "/api";
    const bounds = map.getBounds();
    const boundsStr = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;

    const applyResponse = (data: unknown) => {
      if (cancelled) return;
      if (!isSimulationResponse(data)) {
        // A response without an explicit simulation contract must never be
        // rendered as traffic data. Clear previous cells to fail closed.
        setCells([]);
        setStatus("error");
        return;
      }
      setCells(data.cells);
      setStatus(data.cells.length > 0 ? "ready" : "empty");
    };

    unsubRef.current = onWsMessage("predictions:update", applyResponse);
    subscribePredictions();

    fetch(`${apiBase}/predictions/traffic?bounds=${boundsStr}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Prediction request failed (${response.status})`);
        return response.json();
      })
      .then(applyResponse)
      .catch((error: unknown) => {
        if (cancelled || (error instanceof Error && error.name === "AbortError")) return;
        setCells([]);
        setStatus("error");
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      unsubscribePredictions();
    };
  }, [visible, map, organizationId]);

  if (!visible) return null;

  return (
    <>
      {cells.map((cell) => (
        <CircleMarker
          key={`${cell.lat}-${cell.lng}`}
          center={[cell.lat, cell.lng]}
          radius={Math.max(18, 40 * cell.congestionScore)}
          pathOptions={{
            fillColor: getCongestionColor(cell.congestionScore),
            fillOpacity: opacity * Math.max(0.35, cell.congestionScore * 0.85),
            color: getCongestionColor(cell.congestionScore),
            weight: 2,
            opacity: opacity * 0.7,
          }}
        >
          <Tooltip direction="top" sticky>
            <div className="text-xs space-y-1">
              <div className="font-bold">{t("predictions.simulationBadge")}</div>
              <div>{getCongestionLabel(cell.congestionScore, t)}</div>
              <div>{t("predictions.delay")}: +{cell.predictedDelayMin} min</div>
            </div>
          </Tooltip>
        </CircleMarker>
      ))}

      <PredictionControls status={status} opacity={opacity} onOpacityChange={setOpacity} />
    </>
  );
}

function PredictionControls({
  status,
  opacity,
  onOpacityChange,
}: {
  status: PredictionStatus;
  opacity: number;
  onOpacityChange: (v: number) => void;
}) {
  const { t } = useTranslation();
  const statusKey = status === "loading"
    ? "predictions.loading"
    : status === "empty"
      ? "predictions.empty"
      : status === "error"
        ? "predictions.error"
        : status === "unavailable"
          ? "predictions.unavailable"
          : null;

  return (
    <div className="leaflet-bottom leaflet-left" style={{ pointerEvents: "auto" }}>
      <div className="leaflet-control bg-card/95 backdrop-blur-md rounded-xl border border-border shadow-xl p-3 mb-4 ml-3" style={{ minWidth: 180 }}>
        <div className="text-xs font-bold mb-2 text-foreground">{t("predictions.heatmap")}</div>
        <div className="text-[10px] text-muted-foreground mb-3">{t("predictions.simulationNotice")}</div>
        {statusKey && (
          <div role="status" aria-live="polite" className="text-[10px] text-muted-foreground mb-3">
            {t(statusKey)}
          </div>
        )}

        {status === "ready" && (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] text-muted-foreground">0%</span>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round(opacity * 100)}
                onChange={(e) => onOpacityChange(Number(e.target.value) / 100)}
                className="flex-1 h-1.5 accent-primary cursor-pointer"
                aria-label={t("predictions.opacity")}
              />
              <span className="text-[10px] text-muted-foreground">100%</span>
            </div>

            <div className="space-y-1">
              {[
                { color: "#22c55e", label: t("predictions.levelLow") },
                { color: "#eab308", label: t("predictions.levelModerate") },
                { color: "#f97316", label: t("predictions.levelHigh") },
                { color: "#ef4444", label: t("predictions.levelVeryHigh") },
                { color: "#b91c1c", label: t("predictions.levelExtreme") },
              ].map((item) => (
                <div key={item.color} className="flex items-center gap-2 text-[10px]">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-muted-foreground">{item.label}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
