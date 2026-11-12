import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { Map, LayerGroup } from "leaflet";
import "leaflet/dist/leaflet.css";
import type { NativeMapProps } from "./map-types";

const validCoordinate = (point: { latitude: number; longitude: number }) =>
  Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
  && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;

export default function NativeMap(props: NativeMapProps) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const layers = useRef<LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  useEffect(() => {
    const instance = map.current;
    const command = props.viewportCommand;
    if (!ready || !instance || !command) return;
    if (command.type === "in") instance.zoomIn();
    else if (command.type === "out") instance.zoomOut();
    else {
      const points = props.stops.filter(validCoordinate).map(s => [s.latitude, s.longitude] as [number, number]);
      if (points.length) instance.fitBounds(points, { padding: [45, 45], maxZoom: 16 });
    }
  }, [ready, props.viewportCommand]);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import("leaflet").then((L) => {
      if (disposed || !element.current) return;
      const instance = L.map(element.current, { zoomControl: false })
        .setView([59.33, 18.07], 12);
      map.current = instance;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).on("tileerror", () => setTileError(true))
        .on("tileload", () => setTileError(false)).addTo(instance);
      layers.current = L.layerGroup().addTo(instance);
      observer = new ResizeObserver(() => instance.invalidateSize());
      observer.observe(element.current);
      setReady(true);
    }).catch(() => { if (!disposed) setTileError(true); });
    return () => {
      disposed = true;
      observer?.disconnect();
      map.current?.remove();
      map.current = null;
      layers.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    void import("leaflet").then((L) => {
      const instance = map.current;
      const group = layers.current;
      if (disposed || !instance || !group) return;
      group.clearLayers();
      const stops = props.stops.filter(validCoordinate);
      const coordinates = props.polylineCoords.filter(validCoordinate)
        .map((point) => [point.latitude, point.longitude] as [number, number]);
      if (coordinates.length > 1) {
        L.polyline(coordinates, { color: props.outlineColor, weight: 8 }).addTo(group);
        L.polyline(coordinates, {
          color: props.primaryColor, weight: 4,
          dashArray: props.routeSource === "fallback" ? "10 7" : undefined,
        }).addTo(group);
      }
      for (const stop of stops) {
        // DOM text and styles avoid interpreting customer data as HTML.
        const badge = document.createElement("span");
        badge.textContent = String(stop.sequence ?? "?");
        Object.assign(badge.style, {
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "30px", height: "30px", borderRadius: "50%", color: "#fff",
          backgroundColor: stop.color, border: `2px solid ${props.outlineColor}`,
          fontWeight: "700", fontSize: "12px",
        });
        if (stop.id === props.nextStopId) Object.assign(badge.style, { width: "38px", height: "38px", boxShadow: `0 0 0 4px ${props.primaryColor}33` });
        if (stop.id === props.selectedStopId) badge.style.border = `4px solid ${props.primaryColor}`;
        const label = document.createElement("span");
        label.textContent = `#${stop.sequence ?? "?"} ${stop.address}`;
        L.marker([stop.latitude, stop.longitude], {
          icon: L.divIcon({ html: badge, className: "", iconSize: [32, 32], iconAnchor: [16, 16] }),
        }).bindTooltip(label).on("click", () => props.onSelectStop?.(stop.id)).addTo(group);
      }
      const bounds = coordinates.length > 1 ? coordinates
        : stops.map((stop) => [stop.latitude, stop.longitude] as [number, number]);
      if (bounds.length) instance.fitBounds(L.latLngBounds(bounds), {
        paddingTopLeft: [40, 90], paddingBottomRight: [40, props.bottomPadding + 90], maxZoom: 16,
      });
    });
    return () => { disposed = true; };
  }, [ready, props.stops, props.polylineCoords, props.primaryColor, props.outlineColor, props.routeSource, props.bottomPadding, props.nextStopId, props.selectedStopId, props.onSelectStop]);

  return (
    <View style={{ position: "absolute", inset: 0, zIndex: 0 }} testID="driver-geographic-map">
      <div ref={element} style={{ width: "100%", height: "100%" }} />
      {tileError && (
        <View style={{ position: "absolute", top: 100, left: 16, right: 16, backgroundColor: "#fff", padding: 12, zIndex: 500 }}>
          <Text>Kartbakgrunden kunde inte laddas. Kontrollera anslutningen. Stoppens koordinater visas fortfarande.</Text>
        </View>
      )}
    </View>
  );
}
