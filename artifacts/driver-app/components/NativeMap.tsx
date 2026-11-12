import React, { useRef, useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import type { NativeMapProps } from "./map-types";

export default function NativeMap({
  stops,
  polylineCoords,
  primaryColor,
  outlineColor,
  routeSource,
  bottomPadding,
  nextStopId,
  selectedStopId,
  onSelectStop,
  viewportCommand,
}: NativeMapProps) {
  const mapRef = useRef<MapView>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !viewportCommand) return;
    if (viewportCommand.type === "fit") {
      if (stops.length) map.fitToCoordinates(stops, { edgePadding: { top: 40, right: 50, bottom: 40, left: 40 }, animated: true });
    } else {
      const direction = viewportCommand.type === "in" ? 1 : -1;
      void map.getCamera().then(camera => {
        if (mapRef.current !== map) return;
        map.animateCamera({ ...camera,
          ...(camera.zoom != null ? { zoom: Math.max(1, Math.min(20, camera.zoom + direction)) } : {}),
          ...(camera.altitude != null ? { altitude: Math.max(50, camera.altitude * (direction === 1 ? .5 : 2)) } : {}),
        });
      }).catch(() => {});
    }
  }, [viewportCommand]);

  useEffect(() => {
    const coords = polylineCoords.length > 1
      ? polylineCoords
      : stops.map((s) => ({
        latitude: s.latitude,
        longitude: s.longitude,
      }));
    if (coords.length > 0 && mapRef.current) {
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 80, right: 40, bottom: bottomPadding + 80, left: 40 },
        animated: true,
      });
    }
  }, [stops, polylineCoords, bottomPadding]);

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_DEFAULT}
      initialRegion={{
        latitude: 59.33,
        longitude: 18.07,
        latitudeDelta: 0.12,
        longitudeDelta: 0.12,
      }}
      showsUserLocation
      showsMyLocationButton={false}
    >
      {polylineCoords.length > 1 && (
        <>
          <Polyline
            coordinates={polylineCoords}
            strokeColor={outlineColor}
            strokeWidth={8}
            lineCap="round"
            lineJoin="round"
          />
          <Polyline
            coordinates={polylineCoords}
            strokeColor={primaryColor}
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
            lineDashPattern={routeSource === "fallback" ? [10, 7] : undefined}
          />
        </>
      )}
      {stops.map((stop) => (
        <Marker
          key={stop.id}
          coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
          title={`#${stop.sequence ?? "?"} ${stop.address}`}
          description={stop.status}
          onPress={() => onSelectStop?.(stop.id)}
          tracksViewChanges
        >
          <View style={[styles.stopMarker, {
            backgroundColor: stop.color,
            borderColor: stop.id === selectedStopId ? primaryColor : outlineColor,
            borderWidth: stop.id === selectedStopId ? 4 : 2,
            width: stop.id === nextStopId ? 40 : 32,
            height: stop.id === nextStopId ? 40 : 32,
            borderRadius: 20,
          }]}>
            <Text style={styles.stopMarkerText}>{stop.sequence ?? "?"}</Text>
          </View>
        </Marker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  stopMarker: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.28,
    shadowRadius: 4,
    elevation: 4,
  },
  stopMarkerText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "700",
  },
});
