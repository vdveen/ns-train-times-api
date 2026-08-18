const express = require("express");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// Shared secret that gates the /api routes. Set this in Railway's Variables to
// keep random crawlers/bots off the endpoint. If unset, the API stays open so a
// fresh deploy keeps working until the token is configured.
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

const NS_API_KEY = process.env.NS_API_KEY;
const STATION = process.env.STATION || "AMF"; // Default: Amersfoort Centraal
const DELAY = process.env.DELAY ? parseInt(process.env.DELAY, 10) : 0;
const DESTINATION_FILTER = process.env.DESTINATION_FILTER
  ? process.env.DESTINATION_FILTER.split(",").map((d) => d.trim().toLowerCase())
  : [];

const NS_API_BASE =
  process.env.NS_API_BASE ||
  "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2";
const NS_DEPARTURES_URL =
  process.env.NS_DEPARTURES_URL ||
  `${NS_API_BASE.replace(/\/$/, "")}/departures`;

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

function buildDeparturesUrl(station, maxJourneys = 40) {
  const url = new URL(NS_DEPARTURES_URL);
  url.searchParams.set("station", station);
  if (maxJourneys) {
    url.searchParams.set("maxJourneys", String(maxJourneys));
  }
  return url;
}

function nsApiHeaders() {
  const headers = { "Cache-Control": "no-cache" };
  if (NS_API_KEY) {
    headers["Ocp-Apim-Subscription-Key"] = NS_API_KEY;
  }
  return headers;
}

function extractDepartures(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.payload?.departures)) return data.payload.departures;
  if (Array.isArray(data?.departures)) return data.departures;
  if (Array.isArray(data?.payload)) return data.payload;
  return [];
}

async function fetchDepartures(station, options = {}) {
  const url = buildDeparturesUrl(station, options.maxJourneys ?? 40);

  const response = await fetch(url, { headers: nsApiHeaders() });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`NS API request failed (${response.status})`);
    err.status = response.status;
    err.detail = text;
    throw err;
  }

  const data = await response.json();
  return extractDepartures(data);
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

