import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Stop } from "@workspace/api-client-react";
import { Expand, MapPinned, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RouteMap } from "@/components/map/RouteMap";

interface GeocodingReviewMapProps {
  stops: Stop[];
  mappedPickupCount: number;
  mappedDeliveryCount: number;
  selectedStopId: string | null;
  focusStopId: string | null;
  stopMarkerLabels: Record<string, string>;
  onSelectStop: (stopId: string) => void;
  onReviewAddress: (stopId: string) => void;
  onClearFocus: () => void;
}

function getCopy(language: string) {
  const swedish = language.toLowerCase().startsWith("sv");
  return swedish
    ? {
        title: "Karta över geokodade adresser",
         description: "Zooma med +/−, mushjulet eller två fingrar. Klicka på markörer för adressen och på grupper för att zooma in. H = hämtning, L = leverans.",
        mapped: "kartlagda",
        pickup: "hämtning",
        delivery: "leverans",
        showAll: "Visa alla stopp",
        enlarge: "Förstora kartan",
        close: "Stäng kartan",
        selected: "Valt stopp",
        review: "Granska adress",
        noSelection: "Välj en markör för att se adressen här.",
        mapDescription: "Karta över adresser",
      }
    : {
        title: "Geocoded address map",
         description: "Zoom with +/−, the mouse wheel or two fingers. Click markers for addresses and groups to zoom in. H = pickup, L = delivery.",
        mapped: "mapped",
        pickup: "pickup",
        delivery: "delivery",
        showAll: "Show all stops",
        enlarge: "Enlarge map",
        close: "Close map",
        selected: "Selected stop",
        review: "Review address",
        noSelection: "Select a marker to see its address here.",
        mapDescription: "Map of addresses",
      };
}

export function GeocodingReviewMap({
  stops,
  mappedPickupCount,
  mappedDeliveryCount,
  selectedStopId,
  focusStopId,
  stopMarkerLabels,
  onSelectStop,
  onReviewAddress,
  onClearFocus,
}: GeocodingReviewMapProps) {
  const { i18n } = useTranslation();
  const copy = getCopy(i18n.language);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fitStopsRequest, setFitStopsRequest] = useState(0);

  const selectedStop = useMemo(
    () => stops.find((stop) => stop.id === selectedStopId) ?? null,
    [selectedStopId, stops],
  );

  const showAllStops = () => {
    onClearFocus();
    setFitStopsRequest((request) => request + 1);
  };
  const openFullscreen = () => setIsFullscreen(true);
  const closeFullscreen = () => setIsFullscreen(false);
  const reviewSelectedAddress = (stopId: string) => {
    setIsFullscreen(false);
    onReviewAddress(stopId);
  };

  const map = (
    <RouteMap
      key={isFullscreen ? "geocoding-review-map-fullscreen" : "geocoding-review-map-inline"}
      routes={[]}
      unassignedStops={stops}
      interactive
      selectedStopId={selectedStopId}
      focusStopId={focusStopId}
      onSelectStop={(stopId) => onSelectStop(stopId)}
      fitStopsRequest={fitStopsRequest}
      showDepot={false}
      stopMarkerLabels={stopMarkerLabels}
    />
  );

  const toolbar = (fullscreen = false) => (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium">{stops.length} {copy.mapped}</span>
        <span aria-hidden="true">·</span>
        <span>{mappedPickupCount} {copy.pickup}</span>
        <span aria-hidden="true">·</span>
        <span>{mappedDeliveryCount} {copy.delivery}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={showAllStops}
          disabled={stops.length === 0}
          aria-label={copy.showAll}
        >
          <Expand className="mr-1.5 h-3.5 w-3.5" />
          {copy.showAll}
        </Button>
        {fullscreen ? (
          <Button type="button" variant="outline" size="sm" onClick={closeFullscreen}>
            <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
            {copy.close}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={openFullscreen}>
            <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
            {copy.enlarge}
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      <Card className="relative overflow-hidden">
        <div className="space-y-3 border-b bg-card p-3">
          {toolbar()}
          <p className="text-xs text-muted-foreground">{copy.description}</p>
        </div>
        <div className="h-[460px] min-h-[360px]">
          {isFullscreen ? (
            <div className="flex h-full items-center justify-center bg-muted/20 text-xs text-muted-foreground">
              <MapPinned className="mr-2 h-4 w-4" />
              {copy.enlarge}
            </div>
          ) : stops.length > 0 ? (
            map
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <MapPinned className="mb-3 h-8 w-8 text-muted-foreground/40" />
              {copy.noSelection}
            </div>
          )}
        </div>
      </Card>

      <Dialog open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogContent className="flex h-[94dvh] w-[96vw] sm:w-[96vw] max-w-[1600px] flex-col gap-3 overflow-hidden p-0 sm:p-0">
          <DialogHeader className="shrink-0 border-b px-5 pb-3 pt-5">
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5">
            {toolbar(true)}
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
              {stops.length > 0 && map}
            </div>
            <div className="shrink-0 rounded-lg border bg-muted/30 p-3">
              {selectedStop ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {copy.selected} {stopMarkerLabels[selectedStop.id] ? `· ${stopMarkerLabels[selectedStop.id]}` : ""}
                    </p>
                    <p className="break-words text-sm font-medium" title={selectedStop.address}>{selectedStop.address}</p>
                  </div>
                  <Button type="button" size="sm" onClick={() => reviewSelectedAddress(selectedStop.id)}>
                    {copy.review}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{copy.noSelection}</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}