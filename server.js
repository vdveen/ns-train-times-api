const express = require("express");
const { spawn } = require("node:child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const NS_API_KEY = process.env.NS_API_KEY;
const STATION = process.env.STATION || "AMF"; // Default: Amersfoort Centraal
const DELAY = process.env.DELAY ? parseInt(process.env.DELAY, 10) : 0;
const DESTINATION_FILTER = process.env.DESTINATION_FILTER
  ? process.env.DESTINATION_FILTER.split(",").map((d) => d.trim().toLowerCase())
  : [];

const NS_API_BASE = "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2";

// The return trip kicks in from 13:00 Amsterdam time onwards.
const RETURN_TRIP_HOUR = 13;

function amsterdamHour(now = new Date()) {
  const dutch = now.toLocaleTimeString("en-GB", {
    timeZone: "Europe/Amsterdam",
    hour12: false,
  });
  return parseInt(dutch.split(":")[0], 10) % 24;
}

function isReturnTripTime(now = new Date()) {
  return amsterdamHour(now) >= RETURN_TRIP_HOUR;
}

async function fetchDepartures(station) {
  const url = `${NS_API_BASE}/departures?station=${encodeURIComponent(station)}&maxJourneys=40`;

  const response = await fetch(url, {
    headers: {
      "Cache-Control": "no-cache",
      "Ocp-Apim-Subscription-Key": NS_API_KEY,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`NS API request failed (${response.status})`);
    err.status = response.status;
    err.detail = text;
    throw err;
  }

  const data = await response.json();
  return data.payload?.departures || [];
}

// Result of the most recent unit-test run, surfaced in the output message so a
// broken deploy is visible on the display.
const state = { testFailures: 0 };

function withTestStatus(message) {
  const n = state.testFailures;
  if (n <= 0) return message;
  return `${message}\n${n} test${n === 1 ? "" : "s"} failed`;
}

// Run the test suite in a child process and remember how many tests failed.
function runTests() {
  const child = spawn(process.execPath, ["--test"], { cwd: __dirname });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("close", () => {
    const match = output.match(/^# fail (\d+)/m);
    state.testFailures = match ? parseInt(match[1], 10) : 0;
    if (state.testFailures > 0) {
      console.warn(`${state.testFailures} unit test(s) failed`);
    }
  });
  child.on("error", (err) => {
    console.warn("Could not run unit tests:", err.message);
  });
}

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

// Display abbreviations for destinations, using NS's own station codes so long
// names ("Amersfoort Schothorst") shrink to something scannable ("Amfs").
// Source: the official NS station-code list. Unknown destinations (e.g. foreign
// stations like "Hannover Hbf") are left untouched.
const STATION_CODES = {
  "amsterdam centraal": "Asd",
  "amsterdam zuid": "Asdz",
  "amsterdam sloterdijk": "Ass",
  "amsterdam amstel": "Asa",
  "haarlem": "Hlm",
  "amersfoort centraal": "Amf",
  "amersfoort schothorst": "Amfs",
  "amersfoort vathorst": "Avat",
  "deventer": "Dv",
  "enschede": "Es",
  "hengelo": "Hgl",
  "apeldoorn": "Apd",
  "hilversum": "Hvs",
  "zwolle": "Zl",
  "groningen": "Gn",
  "leeuwarden": "Lw",
  "lelystad centrum": "Lls",
  "almere centrum": "Alm",
  "schiphol airport": "Shl",
  "utrecht centraal": "Ut",
  "den haag centraal": "Gvc",
  "rotterdam centraal": "Rtd",
  "eindhoven centraal": "Ehv",
  "zandvoort aan zee": "Zvt",
};

function abbreviateStation(name) {
  if (!name) return name;
  return STATION_CODES[name.toLowerCase()] || name;
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

  // Display form leads with the time and uses the short station code for the
  // destination: "18:03 IC Dv", "17:50 +2 ICD Amfs", "18:03 ✕ IC Dv".
  const dest = `${category} ${abbreviateStation(direction)}`;
  let message;
  if (cancelled) {
    message = `${plannedTime} ✕ ${dest}`;
  } else if (delayMinutes >= 1) {
    message = `${plannedTime} +${delayMinutes} ${dest}`;
  } else {
    message = `${plannedTime} ${dest}`;
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

// Compact form for a single departure, e.g. "12:31 +3", "12:40" or "12:31 ✕".
function abbreviateDeparture(dep) {
  const { planned_time, delay_minutes, cancelled } = describeDeparture(dep);
  if (cancelled) return `${planned_time} ✕`;
  if (delay_minutes >= 1) return `${planned_time} +${delay_minutes}`;
  return planned_time;
}

// Does this departure travel via the given station? Matches on the route
// ("via") stations by exact name, the same way the morning Hilversum filter does.
function viaMatches(dep, viaFilter) {
  return (dep.routeStations || []).some(
    (rs) => (rs.mediumName || "").toLowerCase() === viaFilter
  );
}

// Haarlem: next N departures whose destination is Amsterdam.
function selectHaarlem(departures, count = 3) {
  return departures
    .filter((d) => d.product?.type !== "BUS")
    .filter((d) => (d.direction || "").toLowerCase().includes("amsterdam"))
    .slice(0, count);
}

// Next N intercity departures travelling via a given station.
function selectIntercityVia(departures, via, count = 2) {
  const viaFilter = via.toLowerCase();
  return departures
    .filter((d) => d.product?.type !== "BUS")
    .filter((d) => !isSprinter(d.product?.shortCategoryName))
    .filter((d) => viaMatches(d, viaFilter))
    .slice(0, count);
}

// Haarlem line, compact ("Haarlem: 17:47, 17:54, 18:00").
function haarlemToAmsterdam(departures, count = 3) {
  const trains = selectHaarlem(departures, count).map(abbreviateDeparture);
  return `Haarlem: ${trains.length ? trains.join(", ") : "geen treinen"}`;
}

// Intercity line in full message form ("Centraal: 18:03 IC Dv, 18:20 +2 IC Es").
function intercityVia(departures, via, label, count = 2) {
  const trains = selectIntercityVia(departures, via, count).map(
    (d) => describeDeparture(d).message
  );
  return `${label}: ${trains.length ? trains.join(", ") : `geen IC via ${via}`}`;
}

// Worst-case status across the displayed departures, shown as a headline so the
// overall situation is graspable at a glance. A cancellation counts as the most
// severe. Thresholds: on time -> green, 1-4 min -> yellow, >=5 min (or any
// cancellation) -> red.
function statusHeadline(deps) {
  let worst = 0;
  let cancelled = false;
  for (const d of deps) {
    const info = describeDeparture(d);
    if (info.cancelled) cancelled = true;
    else worst = Math.max(worst, info.delay_minutes);
  }
  if (cancelled || worst >= 5) return "🔴 Grote vertraging";
  if (worst >= 1) return "🟡 Kleine vertraging";
  return "🟢 Op tijd";
}

// After 13:00: combined return-trip overview for Haarlem, Amsterdam Centraal
// and Amsterdam Zuid. Pure builder so it can be unit-tested.
function buildReturnMessage(haarlem, asd, asdz) {
  // The headline reflects only the departures actually shown, so reuse the same
  // selection the lines below use.
  const headline = statusHeadline([
    ...selectHaarlem(haarlem),
    ...selectIntercityVia(asd, "Amersfoort C."),
    ...selectIntercityVia(asdz, "Amersfoort C."),
  ]);

  const haarlemMsg = haarlemToAmsterdam(haarlem);
  const centraalMsg = intercityVia(asd, "Amersfoort C.", "Centraal");
  const zuidMsg = intercityVia(asdz, "Amersfoort C.", "Zuid");

  return {
    message: [headline, haarlemMsg, centraalMsg, zuidMsg].join("\n"),
    headline,
    sections: { haarlem: haarlemMsg, centraal: centraalMsg, zuid: zuidMsg },
  };
}

async function handleReturnTrip(res) {
  const [haarlem, asd, asdz] = await Promise.all([
    fetchDepartures("HLM"),
    fetchDepartures("ASD"),
    fetchDepartures("ASDZ"),
  ]);

  const { message, sections } = buildReturnMessage(haarlem, asd, asdz);

  res.json({
    mode: "return",
    message: withTestStatus(message),
    sections,
    updated_at: new Date().toISOString(),
  });
}

app.get("/api/first-intercity", async (req, res) => {
  const station = (req.query.station || STATION).toUpperCase();
  const via = req.query.via ?? "Hilversum";
  const viaFilter = via.toLowerCase();

  if (!NS_API_KEY) {
    return res.status(500).json({ error: "NS_API_KEY not configured" });
  }

  try {
    // From 13:00 Amsterdam time, switch to the combined return-trip overview.
    if (isReturnTripTime()) {
      return await handleReturnTrip(res);
    }

    let departures = await fetchDepartures(station);

    departures = departures.filter((d) => d.product?.type !== "BUS");
    departures = departures.filter((d) => !isSprinter(d.product?.shortCategoryName));
    if (viaFilter) {
      departures = departures.filter((d) => viaMatches(d, viaFilter));
    }

    const first = departures[0];
    if (!first) {
      return res.json({
        message: withTestStatus(`Geen intercity via ${via || "..."} gevonden`),
        station,
        via,
        updated_at: new Date().toISOString(),
      });
    }

    const firstTrain = describeDeparture(first);
    const second = departures[1];
    const secondTrain = second ? describeDeparture(second) : null;

    // Same colour-dotted headline as the return overview, so the morning
    // glance also leads with the overall delay status.
    const shown = second ? [first, second] : [first];
    const headline = statusHeadline(shown);
    const lines = secondTrain
      ? `${firstTrain.message}, ${secondTrain.message}`
      : firstTrain.message;
    const message = withTestStatus(`${headline}\n${lines}`);

    res.json({
      category: firstTrain.category,
      direction: firstTrain.direction,
      planned_time: firstTrain.planned_time,
      delay_minutes: firstTrain.delay_minutes,
      cancelled: firstTrain.cancelled,
      track: firstTrain.track,
      headline,
      message,
      next_train: secondTrain,
      updated_at: new Date().toISOString(),
      station,
      via,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        error: "NS API request failed",
        status: err.status,
        detail: err.detail,
      });
    }
    res.status(500).json({ error: "Failed to fetch first intercity", detail: err.message });
  }
});

if (require.main === module) {
  runTests();
  app.listen(PORT, () => {
    console.log(`Train times API running on port ${PORT}`);
  });
}

module.exports = {
  amsterdamHour,
  isReturnTripTime,
  abbreviateDeparture,
  abbreviateStation,
  haarlemToAmsterdam,
  intercityVia,
  statusHeadline,
  buildReturnMessage,
  describeDeparture,
  shortenCategory,
  withTestStatus,
  state,
};
