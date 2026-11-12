import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { TileLayer, useMap } from "react-leaflet";
import { useTranslation } from "react-i18next";

type MapBackground = "light" | "standard" | "satellite" | "dark";

const STORAGE_KEY = "traivo-map-background";
const CHANGE_EVENT = "traivo-map-background-change";

const BACKGROUNDS: Record<
  MapBackground,
  { url: string; attribution: string; maxZoom?: number }
> = {
  light: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
    maxZoom: 16,
  },
  standard: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution:
      "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 19,
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 20,
  },
};

function isMapBackground(value: string | null): value is MapBackground {
  return value === "light" || value === "standard" || value === "satellite" || value === "dark";
}

function readStoredBackground(): MapBackground {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isMapBackground(stored) ? stored : "light";
}

export function MapBackgroundLayer() {
  const { t } = useTranslation();
  const map = useMap();
  const controlRef = useRef<HTMLDivElement>(null);
  const [background, setBackground] = useState<MapBackground>(readStoredBackground);

  useEffect(() => {
    const control = controlRef.current;
    if (!control) return;
    L.DomEvent.disableClickPropagation(control);
    L.DomEvent.disableScrollPropagation(control);
  }, []);

  useEffect(() => {
    const syncBackground = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== STORAGE_KEY) return;
      const next = readStoredBackground();
      setBackground(next);
    };

    window.addEventListener("storage", syncBackground);
    window.addEventListener(CHANGE_EVENT, syncBackground);
    return () => {
      window.removeEventListener("storage", syncBackground);
      window.removeEventListener(CHANGE_EVENT, syncBackground);
    };
  }, []);

  const selected = BACKGROUNDS[background];

  const handleChange = (next: MapBackground) => {
    setBackground(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
    window.requestAnimationFrame(() => map.invalidateSize());
  };

  return (
    <>
      <TileLayer
        key={background}
        url={selected.url}
        attribution={selected.attribution}
        maxZoom={selected.maxZoom}
      />
      <div className="leaflet-bottom leaflet-left">
        <div
          ref={controlRef}
          className="leaflet-control rounded-md bg-card/95 shadow-sm"
        >
          <label className="flex items-center gap-2">
            <span className="sr-only">{t("map.background")}</span>
            <select
              aria-label={t("map.background")}
              value={background}
              onChange={(event) => handleChange(event.target.value as MapBackground)}
              className="h-7 rounded border border-border bg-card px-1.5 py-0 text-[11px] font-semibold text-foreground outline-none [@media(pointer:coarse)]:h-11 focus-visible:ring-2 focus-visible:ring-primary"
            >
              <option value="light">{t("map.backgroundLight")}</option>
              <option value="standard">{t("map.backgroundStandard")}</option>
              <option value="satellite">{t("map.backgroundSatellite")}</option>
              <option value="dark">{t("map.backgroundDark")}</option>
            </select>
          </label>
        </div>
      </div>
    </>
  );
}