import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  getCurrentLocation,
  setLocation,
  reverseGeocode,
  searchLocation,
} from "./location";
import { upsertMemory } from "./memory";
import { createTask } from "./scheduler";
import { webImageSearch, researchTopic } from "./research";
import type { ImageRef, ResearchMode } from "./research";

interface PlaceHit {
  name: string;
  city: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface MapPanelProps {
  onClose: () => void;
}

const MAP_STYLE = {
  version: 8 as const,
  sources: {
    carto: {
      type: "raster" as const,
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors © CARTO",
    },
  },
  layers: [
    { id: "bg", type: "background" as const, paint: { "background-color": "#0b0e1a" } },
    { id: "carto", type: "raster" as const, source: "carto" },
  ],
};

export default function MapPanel({ onClose }: MapPanelProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const originMarkerRef = useRef<maplibregl.Marker | null>(null);
  const readyRef = useRef(false);

  const [tab, setTab] = useState<"map" | "images" | "info">("map");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "searching" | "error" | "success">("idle");
  const [places, setPlaces] = useState<PlaceHit[]>([]);
  const [selected, setSelected] = useState<PlaceHit | null>(null);
  const [origin, setOrigin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [images, setImages] = useState<ImageRef[]>([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [info, setInfo] = useState<{ answer: string; sources: { name: string; url?: string }[] } | null>(null);
  const [infoLoading, setInfoLoading] = useState(false);

  const clearMarkers = useCallback(() => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (originMarkerRef.current) {
      originMarkerRef.current.remove();
      originMarkerRef.current = null;
    }
    const map = mapRef.current;
    if (map?.getSource("rooki-route")) {
      (map.getSource("rooki-route") as maplibregl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [],
      });
    }
  }, []);

  const drawRoute = useCallback((from: { latitude: number; longitude: number }, to: PlaceHit) => {
    const map = mapRef.current;
    if (!map) return;
    const data = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [from.longitude, from.latitude],
              [to.longitude, to.latitude],
            ],
          },
        },
      ],
    };
    const src = map.getSource("rooki-route") as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data as GeoJSON.GeoJSON);
  }, []);

  const showPlaces = useCallback(
    (hits: PlaceHit[], org: { latitude: number; longitude: number } | null, focusQuery: string) => {
      const map = mapRef.current;
      if (!map || !hits.length) return;
      clearMarkers();
      setPlaces(hits);
      const primary = hits[0];
      setSelected(primary);
      setStatus("success");

      hits.forEach((p, i) => {
        const el = document.createElement("div");
        el.className = `rooki-marker${i === 0 ? " primary" : ""}`;
        const mk = new maplibregl.Marker({ element: el })
          .setLngLat([p.longitude, p.latitude])
          .addTo(map);
        const short = p.city && p.name.startsWith(p.city) ? p.region || p.country : [p.city, p.country].filter(Boolean).join(", ");
        mk.setPopup(
          new maplibregl.Popup({ offset: 18, maxWidth: "260px", className: "rooki-popup" }).setHTML(
            `<div class="rp-title">${p.name.split(",")[0]}</div>
             <div class="rp-sub">${short}</div>
             <div class="rp-coords">${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}</div>`
          )
        );
        markersRef.current.push(mk);
      });
      markersRef.current[0]?.togglePopup();

      if (org) {
        setOrigin(org);
        const oel = document.createElement("div");
        oel.className = "rooki-marker origin";
        originMarkerRef.current = new maplibregl.Marker({ element: oel })
          .setLngLat([org.longitude, org.latitude])
          .addTo(map);
        drawRoute(org, primary);
      }

      if (hits.length === 1) {
        map.flyTo({ center: [primary.longitude, primary.latitude], zoom: 13, duration: 1500, essential: true });
      } else {
        const b = new maplibregl.LngLatBounds();
        hits.forEach((p) => b.extend([p.longitude, p.latitude]));
        if (org) b.extend([org.longitude, org.latitude]);
        map.fitBounds(b, { padding: 70, duration: 1200 });
      }

      setImages([]);
      setImagesLoading(true);
      webImageSearch(focusQuery || primary.name)
        .then(setImages)
        .catch(() => setImages([]))
        .finally(() => setImagesLoading(false));
      setInfo(null);
    },
    [clearMarkers, drawRoute]
  );

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [80.2707, 13.0827],
      zoom: 10,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => {
      map.addSource("rooki-route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "rooki-route-line",
        type: "line",
        source: "rooki-route",
        paint: { "line-color": "#a78bfa", "line-width": 3, "line-dasharray": [2, 2], "line-opacity": 0.9 },
      });
      readyRef.current = true;
      getCurrentLocation()
        .then((loc) => {
          if (loc && loc.latitude && mapRef.current) {
            mapRef.current.flyTo({ center: [loc.longitude, loc.latitude], zoom: 12, duration: 1200 });
          }
        })
        .catch(() => {});
    });
    map.on("click", async (e) => {
      setStatus("searching");
      const rev = await reverseGeocode(e.lngLat.lat, e.lngLat.lng);
      if (!rev) {
        setStatus("error");
        return;
      }
      showPlaces(
        [{ name: rev.name, city: rev.city, region: rev.region, country: rev.country, latitude: e.lngLat.lat, longitude: e.lngLat.lng }],
        origin,
        rev.city || rev.name
      );
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  useEffect(() => {
    const onLocate = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        query: string;
        results: PlaceHit[];
        origin: { latitude: number; longitude: number } | null;
      };
      setQuery(detail.query);
      const tryShow = () => {
        if (readyRef.current) showPlaces(detail.results, detail.origin, detail.query);
        else setTimeout(tryShow, 250);
      };
      tryShow();
    };
    window.addEventListener("rooki-map-locate", onLocate);
    return () => window.removeEventListener("rooki-map-locate", onLocate);
  }, [showPlaces]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tab === "map") map.resize();
  }, [tab]);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setStatus("searching");
    const res = await searchLocation(q).catch(() => []);
    if (!res.length) {
      setStatus("error");
      return;
    }
    let org = origin;
    if (!org) {
      try {
        const pos = await (await import("./location")).getDeviceLocation();
        org = { latitude: pos.latitude, longitude: pos.longitude };
      } catch {}
    }
    showPlaces(
      res.slice(0, 5).map((r) => ({
        name: r.name, city: r.city, region: r.region, country: r.country,
        latitude: r.latitude, longitude: r.longitude,
      })),
      org,
      q
    );
  };

  const handleSelect = (p: PlaceHit) => {
    setSelected(p);
    const map = mapRef.current;
    if (map) {
      map.flyTo({ center: [p.longitude, p.latitude], zoom: 13, duration: 1100, essential: true });
      const mk = markersRef.current.find((m) => {
        const ll = m.getLngLat();
        return Math.abs(ll.lat - p.latitude) < 1e-6 && Math.abs(ll.lng - p.longitude) < 1e-6;
      });
      mk?.togglePopup();
    }
    if (origin) drawRoute(origin, p);
  };

  const handleInfo = async () => {
    if (!selected || info || infoLoading) return;
    setInfoLoading(true);
    const res = await researchTopic({
      text: `${selected.name.split(",")[0]} recent news history`,
      lang: "en",
      settings: JSON.parse(localStorage.getItem("rooki.settings.v1") || "{}"),
      followUp: false,
      mode: "news" as ResearchMode,
      isCurrent: () => true,
      onLog: () => {},
    }).catch(() => null);
    if (res) {
      setInfo({
        answer: typeof res.answer === "string" ? res.answer : res.answer.en,
        sources: res.sources.map((s) => ({ name: s.name, url: s.url })),
      });
    }
    setInfoLoading(false);
  };

  const handleSave = async () => {
    if (!selected) return;
    await setLocation({
      name: selected.name, city: selected.city, region: selected.region, country: selected.country,
      latitude: selected.latitude, longitude: selected.longitude,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, source: "map",
    });
    upsertMemory("pref", `Preferred location is ${selected.name}.`, {
      memoryType: "permanent", category: "location", key: "default_location",
      source: "explicit", confidence: "0.9",
    });
    setStatus("success");
  };

  const handleCalendar = async () => {
    if (!selected) return;
    await createTask({
      title: `Event at ${selected.name.split(",")[0]}`,
      trigger: { kind: "once", dayOffset: 1, hour: 10, minute: 0 },
      description: `Location: ${selected.name} (${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)})`,
      leadMinutes: 30,
      durationMin: 60,
    });
    setStatus("success");
  };

  const handleRemember = async () => {
    if (!selected) return;
    upsertMemory("fact", `Favorite place: ${selected.name} (${selected.latitude.toFixed(4)}, ${selected.longitude.toFixed(4)})`, {
      memoryType: "permanent", category: "location",
      key: `favorite_${(selected.city || selected.name).toLowerCase().replace(/\s+/g, "_").slice(0, 40)}`,
      source: "explicit", confidence: "0.95",
    });
    setStatus("success");
  };

  const handleDirections = () => {
    if (!selected) return;
    const dest = `${selected.latitude},${selected.longitude}`;
    const src = origin ? `${origin.latitude},${origin.longitude}` : "Current+Location";
    window.open(`https://www.google.com/maps/dir/?api=1&origin=${src}&destination=${dest}`, "_blank");
  };

  return (
    <div className="map-panel">
      <div className="map-header">
        <span className="map-title">ROOKI Map</span>
        <div className="map-tabs" role="tablist">
          {(["map", "images", "info"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`map-tab${tab === t ? " active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "map" ? "Map" : t === "images" ? "Images" : "Info"}
            </button>
          ))}
        </div>
        <button className="map-close" onClick={onClose} aria-label="close map">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className={`map-body${tab === "map" ? "" : " offscreen"}`}>
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
        </div>

        <div className="map-container" ref={mapContainerRef} />

        {places.length > 1 && (
          <div className="map-suggest">
            <span className="map-suggest-label">Did you mean</span>
            {places.map((p, i) => (
              <button
                key={i}
                className={`map-suggest-chip${selected === p ? " active" : ""}`}
                onClick={() => handleSelect(p)}
              >
                {p.name.split(",")[0]}
                {p.country ? <em>{p.country}</em> : null}
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="map-location-card">
            <div className="location-card-header">
              <div className="location-info">
                <span className="location-name">{selected.name.split(",")[0]}</span>
                <span className="location-coords">
                  {selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}
                </span>
              </div>
              <button
                className="location-card-close"
                onClick={() => {
                  setSelected(null);
                  setPlaces([]);
                  clearMarkers();
                }}
                aria-label="clear selection"
              >
                ×
              </button>
            </div>
            <div className="location-actions">
              <button className="action-btn primary" onClick={handleSave} title="Save as default location">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                <span>Save</span>
              </button>
              <button className="action-btn" onClick={handleCalendar} title="Add to calendar">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
                <span>Calendar</span>
              </button>
              <button className="action-btn" onClick={handleRemember} title="Remember this place">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 21C7 17 3 13.5 3 9.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 3.5c0 4-4 7.5-9 11.5z" />
                </svg>
                <span>Remember</span>
              </button>
              <button className="action-btn" onClick={handleDirections} title="Get directions">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="3 11 22 2 13 21 13 11 3 11" />
                </svg>
                <span>Directions</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {tab === "images" && (
        <div className="map-images">
          {imagesLoading && <div className="map-images-empty">Loading images…</div>}
          {!imagesLoading && !images.length && (
            <div className="map-images-empty">No images yet — locate a place first.</div>
          )}
          {images.map((img, i) => (
            <a key={i} className="map-image" href={img.url} target="_blank" rel="noreferrer" title={img.title}>
              <img src={img.thumb} alt={img.title} loading="lazy" />
              <span>{img.title}</span>
            </a>
          ))}
        </div>
      )}

      {tab === "info" && (
        <div className="map-info">
          {!selected && <div className="map-images-empty">Locate a place to see its story.</div>}
          {selected && !info && !infoLoading && (
            <button className="action-btn primary map-info-load" onClick={handleInfo}>
              Load news &amp; history for {selected.name.split(",")[0]}
            </button>
          )}
          {infoLoading && <div className="map-images-empty">Researching…</div>}
          {info && (
            <>
              <div className="map-info-answer">{info.answer}</div>
              <div className="map-info-sources">
                {info.sources.slice(0, 6).map((s, i) => (
                  <a key={i} className="map-info-source" href={s.url} target="_blank" rel="noreferrer">
                    {s.name}
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="map-footer">
        <span>Click map to select · voice: "locate …" / "where is …"</span>
      </div>
    </div>
  );
}
