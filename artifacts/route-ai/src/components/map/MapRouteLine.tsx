import { Polyline } from "react-leaflet";
import { DomEvent, type LeafletMouseEvent } from "leaflet";

interface MapRouteLineProps {
  positions: [number, number][];
  isFallback?: boolean;
  isActual?: boolean;
  isDimmed?: boolean;
  isHighlighted?: boolean;
  color?: string;
  weight?: number;
  opacity?: number;
  dashArray?: string;
  routeId?: string;
  onSelect?: (event: LeafletMouseEvent) => void;
}

export function MapRouteLine({
  positions,
  isFallback = false,
  isActual = false,
  isDimmed = false,
  isHighlighted = false,
  color = "#06B6D4",
  weight = 5,
  opacity = 0.9,
  dashArray,
  routeId,
  onSelect,
}: MapRouteLineProps) {
  if (!positions || positions.length < 2) return null;

  const baseWeight = isHighlighted ? weight + 1 : weight;
  const casingWeight = baseWeight + 2;
  const shadowWeight = casingWeight + 2;

  const actualOpacity = isDimmed ? 0.68 : (isHighlighted ? 1.0 : Math.max(opacity, 0.92));
  const casingOpacity = isDimmed ? 0.62 : (isHighlighted ? 0.95 : 0.82);
  const shadowOpacity = isDimmed ? 0.12 : (isHighlighted ? 0.24 : 0.16);
  // A continuous hit area also makes dashed fallback routes easy to select.
  // Decorative layers never intercept clicks, including during stop-area marking.
  const hitArea = onSelect ? (
    <Polyline
      key="hit-area"
      positions={positions}
      bubblingMouseEvents={false}
      className={`map-route-hit-${routeId} cursor-pointer`}
      pathOptions={{ color: "transparent", weight: Math.max(14, shadowWeight), opacity: 0 }}
      eventHandlers={{
        click: (event) => {
          const original = event.originalEvent;
          DomEvent.stopPropagation(original);
          onSelect(event);
        },
      }}
    />
  ) : null;

  if (isFallback) {
    return (
      <>
        <Polyline
          key="fallback"
          interactive={false}
          positions={positions}
          pathOptions={{
            color: isHighlighted ? color : "#64748B",
            weight: isDimmed ? 4 : (isHighlighted ? baseWeight : Math.max(4, baseWeight - 1)),
            opacity: isDimmed ? 0.62 : (isHighlighted ? 1 : 0.82),
            dashArray: dashArray || "6, 8",
            lineCap: "round",
            lineJoin: "round",
          }}
        />
        {hitArea}
      </>
    );
  }

  return (
    <>
      {shadowOpacity > 0 && (
        <Polyline
          key="shadow"
          interactive={false}
          positions={positions}
          pathOptions={{
            color: "#000000",
            weight: shadowWeight,
            opacity: shadowOpacity,
            lineCap: "round",
            lineJoin: "round",
          }}
        />
      )}

      <Polyline
        key="casing"
        interactive={false}
        positions={positions}
        pathOptions={{
          color: "#ffffff",
          weight: casingWeight,
          opacity: casingOpacity,
          lineCap: "round",
          lineJoin: "round",
        }}
      />

      <Polyline
        key="route"
        interactive={false}
        positions={positions}
        pathOptions={{
          color,
          weight: isDimmed ? Math.max(4, weight - 1) : (isActual ? baseWeight + 1 : baseWeight),
          opacity: actualOpacity,
          dashArray: isActual ? (dashArray || "2, 6") : dashArray,
          lineCap: "round",
          lineJoin: "round",
        }}
      />
      {hitArea}
    </>
  );
}
