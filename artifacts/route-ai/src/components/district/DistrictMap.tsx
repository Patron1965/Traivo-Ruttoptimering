import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { DistrictPoint, LatLng } from "@/lib/district-api";

export interface MapMarker { lat: number; lng: number; label: string; tone: "start" | "end" }

export interface DistrictMapProps {
  points: readonly DistrictPoint[];
  zoneColors: ReadonlyMap<string, string>;
  /** Points currently in the draft/selection (highlighted). */
  selected?: ReadonlySet<string>;
  /** When set, only these points are shown at full strength. */
  focus?: ReadonlySet<string> | null;
  draftColor?: string;
  polygon?: readonly LatLng[];
  editablePolygon?: boolean;
  drawing?: boolean;
  onVertexMove?: (index: number, vertex: LatLng) => void;
  onVertexRemove?: (index: number) => void;
  onMapClick?: (vertex: LatLng) => void;
  onPointClick?: (point: DistrictPoint) => void;
  route?: readonly { latitude: number; longitude: number }[];
  sequence?: ReadonlyMap<string, number>;
  highlightSequence?: ReadonlySet<string>;
  markers?: readonly MapMarker[];
  fitKey?: string;
  cursor?: "crosshair" | "default";
}

const UNZONED = "#7c8795";
const CLUSTER_BELOW_ZOOM = 14;

