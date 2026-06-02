const { test } = require("node:test");
const assert = require("node:assert/strict");

const { tokenMatches, extractToken } = require("../server");

test("tokenMatches accepts the exact token and rejects everything else", () => {
  assert.equal(tokenMatches("s3cret", "s3cret"), true);
  assert.equal(tokenMatches("wrong", "s3cret"), false);
  assert.equal(tokenMatches("s3cre", "s3cret"), false); // shorter
  assert.equal(tokenMatches("s3crett", "s3cret"), false); // longer
  assert.equal(tokenMatches("", "s3cret"), false);
  assert.equal(tokenMatches(undefined, "s3cret"), false);
});

test("tokenMatches never matches when no token is configured", () => {
  assert.equal(tokenMatches("anything", ""), false);
  assert.equal(tokenMatches("anything", undefined), false);
});

// Minimal stand-in for the bits of an Express request extractToken reads.
function fakeReq({ headers = {}, query = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()], query };
}

test("extractToken reads a Bearer Authorization header", () => {
  const req = fakeReq({ headers: { Authorization: "Bearer abc123" } });
  assert.equal(extractToken(req), "abc123");
});

test("extractToken reads the X-Access-Token header", () => {
  const req = fakeReq({ headers: { "X-Access-Token": "abc123" } });
  assert.equal(extractToken(req), "abc123");
});

test("extractToken falls back to the ?token query param", () => {
  const req = fakeReq({ query: { token: "abc123" } });
  assert.equal(extractToken(req), "abc123");
});

test("extractToken returns empty string when no token is present", () => {
  assert.equal(extractToken(fakeReq()), "");
});
