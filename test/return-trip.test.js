const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  amsterdamHour,
  isReturnTripTime,
  abbreviateDeparture,
  abbreviateStation,
  haarlemToAmsterdam,
  intercityVia,
  statusHeadline,
  buildReturnMessage,
  withTestStatus,
  state,
} = require("../server");

// Build a fake NS departure. Times use an explicit +02:00 (CEST) offset so the
// expected Amsterdam-local times are deterministic regardless of the test TZ.
function dep({
  planned,
  actual = null,
  direction = "Amsterdam Centraal",
  category = "Intercity",
  type = "TRAIN",
  via = [],
  cancelled = false,
}) {
  return {
    plannedDateTime: planned,
    actualDateTime: actual,
    direction,
    cancelled,
    product: { shortCategoryName: category, type },
    routeStations: via.map((name) => ({ mediumName: name })),
  };
}

test("amsterdamHour / isReturnTripTime gate at 13:00 CEST", () => {
  assert.equal(amsterdamHour(new Date("2026-06-01T12:30:00+02:00")), 12);
  assert.equal(amsterdamHour(new Date("2026-06-01T13:00:00+02:00")), 13);
  assert.equal(isReturnTripTime(new Date("2026-06-01T12:59:00+02:00")), false);
  assert.equal(isReturnTripTime(new Date("2026-06-01T13:00:00+02:00")), true);
  assert.equal(isReturnTripTime(new Date("2026-06-01T17:45:00+02:00")), true);
});

test("abbreviateDeparture: on time, delayed and cancelled", () => {
  assert.equal(
    abbreviateDeparture(dep({ planned: "2026-06-01T12:40:00+02:00" })),
    "12:40"
  );
  assert.equal(
    abbreviateDeparture(
      dep({
        planned: "2026-06-01T12:31:00+02:00",
        actual: "2026-06-01T12:34:00+02:00",
      })
    ),
    "12:31 +3"
  );
  assert.equal(
    abbreviateDeparture(
      dep({ planned: "2026-06-01T12:31:00+02:00", cancelled: true })
    ),
    "12:31 ✕"
  );
});

test("abbreviateStation: known codes, unknown left untouched", () => {
  assert.equal(abbreviateStation("Amersfoort Schothorst"), "Amfs");
  assert.equal(abbreviateStation("deventer"), "Dv");
  assert.equal(abbreviateStation("Hannover Hbf"), "Hannover Hbf");
});

test("Haarlem: next 3 trains to Amsterdam, abbreviated and filtered", () => {
  const departures = [
    dep({
      planned: "2026-06-01T12:31:00+02:00",
      actual: "2026-06-01T12:34:00+02:00",
      direction: "Amsterdam Centraal",
    }),
    // Not Amsterdam — must be skipped.
    dep({ planned: "2026-06-01T12:35:00+02:00", direction: "Zandvoort aan Zee" }),
    dep({ planned: "2026-06-01T12:40:00+02:00", direction: "Amsterdam Centraal" }),
    // A bus to Amsterdam — must be skipped.
    dep({
      planned: "2026-06-01T12:45:00+02:00",
      direction: "Amsterdam Sloterdijk",
      type: "BUS",
    }),
    dep({ planned: "2026-06-01T12:51:00+02:00", direction: "Amsterdam Sloterdijk" }),
    // 4th valid train — must be dropped (only 3).
    dep({ planned: "2026-06-01T13:01:00+02:00", direction: "Amsterdam Centraal" }),
  ];

  assert.equal(
    haarlemToAmsterdam(departures),
    "Haarlem: 12:31 +3, 12:40, 12:51"
  );
});

test("Haarlem: no trains found", () => {
  assert.equal(
    haarlemToAmsterdam([dep({ direction: "Zandvoort aan Zee" })]),
    "Haarlem: geen treinen"
  );
});

test("Amsterdam Centraal: next 2 IC via Amersfoort, full message form", () => {
  const departures = [
    dep({
      planned: "2026-06-01T14:32:00+02:00",
      direction: "Enschede",
      via: ["Hilversum", "Amersfoort C.", "Deventer"],
    }),
    // Sprinter — skipped even though it goes via Amersfoort.
    dep({
      planned: "2026-06-01T14:38:00+02:00",
      direction: "Amersfoort Schothorst",
      category: "Sprinter",
      via: ["Hilversum", "Amersfoort C."],
    }),
    // IC not via Amersfoort — skipped.
    dep({
      planned: "2026-06-01T14:40:00+02:00",
      direction: "Den Haag Centraal",
      via: ["Schiphol Airport", "Leiden Centraal"],
    }),
    dep({
      planned: "2026-06-01T14:45:00+02:00",
      actual: "2026-06-01T14:50:00+02:00",
      direction: "Deventer",
      via: ["Hilversum", "Amersfoort C."],
    }),
  ];

  assert.equal(
    intercityVia(departures, "Amersfoort C.", "Amsterdam C"),
    "Amsterdam C: 14:32 IC Es, 14:45 +5 IC Dv"
  );
});

