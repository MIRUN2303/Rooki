/* ROOKI Map Panel — MapLibre GL integration with location/weather/calendar/memory integration */

import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  getCurrentLocation,
  setLocation,
  formatLocation,
  reverseGeocode,
} from "./location";
import { getWeatherForEvent } from "./weather";
import { upsertMemory, addMemory } from "./memory";
import { createTask } from "./scheduler";
import type { LocationContext } from "./location";

interface MapPanelProps {
  onClose: () => void;
}

export default function MapPanel({ onClose }: MapPanelProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "searching" | "error" | "success">("idle");
  const [selectedLocation, setSelectedLocation] = useState<LocationContext | null>(null);
  const [showLocationCard, setShowLocationCard] = useState(false);
  const [weatherInfo, setWeatherInfo] = useState<{
    temperature: number;
    condition: string;
    rainChance: number;
  } | null>(null);

  const mapStyle = "https://demotiles.maplibre.org/style.json";

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    try {
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: mapStyle,
        center: [80.2707, 13.0827], // Default: Chennai
        zoom: 10,
        pitch: 0,
        bearing: 0,
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(
        new maplibregl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          trackUserLocation: true,
          showUserLocation: true,
        }),
        "top-right"
      );

      map.on("load", () => {
        // Load saved location if exists
        loadSavedLocation(map);
      });

      map.on("click", (e: maplibregl.MapMouseEvent) => {
        handleMapClick(e.lngLat, map);
      });

      mapRef.current = map;
    } catch (err) {
      console.error("Map initialization failed:", err);
      setStatus("error");
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  const loadSavedLocation = useCallback(async (map: maplibregl.Map) => {
    try {
      const loc = await getCurrentLocation();
      if (loc) {
        flyToLocation(map, loc);
        setSelectedLocation(loc);
        setShowLocationCard(true);
        fetchWeatherForLocation(loc);
      }
    } catch (err) {
      console.warn("Failed to load saved location:", err);
    }
  }, []);

  const flyToLocation = (map: maplibregl.Map, loc: LocationContext) => {
    if (!map) return;
    map.flyTo({
      center: [loc.longitude, loc.latitude],
      zoom: 14,
      essential: true,
      duration: 1500,
    });
    updateMarker(loc);
  };

  const updateMarker = (loc: LocationContext) => {
    if (markerRef.current) {
      markerRef.current.remove();
    }
    markerRef.current = new maplibregl.Marker({
      color: "#a78bfa",
      scale: 1.2,
    })
      .setLngLat([loc.longitude, loc.latitude])
      .addTo(mapRef.current!);
  };

  const handleMapClick = async (lngLat: maplibregl.LngLat, map: maplibregl.Map) => {
    setStatus("searching");
    try {
      const reverse = await reverseGeocode(lngLat.lat, lngLat.lng);
      if (!reverse) {
        setStatus("error");
        return;
      }

      const newLocation: LocationContext = {
        name: reverse.name,
        city: reverse.city,
        region: reverse.region,
        country: reverse.country,
        latitude: lngLat.lat,
        longitude: lngLat.lng,
        timezone: reverse.timezone,
        source: "map",
        updatedAt: Date.now(),
      };

      flyToLocation(map, newLocation);
      updateMarker(newLocation);
      setSelectedLocation(newLocation);
      setShowLocationCard(true);
      setStatus("success");

      // Fetch weather for this location
      fetchWeatherForLocation(newLocation);
    } catch (err) {
      console.error("Reverse geocoding failed:", err);
      setStatus("error");
    }
  };

  const fetchWeatherForLocation = async (loc: LocationContext) => {
    try {
      const weather = await import("./weather").then((m) => m.getWeatherForEvent(loc.name));
      if (weather) {
        setWeatherInfo({
          temperature: weather.current.temperature,
          condition: weather.current.condition,
          rainChance: weather.forecast[0]?.rainChance || 0,
        });
      }
    } catch (err) {
      console.warn("Weather fetch failed:", err);
    }
  };

  const handleSearch = async () => {
    if (!query.trim() || !mapRef.current) return;
    setStatus("searching");

    try {
      const { searchLocation } = await import("./location");
      const results = await searchLocation(query);
      if (!results.length) {
        setStatus("error");
        return;
      }

      const first = results[0];
      const newLocation: LocationContext = {
        name: first.name,
        city: first.city,
        region: first.region,
        country: first.country,
        latitude: first.latitude,
        longitude: first.longitude,
        timezone: first.timezone,
        source: "map",
        updatedAt: Date.now(),
      };

      flyToLocation(mapRef.current!, newLocation);
      updateMarker(newLocation);
      setSelectedLocation(newLocation);
      setShowLocationCard(true);
      setStatus("success");
      fetchWeatherForLocation(newLocation);
    } catch (err) {
      console.error("Search failed:", err);
      setStatus("error");
    }
  };

  const handleSaveLocation = async () => {
    if (!selectedLocation) return;
    try {
      await setLocation(selectedLocation);
      // Also save to memory as preference
      await import("./memory").then((m) =>
        m.upsertMemory("pref", `Preferred location is ${selectedLocation.name}.`, {
          memoryType: "permanent",
          category: "location",
          key: "default_location",
          source: "explicit",
          confidence: "0.9",
        })
      );
      setStatus("success");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to save location:", err);
      setStatus("error");
    }
  };

  const handleAddToCalendar = async () => {
    if (!selectedLocation) return;
    try {
      const { createTask } = await import("./scheduler");
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(10, 0, 0, 0);

      await createTask({
        title: `Event at ${selectedLocation.name}`,
        trigger: {
          kind: "once",
          dayOffset: 1,
          hour: 10,
          minute: 0,
        },
        description: `Location: ${selectedLocation.name} (${selectedLocation.latitude.toFixed(4)}, ${selectedLocation.longitude.toFixed(4)})`,
        leadMinutes: 30,
        durationMin: 60,
      });
      setStatus("success");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to add to calendar:", err);
      setStatus("error");
    }
  };

  const handleRememberPlace = async () => {
    if (!selectedLocation) return;
    try {
      await import("./memory").then((m) =>
        m.upsertMemory("fact", `Favorite place: ${selectedLocation.name} (${selectedLocation.latitude.toFixed(4)}, ${selectedLocation.longitude.toFixed(4)})`, {
          memoryType: "permanent",
          category: "location",
          key: `favorite_${selectedLocation.city.toLowerCase().replace(/\s+/g, "_")}`,
          source: "explicit",
          confidence: "0.95",
        })
      );
      setStatus("success");
      setTimeout(() => setStatus("idle"), 2000);
    } catch (err) {
      console.error("Failed to remember place:", err);
      setStatus("error");
    }
  };

  const handleGetDirections = () => {
    if (!selectedLocation) return;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${selectedLocation.latitude},${selectedLocation.longitude}`;
    window.open(url, "_blank");
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (markerRef.current) markerRef.current.remove();
      if (popupRef.current) popupRef.current.remove();
    };
  }, []);

  return (
    <div className="map-panel">
      <div className="map-header">
        <span className="map-title">ROOKI Map</span>
        <button className="map-close" onClick={onClose} aria-label="close map">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="map-search">
        <input
          type="text"
          placeholder="Search location..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          disabled={status === "searching"}
        />
        <button onClick={handleSearch} disabled={status === "searching" || !query.trim()}>
          {status === "searching" ? "..." : "Go"}
        </button>
        {status === "error" && <span className="map-error">Location not found</span>}
        {status === "success" && <span className="map-success">Found!</span>}
      </div>

      <div className="map-container" ref={mapContainerRef} />

      {showLocationCard && selectedLocation && (
        <div className="map-location-card">
          <div className="location-card-header">
            <div className="location-info">
              <span className="location-name">{selectedLocation.name}</span>
              <span className="location-coords">
                {selectedLocation.latitude.toFixed(4)}, {selectedLocation.longitude.toFixed(4)}
              </span>
            </div>
            <button
              className="location-card-close"
              onClick={() => {
                setShowLocationCard(false);
                setSelectedLocation(null);
                if (markerRef.current) markerRef.current.remove();
              }}
              aria-label="close location card"
            >
              ×
            </button>
          </div>

          {weatherInfo && (
            <div className="location-weather">
              <span className="weather-temp">{weatherInfo.temperature}°C</span>
              <span className="weather-condition">{weatherInfo.condition}</span>
              <span className="weather-rain">🌧 {weatherInfo.rainChance}% rain</span>
            </div>
          )}

          <div className="location-actions">
            <button className="action-btn primary" onClick={handleSaveLocation} title="Save as default location">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              <span>Save Location</span>
            </button>
            <button className="action-btn" onClick={handleAddToCalendar} title="Add to calendar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <span>Add to Calendar</span>
            </button>
            <button className="action-btn" onClick={handleRememberPlace} title="Remember this place">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                <path d="M9 3v4" />
                <path d="M15 3v4" />
              </svg>
              <span>Remember</span>
            </button>
            <button className="action-btn" onClick={handleGetDirections} title="Get directions">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="3 11 22 2 13 21 13 11 3 11" />
              </svg>
              <span>Directions</span>
            </button>
          </div>
        </div>
      )}

      <div className="map-footer">
        <span>MapLibre GL • Click map to select location</span>
      </div>
    </div>
  );
}