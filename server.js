const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const NS_API_KEY = process.env.NS_API_KEY;
const STATION = process.env.STATION || "AMF"; // Default: Amersfoort Centraal
const DELAY = process.env.DELAY ? parseInt(process.env.DELAY, 10) : 0;
const DESTINATION_FILTER = process.env.DESTINATION_FILTER
  ? process.env.DESTINATION_FILTER.split(",").map((d) => d.trim().toLowerCase())
  : [];

const NS_API_BASE = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2";

app.get("/", (req, res) => {
  res.json({
    service: "NS Train Times for TRMNL",
    station: STATION,
    endpoint: "/api/train-times",
  });
});

app.get("/api/train-times", async (req, res) => {
  const station = req.query.station || STATION;

  if (!NS_API_KEY) {
    return res.status(500).json({ error: "NS_API_KEY not configured" });
  }

  try {
    const url = `${NS_API_BASE}/departures?station=${encodeURIComponent(station)}&maxJourneys=15`;

    const response = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": NS_API_KEY,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: "NS API request failed",
        status: response.status,
        detail: text,
      });
    }

    const data = await response.json();
    let departures = data.payload?.departures || [];

    if (DELAY > 0) {
      const cutoff = new Date(Date.now() + DELAY * 60000);
      departures = departures.filter(
        (dep) => new Date(dep.plannedDateTime) >= cutoff
      );
    }

    if (DESTINATION_FILTER.length > 0) {
      departures = departures.filter(
        (dep) => !DESTINATION_FILTER.includes((dep.direction || "").toLowerCase())
      );
    }

    const trains = departures.map((dep) => {
      const planned = new Date(dep.plannedDateTime);
      const actual = dep.actualDateTime ? new Date(dep.actualDateTime) : null;

      const delayMs = actual ? actual.getTime() - planned.getTime() : 0;
      const delayMinutes = Math.max(0, Math.round(delayMs / 60000));

      const hours = String(planned.getHours()).padStart(2, "0");
      const minutes = String(planned.getMinutes()).padStart(2, "0");

      return {
        planned_time: `${hours}:${minutes}`,
        direction: dep.direction || "Onbekend",
        delay_minutes: delayMinutes,
        cancelled: dep.cancelled || false,
        track: dep.actualTrack || dep.plannedTrack || "",
        train_type: dep.product?.shortCategoryName || "",
      };
    });

    res.json({
      trains,
      updated_at: new Date().toISOString(),
      station,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch train times", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Train times API running on port ${PORT}`);
});