test("Amsterdam Zuid: next 2 IC via Amersfoort", () => {
  const departures = [
    dep({
      planned: "2026-06-01T14:30:00+02:00",
      direction: "Enschede",
      via: ["Amsterdam Centraal", "Amersfoort C."],
    }),
    dep({
      planned: "2026-06-01T14:50:00+02:00",
      direction: "Deventer",
      via: ["Amsterdam Centraal", "Amersfoort C."],
    }),
  ];

  assert.equal(
    intercityVia(departures, "Amersfoort C.", "Amsterdam Zuid"),
    "Amsterdam Zuid: 14:30 IC Es, 14:50 IC Dv"
  );
});

test("Intercity via matches the route field exactly, not the destination", () => {
  // Destination is Amersfoort but it does NOT travel via Amersfoort C. as a
  // route stop -> must not match (we filter on the via field, not direction).
  const goesToButNotVia = dep({
    planned: "2026-06-01T14:30:00+02:00",
    direction: "Amersfoort Centraal",
    via: ["Hilversum"],
  });
  assert.equal(
    intercityVia([goesToButNotVia], "Amersfoort C.", "Amsterdam C"),
    "Amsterdam C: geen IC via Amersfoort C."
  );
});

test("Intercity via: nothing found", () => {
  assert.equal(
    intercityVia([], "Amersfoort C.", "Amsterdam C"),
    "Amsterdam C: geen IC via Amersfoort C."
  );
});

test("buildReturnMessage: headline, station codes and time-first lines", () => {
  const haarlem = [
    dep({ planned: "2026-06-01T17:17:00+02:00", direction: "Amsterdam Centraal" }),
    dep({ planned: "2026-06-01T17:25:00+02:00", direction: "Amsterdam Centraal" }),
  ];
  const asd = [
    dep({
      planned: "2026-06-01T17:31:00+02:00",
      direction: "Deventer",
      via: ["Hilversum", "Amersfoort C."],
    }),
  ];
  const asdz = [
    dep({
      planned: "2026-06-01T17:16:00+02:00",
      direction: "Amersfoort Schothorst",
      category: "Intercity direct",
      via: ["Amsterdam Centraal", "Amersfoort C."],
    }),
  ];

  const { message, sections, headline } = buildReturnMessage(haarlem, asd, asdz);

  assert.equal(sections.haarlem, "Haarlem: 17:17, 17:25");
  assert.equal(sections.centraal, "Centraal: 17:31 IC Dv");
  // Direction "Amersfoort Schothorst" is shortened to the station code "Amfs".
  assert.equal(sections.zuid, "Zuid: 17:16 ICD Amfs");
  assert.equal(headline, "🟢 Op tijd");
  assert.equal(
    message,
    "🟢 Op tijd\nHaarlem: 17:17, 17:25\nCentraal: 17:31 IC Dv\nZuid: 17:16 ICD Amfs"
  );
});

test("statusHeadline: green / yellow / red by worst delay, red on cancel", () => {
  const onTime = dep({ planned: "2026-06-01T17:00:00+02:00" });
  const small = dep({
    planned: "2026-06-01T17:00:00+02:00",
    actual: "2026-06-01T17:03:00+02:00",
  });
  const big = dep({
    planned: "2026-06-01T17:00:00+02:00",
    actual: "2026-06-01T17:08:00+02:00",
  });
  const gone = dep({ planned: "2026-06-01T17:00:00+02:00", cancelled: true });

  assert.equal(statusHeadline([onTime]), "🟢 Op tijd");
  assert.equal(statusHeadline([onTime, small]), "🟡 Kleine vertraging");
  assert.equal(statusHeadline([small, big]), "🔴 Grote vertraging");
  // A cancellation is treated as the most severe, regardless of delays.
  assert.equal(statusHeadline([onTime, gone]), "🔴 Grote vertraging");
});

test("withTestStatus appends a note only when tests fail", () => {
  const original = state.testFailures;
  try {
    state.testFailures = 0;
    assert.equal(withTestStatus("Haarlem: 12:40"), "Haarlem: 12:40");

    state.testFailures = 3;
    assert.equal(withTestStatus("Haarlem: 12:40"), "Haarlem: 12:40\n3 tests failed");

    state.testFailures = 1;
    assert.equal(withTestStatus("Haarlem: 12:40"), "Haarlem: 12:40\n1 test failed");
  } finally {
    state.testFailures = original;
  }
});
