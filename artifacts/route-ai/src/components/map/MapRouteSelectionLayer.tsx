import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { MapRouteLine } from "./MapRouteLine";
import { MapRouteChoices } from "./MapDriverSelection";

export interface SelectableMapRoute {
  id: string;
  name: string;
  positions: [number, number][];
  isFallback: boolean;
  isDimmed: boolean;
  isHighlighted: boolean;
  color: string;
  weight: number;
  opacity: number;
}

/** Hit-test every displayed route, not just Leaflet's topmost SVG path. */
export function MapRouteSelectionLayer({ routes, onSelect, dropRequest, onDropRoute }: {
  routes: SelectableMapRoute[];
  onSelect?: (routeId: string, additive: boolean) => void;
  dropRequest?: { clientX: number; clientY: number; nonce: number } | null;
  onDropRoute?: (routeId: string | null) => void;
}) {
  const map = useMap();
  const [choice, setChoice] = useState<{
    point: L.LatLng;
    routeIds: string[];
    additive: boolean;
    isDrop?: boolean;
  } | null>(null);
  const dismiss = () => setChoice(null);
  const choiceElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!choice) return;
    const doc = map.getContainer().ownerDocument;
    const closeOutside = (event: PointerEvent) => {
      if (!choiceElement.current?.contains(event.target as Node)) setChoice(null);
    };
    doc.addEventListener("pointerdown", closeOutside);
    return () => doc.removeEventListener("pointerdown", closeOutside);
  }, [choice, map]);
  const consumedDrop = useRef<number | null>(null);
  useEffect(() => {
    if (!dropRequest || consumedDrop.current === dropRequest.nonce) return;
    consumedDrop.current = dropRequest.nonce;
    const bounds = map.getContainer().getBoundingClientRect();
    const point = map.containerPointToLayerPoint(L.point(dropRequest.clientX - bounds.left, dropRequest.clientY - bounds.top));
    const hits = routes.filter(route => {
      const points = route.positions.map(position => map.latLngToLayerPoint(position));
      return points.some((end, index) => index > 0 && L.LineUtil.pointToSegmentDistance(point, points[index - 1], end) <= 12);
    });
    if (hits.length === 1) onDropRoute?.(hits[0].id);
    else if (hits.length > 1) setChoice({
      point: map.layerPointToLatLng(point), routeIds: hits.map(route => route.id), additive: false, isDrop: true,
    });
    else onDropRoute?.(null);
  }, [dropRequest, map, routes, onDropRoute]);
  // Choices are portalled above surrounding toolbars, without moving the map.
  useMapEvents({ click: dismiss, zoomstart: dismiss, dragstart: dismiss });

  const handleClick = (event: L.LeafletMouseEvent) => {
    if (!onSelect) return;
    const point = map.latLngToLayerPoint(event.latlng);
    const hits = routes.filter((route) => {
      // Match the continuous hit area, with one pixel for SVG simplification.
      const tolerance = Math.max(14, route.weight + (route.isHighlighted ? 1 : 0) + 4) / 2 + 1;
      const points = route.positions.map((position) => map.latLngToLayerPoint(position));
      return points.some((end, index) => index > 0
        && L.LineUtil.pointToSegmentDistance(point, points[index - 1], end) <= tolerance);
    });
    const original = event.originalEvent;
    const additive = original.shiftKey || original.ctrlKey || original.metaKey;
    if (hits.length === 1) {
      dismiss();
      onSelect(hits[0].id, additive);
    } else if (hits.length > 1) {
      setChoice({ point: event.latlng, routeIds: hits.map((route) => route.id), additive });
    }
  };
  const candidates = choice ? routes.filter((route) => choice.routeIds.includes(route.id)) : [];
  const containerBounds = map.getContainer().getBoundingClientRect();
  const anchor = choice ? map.latLngToContainerPoint(choice.point) : L.point(0, 0);
  const doc = map.getContainer().ownerDocument;
  const width = Math.min(288, doc.documentElement.clientWidth - 16);
  const closeAndFocusMap = () => {
    dismiss();
    map.getContainer().focus();
  };

  return <>
    {routes.map((route) => (
      <MapRouteLine key={route.id} {...route} routeId={route.id}
        onSelect={onSelect ? handleClick : undefined} />
    ))}
    {choice && candidates.length > 1 && createPortal(
      <div ref={choiceElement} className="fixed z-[1500] rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        style={{ width, maxHeight: "calc(100vh - 16px)", overflowY: "auto",
          left: Math.max(8, Math.min(containerBounds.left + anchor.x, doc.documentElement.clientWidth - width - 8)),
          top: Math.max(8, Math.min(containerBounds.top + anchor.y, doc.documentElement.clientHeight - 290)) }}
        onClick={event => event.stopPropagation()}>
        <MapRouteChoices routes={candidates}
          selected={new Set(routes.filter((route) => route.isHighlighted).map((route) => route.id))}
          additive={choice.additive}
          onClose={closeAndFocusMap}
          onSelect={(routeId, additive) => {
            closeAndFocusMap();
            if (choice.isDrop) onDropRoute?.(routeId);
            else onSelect?.(routeId, additive);
          }} />
      </div>, doc.body,
    )}
  </>;
}