function Layers(props: DistrictMapProps) {
  const map = useMap();
  const renderer = useMemo(() => L.canvas({ padding: 0.3 }), []);
  const [view, setView] = useState(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const bump = () => setView((v) => v + 1);
    map.on("moveend zoomend", bump);
    const click = (e: L.LeafletMouseEvent) => propsRef.current.onMapClick?.({ lat: e.latlng.lat, lng: e.latlng.lng });
    map.on("click", click);
    return () => { map.off("moveend zoomend", bump); map.off("click", click); };
  }, [map]);

  useEffect(() => {
    const container = map.getContainer();
    container.classList.toggle("leaflet-crosshair", props.cursor === "crosshair");
    container.style.cursor = props.cursor === "crosshair" ? "crosshair" : "";
    return () => { container.classList.remove("leaflet-crosshair"); container.style.cursor = ""; };
  }, [map, props.cursor]);

  // A live segment makes the drawing tool visible before the next click.
  useEffect(() => {
    if (!props.drawing || !props.polygon?.length) return;
    const last = props.polygon[props.polygon.length - 1];
    const preview = L.polyline([], { renderer, color: props.draftColor ?? "#0891b2", weight: 2, dashArray: "4 6", interactive: false }).addTo(map);
    const move = (e: L.LeafletMouseEvent) => preview.setLatLngs([[last.lat, last.lng], e.latlng]);
    const leave = () => preview.setLatLngs([]);
    map.on("mousemove", move);
    map.getContainer().addEventListener("mouseleave", leave);
    return () => { map.off("mousemove", move); map.getContainer().removeEventListener("mouseleave", leave); preview.remove(); };
  }, [map, renderer, props.drawing, props.polygon, props.draftColor]);

  // Fit to data when the dataset/zone changes.
  useEffect(() => {
    const src = props.focus && props.focus.size > 0 ? props.points.filter((p) => props.focus!.has(p.id)) : props.points;
    if (src.length === 0) return;
    const bounds = L.latLngBounds(src.map((p) => [p.latitude, p.longitude] as [number, number]));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, props.fitKey]);

  // Points: grid clusters when zoomed out, canvas circles when zoomed in.
  useEffect(() => {
    const layer = L.layerGroup().addTo(map);
    const { points, zoneColors, selected, focus, draftColor, onPointClick, sequence, highlightSequence } = props;
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.2);
    const colorOf = (p: DistrictPoint) => (p.zoneId ? zoneColors.get(p.zoneId) ?? UNZONED : UNZONED);

    if (zoom < CLUSTER_BELOW_ZOOM) {
      const cell = 56;
      const cells = new Map<string, { n: number; lat: number; lng: number; colors: Map<string, number>; sel: number }>();
      for (const p of points) {
        if (!bounds.contains([p.latitude, p.longitude])) continue;
        const px = map.project([p.latitude, p.longitude], zoom);
        const key = `${Math.floor(px.x / cell)}:${Math.floor(px.y / cell)}`;
        let c = cells.get(key);
        if (!c) { c = { n: 0, lat: 0, lng: 0, colors: new Map(), sel: 0 }; cells.set(key, c); }
        c.n += 1; c.lat += p.latitude; c.lng += p.longitude;
        const col = colorOf(p);
        c.colors.set(col, (c.colors.get(col) ?? 0) + 1);
        if (selected?.has(p.id)) c.sel += 1;
      }
      for (const c of cells.values()) {
        const lat = c.lat / c.n, lng = c.lng / c.n;
        if (c.n === 1) {
          L.circleMarker([lat, lng], { interactive: !props.drawing, renderer, radius: 4, weight: 1, color: "#1f2937", fillColor: [...c.colors.keys()][0], fillOpacity: 0.9 }).addTo(layer);
          continue;
        }
        const dominant = [...c.colors.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const size = c.n < 50 ? 30 : c.n < 300 ? 38 : 46;
        const ring = c.sel > 0 ? `box-shadow:0 0 0 3px ${draftColor ?? "#0891b2"};` : "";
        const icon = L.divIcon({
          className: "",
          iconSize: [size, size],
          html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${dominant};opacity:.92;color:#fff;font:600 11px/1 Inter,sans-serif;display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,.85);${ring}" aria-label="${c.n} poster">${c.n}${c.sel > 0 && c.sel < c.n ? `<span style="position:absolute;margin-top:${size}px;font-size:9px;color:#0f172a;background:#fff;border-radius:4px;padding:1px 3px">${c.sel}</span>` : ""}</div>`,
        });
        L.marker([lat, lng], { icon, keyboard: false, interactive: !props.drawing })
          .on("click", () => map.setView([lat, lng], Math.min(zoom + 2, 18)))
          .addTo(layer);
      }
    } else {
      for (const p of points) {
        if (!bounds.contains([p.latitude, p.longitude])) continue;
        const isSel = selected?.has(p.id) ?? false;
        const dim = focus && !focus.has(p.id);
        const hl = highlightSequence?.has(p.id);
        const m = L.circleMarker([p.latitude, p.longitude], {
          interactive: !props.drawing,
          renderer,
          radius: isSel || hl ? 7 : 5,
          weight: p.exported ? 3 : isSel ? 2.5 : 1,
          color: p.exported ? "#111827" : isSel ? (draftColor ?? "#0891b2") : "#1f2937",
          dashArray: p.exported ? "2 2" : undefined,
          fillColor: hl ? "#f59f00" : isSel ? (draftColor ?? "#0891b2") : colorOf(p),
          fillOpacity: dim ? 0.18 : 0.9,
          opacity: dim ? 0.3 : 1,
        });
        const seq = sequence?.get(p.id);
        m.bindTooltip(`${seq ? `#${seq} · ` : ""}${escapeHtml(p.objectNumber)} · ${escapeHtml(p.address)}${p.exported ? " · tidigare exporterad" : ""}`);
        if (onPointClick) m.on("click", (e) => { L.DomEvent.stopPropagation(e); propsRef.current.onPointClick?.(p); });
        m.addTo(layer);
        if (seq && zoom >= 16) {
          L.marker([p.latitude, p.longitude], {
            interactive: false,
            icon: L.divIcon({ className: "", iconSize: [22, 14], iconAnchor: [11, 20], html: `<div style="font:700 10px/14px Inter,sans-serif;text-align:center;background:#0f172a;color:#fff;border-radius:4px">${seq}</div>` }),
          }).addTo(layer);
        }
      }
    }
    return () => { layer.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, renderer, view, props.points, props.zoneColors, props.selected, props.focus, props.draftColor, props.sequence, props.highlightSequence, props.drawing]);

  // Route geometry.
  useEffect(() => {
    if (!props.route || props.route.length < 2) return;
    const line = L.polyline(props.route.map((g) => [g.latitude, g.longitude] as [number, number]), { renderer, interactive: false, color: "#0f172a", weight: 3, opacity: 0.75 }).addTo(map);
    return () => { line.remove(); };
  }, [map, renderer, props.route]);

  // Polygon + draggable vertices.
  useEffect(() => {
    const poly = props.polygon;
    if (!poly || poly.length === 0) return;
    const group = L.layerGroup().addTo(map);
    const color = props.draftColor ?? "#0891b2";
    const shape = poly.length >= 3
      ? L.polygon(poly.map((v) => [v.lat, v.lng] as [number, number]), { renderer, color, weight: 2, fillOpacity: 0.08, dashArray: "6 4", interactive: false })
      : L.polyline(poly.map((v) => [v.lat, v.lng] as [number, number]), { renderer, color, weight: 2, dashArray: "6 4", interactive: false });
    shape.addTo(group);
    if (props.editablePolygon) {
      poly.forEach((v, index) => {
        const marker = L.marker([v.lat, v.lng], {
          draggable: true,
          title: `Hörn ${index + 1}. Dra för att flytta, dubbelklicka för att ta bort.`,
          icon: L.divIcon({ className: "", iconSize: [14, 14], html: `<div style="width:14px;height:14px;border-radius:3px;background:#fff;border:2px solid ${color}"></div>` }),
        });
        marker.on("dragend", () => { const ll = marker.getLatLng(); propsRef.current.onVertexMove?.(index, { lat: ll.lat, lng: ll.lng }); });
        marker.on("dblclick", (e) => { L.DomEvent.stopPropagation(e); propsRef.current.onVertexRemove?.(index); });
        marker.addTo(group);
      });
    }
    return () => { group.remove(); };
  }, [map, renderer, props.polygon, props.editablePolygon, props.draftColor]);

  useEffect(() => {
    if (!props.markers?.length) return;
    const group = L.layerGroup().addTo(map);
    for (const m of props.markers) {
      const bg = m.tone === "start" ? "#2b8a3e" : "#c92a2a";
      L.marker([m.lat, m.lng], {
        interactive: false,
        zIndexOffset: 1000,
        icon: L.divIcon({ className: "", iconSize: [28, 28], iconAnchor: [14, 28], html: `<div style="background:${bg};color:#fff;font:700 11px/28px Inter,sans-serif;text-align:center;border-radius:14px 14px 14px 2px;border:2px solid #fff">${m.label}</div>` }),
      }).addTo(group);
    }
    return () => { group.remove(); };
  }, [map, props.markers]);

  return null;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function DistrictMap(props: DistrictMapProps) {
  return (
    <MapContainer center={[57.7089, 11.9746]} zoom={11} preferCanvas doubleClickZoom={false} className="h-full w-full" data-testid="map-district">
      <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Layers {...props} />
    </MapContainer>
  );
}

export function MapLegend({ zoneCount }: { zoneCount: number }) {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-[400] rounded-md border bg-card/95 px-3 py-2 text-[11px] text-card-foreground shadow" data-testid="map-legend">
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: UNZONED }} />Ej zonindelad</div>
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full border-2 border-dashed border-slate-900 bg-transparent" />Tidigare exporterad</div>
      <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />Valt intervall</div>
      <div className="text-muted-foreground">{zoneCount} zoner i färg · zooma in för enskilda poster</div>
    </div>
  );
}