// Constant-time string compare so the token check doesn't leak length/contents
// via timing. Returns false on any mismatch, including differing lengths.
function tokenMatches(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Pull the token from (in order) a Bearer Authorization header, an
// X-Access-Token header, or a `token` query param. The query param keeps the
// iOS Shortcut zero-config (just append ?token=...); the headers are tidier.
function extractToken(req) {
  const auth = req.get("authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return req.get("x-access-token") || req.query.token || "";
}

function requireToken(req, res, next) {
  // Barrier disabled until a token is configured, so deploys don't break.
  if (!ACCESS_TOKEN) return next();
  if (tokenMatches(extractToken(req), ACCESS_TOKEN)) return next();
  res.set("WWW-Authenticate", "Bearer");
  return res.status(401).json({ error: "Unauthorized" });
}

app.get("/", (req, res) => {
  res.json({
    service: "NS Train Times for TRMNL",
    station: STATION,
    endpoint: "/api/train-times",
  });
});

// Everything under /api requires the shared secret (when one is configured).
app.use("/api", requireToken);

app.get("/api/train-times", async (req, res) => {
  const station = req.query.station || STATION;

  if (!NS_API_KEY) {
    return res.status(500).json({ error: "NS_API_KEY not configured" });
  }

  try {
    let departures = await fetchDepartures(station, { maxJourneys: 40 });

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
    if (err.status) {
      return res.status(err.status).json({
        error: "NS API request failed",
        status: err.status,
        detail: err.detail,
      });
    }
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

// Normalise a station name so the abbreviated route form ("Amersfoort C.") and
// the full destination form ("Amersfoort Centraal") compare equal. Route stops
// expose the short "C." form while a terminating train's `direction` spells out
// "Centraal", so we fold one into the other before comparing.
function normalizeStation(name) {
  return (name || "")
    .toLowerCase()
    .replace(/\bcentraal\b/, "c.")
    .trim();
}

// Does this departure travel via the given station? Matches on the route
// ("via") stations by name, the same way the morning Hilversum filter does.
function viaMatches(dep, viaFilter) {
  const target = normalizeStation(viaFilter);
  return (dep.routeStations || []).some(
    (rs) => normalizeStation(rs.mediumName) === target
  );
}

// Does this departure terminate at the given station? On the return leg an
// intercity may *end* at Amersfoort Centraal instead of calling at it en route
// (see the 21:00 "Amersfoort Centraal" departure on the board). Such a train
// lists Amersfoort as its destination ("direction") with no matching route
// stop, so viaMatches alone would skip it.
function terminatesAt(dep, station) {
  return normalizeStation(dep.direction) === normalizeStation(station);
}

// Haarlem: next N departures whose destination is Amsterdam.
function selectHaarlem(departures, count = 3) {
  return departures
    .filter((d) => d.product?.type !== "BUS")
    .filter((d) => (d.direction || "").toLowerCase().includes("amsterdam"))
    .slice(0, count);
}

// Next N intercity departures that reach a given station, whether they call at
// it en route (viaMatches) or terminate there (terminatesAt). The latter covers
// return-trip trains that end at Amersfoort Centraal rather than passing through.
function selectIntercityVia(departures, via, count = 2) {
  return departures
    .filter((d) => d.product?.type !== "BUS")
    .filter((d) => !isSprinter(d.product?.shortCategoryName))
    .filter((d) => viaMatches(d, via) || terminatesAt(d, via))
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

// Each intercity to Amsterdam Zuid first runs out to Amersfoort Schothorst and
// turns there, so a delay on that feeder (usually the :20 and :50 departures)
// lands on the Zuid train even while NS still reports it as on time. Only a
// real delay is worth the extra ink, hence the 5-minute floor.
const FEEDER_DIRECTION = "Amersfoort Schothorst";
const FEEDER_MIN_DELAY = 5;
// How long before the Zuid departure the feeder leaves: ~15-20 minutes in the
// timetable, with slack on both sides so a shifted departure still matches.
const FEEDER_WINDOW_MIN = 8;
const FEEDER_WINDOW_MAX = 30;

// The Schothorst departure that turns into this Zuid train: the latest one
// leaving inside the window before it.
function findFeeder(dep, feeders) {
  const target = new Date(dep.plannedDateTime).getTime();
  let best = null;
  let bestGap = Infinity;
  for (const f of feeders) {
    if (f.product?.type === "BUS") continue;
    if (normalizeStation(f.direction) !== normalizeStation(FEEDER_DIRECTION)) continue;
    const gap = (target - new Date(f.plannedDateTime).getTime()) / 60000;
    if (gap < FEEDER_WINDOW_MIN || gap > FEEDER_WINDOW_MAX) continue;
    if (gap < bestGap) {
      best = f;
      bestGap = gap;
    }
  }
  return best;
}

// Suffix for a Zuid departure whose feeder runs late: " (Amfs: +10)". Empty
// when all is well, so an undelayed feeder stays invisible.
//
// A cancelled feeder leg is deliberately silent: when the delay grows too big
// NS turns the train at Amersfoort Centraal instead of running it out to
// Schothorst, which protects the Zuid departure rather than threatening it.
// Whatever delay is left then shows on the Zuid train itself.
function feederNote(dep, feeders) {
  const feeder = findFeeder(dep, feeders);
  if (!feeder) return "";
  const { delay_minutes, cancelled } = describeDeparture(feeder);
  if (cancelled) return "";
  if (delay_minutes >= FEEDER_MIN_DELAY) return ` (Amfs: +${delay_minutes})`;
  return "";
}

// Before 13:00: the outbound glance. The intercities via Hilversum split into
// two directions — those calling at Amsterdam Centraal and those calling at
// Amsterdam Zuid — so show the next `count` of each instead of just the next
// train per direction, mirroring the return-trip overview. `departures` is
// already filtered (no buses, no sprinters, via-station applied) by the caller;
// `feeders` is the unfiltered board, since the Schothorst trains feeding the
// Zuid departures are filtered out of `departures` by the via-station rule.
function buildMorningMessage(departures, feeders = [], count = 2) {
  const centraal = selectIntercityVia(departures, "Amsterdam C.", count);
  const zuid = selectIntercityVia(departures, "Amsterdam Zuid", count);

  // A station/via combination that reaches neither (e.g. a custom ?station=)
  // falls back to one plain line with the next departures, whatever they are.
  if (!centraal.length && !zuid.length) {
    const next = departures.slice(0, count);
    const headline = statusHeadline(next);
    const line = next.map((d) => describeDeparture(d).message).join(", ");
    return { message: `${headline}\n${line}`, headline, sections: { next: line } };
  }

  const headline = statusHeadline([...centraal, ...zuid]);
  const centraalMsg = intercityVia(departures, "Amsterdam C.", "Centraal", count);
  // The Zuid line carries the feeder note, so it is built here rather than by
  // the plain intercityVia the Centraal line and the return trip use.
  const zuidTrains = zuid.map(
    (d) => `${describeDeparture(d).message}${feederNote(d, feeders)}`
  );
  const zuidMsg = `Zuid: ${
    zuidTrains.length ? zuidTrains.join(", ") : "geen IC via Amsterdam Zuid"
  }`;

  return {
    message: [headline, centraalMsg, zuidMsg].join("\n"),
    headline,
    sections: { centraal: centraalMsg, zuid: zuidMsg },
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

    const board = await fetchDepartures(station);

    let departures = board.filter((d) => d.product?.type !== "BUS");
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
    const { message: body, headline, sections } = buildMorningMessage(departures, board);
    const message = withTestStatus(body);

    res.json({
      category: firstTrain.category,
      direction: firstTrain.direction,
      planned_time: firstTrain.planned_time,
      delay_minutes: firstTrain.delay_minutes,
      cancelled: firstTrain.cancelled,
      track: firstTrain.track,
      headline,
      message,
      sections,
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

// Anything that didn't match a route gets a JSON 404 rather than Express's
// default HTML page, so clients that expect JSON (e.g. the iOS Shortcut) fail
// with a parseable body instead of a confusing conversion error.
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.path });
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
  buildDeparturesUrl,
  extractDepartures,
  fetchDepartures,
  abbreviateDeparture,
  abbreviateStation,
  haarlemToAmsterdam,
  intercityVia,
  statusHeadline,
  buildReturnMessage,
  buildMorningMessage,
  feederNote,
  describeDeparture,
  shortenCategory,
  withTestStatus,
  tokenMatches,
  extractToken,
  state,
};
