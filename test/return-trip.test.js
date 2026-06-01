const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  amsterdamHour,
  isReturnTripTime,
  abbreviateDeparture,
  haarlemToAmsterdam,
  intercityVia,
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
    "12:31 plus 3"
  );
  assert.equal(
    abbreviateDeparture(
      dep({ planned: "2026-06-01T12:31:00+02:00", cancelled: true })
    ),
    "12:31 niet"
  );
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
    "Haarlem: 12:31 plus 3, 12:40, 12:51"
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
    "Amsterdam C: IC Enschede rijdt om 14:32; IC Deventer rijdt plus 5"
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
    "Amsterdam Zuid: IC Enschede rijdt om 14:30; IC Deventer rijdt om 14:50"
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

test("buildReturnMessage: short labels and Amersfoort -> Amf", () => {
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

  const { message, sections } = buildReturnMessage(haarlem, asd, asdz);

  assert.equal(sections.haarlem, "Haarlem: 17:17, 17:25");
  assert.equal(sections.centraal, "Centraal: IC Deventer rijdt om 17:31");
  // Direction "Amersfoort Schothorst" is shortened to "Amf Schothorst".
  assert.equal(sections.zuid, "Zuid: ICD Amf Schothorst rijdt om 17:16");
  assert.equal(
    message,
    "Haarlem: 17:17, 17:25\nCentraal: IC Deventer rijdt om 17:31\nZuid: ICD Amf Schothorst rijdt om 17:16"
  );
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
