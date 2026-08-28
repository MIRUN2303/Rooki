/* ROOKI Map Panel — foundation for location/map capabilities.
   Future: MapLibre integration, search, markers, routes. */

import { useState } from "react";

interface MapPanelProps {
  onClose: () => void;
}

export default function MapPanel({ onClose }: MapPanelProps) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"idle" | "searching" | "error">("idle");

  const handleSearch = () => {
    if (!query.trim()) return;
    setStatus("searching");
    // Future: integrate with map search/geocoding
    setTimeout(() => setStatus("idle"), 500);
  };

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
        />
        <button onClick={handleSearch} disabled={status === "searching"}>
          {status === "searching" ? "..." : "Go"}
        </button>
      </div>

      <div className="map-placeholder">
        <div className="map-placeholder-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
        </div>
        <span className="map-placeholder-text">Map coming soon</span>
        <span className="map-placeholder-hint">
          Search for places, view event locations, get directions
        </span>
      </div>

      <div className="map-footer">
        <span>Map engine: pending</span>
      </div>
    </div>
  );
}
