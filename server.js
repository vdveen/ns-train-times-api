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
    const url = `${NS_API_BASE}/departures?station=${encodeURIComponent(station)}&maxJourneys=40`;

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

      const dutch = planned.toLocaleTimeString("nl-NL", {
        timeZone: "Europe/Amsterdam",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const [hours, minutes] = dutch.split(":");

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

function shortenCategory(raw) {
  if (!raw) return "Trein";
  const lower = raw.toLowerCase();
  if (lower.includes("intercity direct")) return "ICD";
  if (lower.includes("intercity")) return "IC";
  if (lower.includes("sprinter")) return "SPR";
  if (lower.includes("ice")) return "ICE";
  return raw;
}

function isSprinter(raw) {
  return (raw || "").toLowerCase().includes("sprinter");
}

function describeDeparture(dep) {
  const planned = new Date(dep.plannedDateTime);
  const actual = dep.actualDateTime ? new Date(dep.actualDateTime) : null;
  const delayMs = actual ? actual.getTime() - planned.getTime() : 0;
  const delayMinutes = Math.max(0, Math.round(delayMs / 60000));

  const dutch = planned.toLocaleTimeString("nl-NL", {
    timeZone: "Europe/Amsterdam",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [hours, minutes] = dutch.split(":");
  const plannedTime = `${hours}:${minutes}`;

  const category = shortenCategory(dep.product?.shortCategoryName);
  const direction = dep.direction || "Onbekend";
  const cancelled = dep.cancelled || false;
  const track = dep.actualTrack || dep.plannedTrack || "";

  let message;
  if (cancelled) {
    message = `${category} ${direction} rijdt niet`;
  } else if (delayMinutes >= 1) {
    message = `${category} ${direction} rijdt plus ${delayMinutes}`;
  } else {
    message = `${category} ${direction} rijdt om ${plannedTime}`;
  }

  return {
    category,
    direction,
    planned_time: plannedTime,
    delay_minutes: delayMinutes,
    cancelled,
    track,
    message,
  };
}

app.get("/api/first-intercity", async (req, res) => {
  const station = (req.query.station || STATION).toUpperCase();
  const via = req.query.via ?? "Hilversum";
  const viaFilter = via.toLowerCase();

  if (!NS_API_KEY) {
    return res.status(500).json({ error: "NS_API_KEY not configured" });
  }

  try {
    const url = `${NS_API_BASE}/departures?station=${encodeURIComponent(station)}&maxJourneys=40`;

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

    departures = departures.filter((d) => d.product?.type !== "BUS");
    departures = departures.filter((d) => !isSprinter(d.product?.shortCategoryName));
    if (viaFilter) {
      departures = departures.filter((d) =>
        (d.routeStations || []).some(
          (rs) => (rs.mediumName || "").toLowerCase() === viaFilter
        )
      );
    }

    const first = departures[0];
    if (!first) {
      return res.json({
        message: `Geen intercity via ${via || "..."} gevonden`,
        station,
        via,
        updated_at: new Date().toISOString(),
      });
    }

    const firstTrain = describeDeparture(first);
    const second = departures[1];
    const secondTrain = second ? describeDeparture(second) : null;

    const message = secondTrain
      ? `${firstTrain.message}; ${secondTrain.message}`
      : firstTrain.message;

    res.json({
      category: firstTrain.category,
      direction: firstTrain.direction,
      planned_time: firstTrain.planned_time,
      delay_minutes: firstTrain.delay_minutes,
      cancelled: firstTrain.cancelled,
      track: firstTrain.track,
      message,
      next_train: secondTrain,
      updated_at: new Date().toISOString(),
      station,
      via,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch first intercity", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Train times API running on port ${PORT}`);
});
