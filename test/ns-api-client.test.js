const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildDeparturesUrl, extractDepartures } = require("../server");

test("buildDeparturesUrl targets the Reisinformatie departures endpoint", () => {
  const url = buildDeparturesUrl("AMF", 12);

  assert.equal(
    url.toString(),
    "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/departures?station=AMF&maxJourneys=12"
  );
});

test("extractDepartures reads the official payload.departures response", () => {
  const departures = [{ direction: "Deventer" }];

  assert.equal(
    extractDepartures({ payload: { source: "PPV", departures } }),
    departures
  );
});

test("extractDepartures tolerates direct and flattened response shapes", () => {
  const direct = [{ direction: "Amsterdam Centraal" }];
  const flattened = [{ direction: "Enschede" }];
  const payloadArray = [{ direction: "Haarlem" }];

  assert.equal(extractDepartures(direct), direct);
  assert.equal(extractDepartures({ departures: flattened }), flattened);
  assert.equal(extractDepartures({ payload: payloadArray }), payloadArray);
  assert.deepEqual(extractDepartures({}), []);
});
