import React, { useRef, useEffect } from "react";
import { StyleSheet } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";

interface MapStop {
  id: string;
  latitude: number;
  longitude: number;
  sequence: number | null;
  address: string;
  status: string;
  color: string;
}

interface NativeMapProps {
  stops: MapStop[];
  polylineCoords: { latitude: number; longitude: number }[];
  primaryColor: string;
  bottomPadding: number;
}

export default function NativeMap({ stops, polylineCoords, primaryColor, bottomPadding }: NativeMapProps) {
  const mapRef = useRef<MapView>(null);

  useEffect(() => {
    if (stops.length > 0 && mapRef.current) {
      const coords = stops.map((s) => ({
        latitude: s.latitude,
        longitude: s.longitude,
      }));
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 80, right: 40, bottom: bottomPadding + 80, left: 40 },
        animated: true,
      });
    }
  }, [stops, bottomPadding]);

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
        <Polyline
          coordinates={polylineCoords}
          strokeColor={primaryColor + "80"}
          strokeWidth={3}
        />
      )}
      {stops.map((stop) => (
        <Marker
          key={stop.id}
          coordinate={{ latitude: stop.latitude, longitude: stop.longitude }}
          title={`#${stop.sequence ?? "?"} ${stop.address}`}
          description={stop.status}
          pinColor={stop.color}
        />
      ))}
    </MapView>
  );
}
