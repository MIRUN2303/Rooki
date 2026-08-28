/* ROOKI Daily Briefing — first login of day experience */

import { useState, useEffect } from "react";

export interface BriefingData {
  greeting: string;
  period: string;
  weather: WeatherData | null;
  schedule: ScheduleSummary | null;
  systemStatus: SystemStatusItem[];
  horoscope: string | null;
}

export interface WeatherData {
  temp: number;
  condition: string;
  rain: number;
  location: string;
  high: number;
  low: number;
}

export interface ScheduleSummary {
  total: number;
  important: { title: string; time: string }[];
}

export interface SystemStatusItem {
  name: string;
  status: "live" | "offline" | "degraded";
}

const BRIEFING_DATE_KEY = "rooki.briefingDate";

export function getLocalDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isFirstLoginToday(): boolean {
  const last = localStorage.getItem(BRIEFING_DATE_KEY);
  const today = getLocalDateString();
  return last !== today;
}

export function markBriefingShown(): void {
  localStorage.setItem(BRIEFING_DATE_KEY, getLocalDateString());
}

export function getTimeGreeting(): { text: string; period: string } {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return { text: "Good morning", period: "MORNING" };
  if (h >= 12 && h < 17) return { text: "Good afternoon", period: "AFTERNOON" };
  if (h >= 17 && h < 21) return { text: "Good evening", period: "EVENING" };
  return { text: "Working late", period: "NIGHT" };
}

interface DailyBriefingProps {
  data: BriefingData;
  onDismiss: () => void;
}

export default function DailyBriefing({ data, onDismiss }: DailyBriefingProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div className={`daily-briefing${visible ? " visible" : ""}`}>
      <div className="briefing-card">
        <header className="briefing-head">
          <span className="briefing-greeting">{data.greeting}</span>
          <span className="briefing-period">{data.period}</span>
        </header>

        {data.weather && (
          <div className="briefing-weather">
            <span className="weather-loc">{data.weather.location}</span>
            <span className="weather-temp">{data.weather.temp}°C</span>
            <span className="weather-cond">{data.weather.condition}</span>
            {data.weather.rain > 0 && (
              <span className="weather-rain">Rain {data.weather.rain}%</span>
            )}
          </div>
        )}

        {data.schedule && data.schedule.total > 0 && (
          <div className="briefing-schedule">
            <span className="schedule-count">
              {data.schedule.total} {data.schedule.total === 1 ? "event" : "events"} today
            </span>
            {data.schedule.important.slice(0, 2).map((evt, i) => (
              <span key={i} className="schedule-item">
                {evt.time} · {evt.title}
              </span>
            ))}
          </div>
        )}

        {data.systemStatus.length > 0 && (
          <div className="briefing-status">
            {data.systemStatus.map((s, i) => (
              <span key={i} className={`status-pill ${s.status}`}>
                <i className="status-dot" />
                {s.name}
              </span>
            ))}
          </div>
        )}

        {data.horoscope && (
          <p className="briefing-horoscope">{data.horoscope}</p>
        )}

        <button className="briefing-dismiss" onClick={onDismiss}>
          Continue
        </button>
      </div>
    </div>
  );
}
