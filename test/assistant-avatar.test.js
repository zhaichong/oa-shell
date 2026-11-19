const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_AVATAR, AVATAR_PRESETS, normalizeAvatar, avatarSvg } = require("../src/assistant-avatar");
const { normalizeData } = require("../src/overtime");

test("normalizeAvatar accepts presets and safe raster image data URLs and rejects invalid values", () => {
  assert.equal(normalizeAvatar(undefined), DEFAULT_AVATAR);
  assert.equal(normalizeAvatar(""), DEFAULT_AVATAR);
  assert.equal(normalizeAvatar("preset:orbit"), "preset:orbit");
  assert.equal(normalizeAvatar("preset:unknown"), DEFAULT_AVATAR);

  const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(normalizeAvatar(validPng), validPng);

  // Reject SVG data URLs (XSS risk) and oversized payloads
  assert.equal(normalizeAvatar("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), DEFAULT_AVATAR);
  assert.equal(normalizeAvatar("javascript:alert(1)"), DEFAULT_AVATAR);
  assert.equal(normalizeAvatar("data:image/png;base64," + "A".repeat(270000)), DEFAULT_AVATAR);
});

test("avatarSvg returns distinct SVG markup for every built-in preset", () => {
  const seen = new Set();
  for (const preset of AVATAR_PRESETS) {
    const svg = avatarSvg(preset.id);
    assert.ok(svg.startsWith("<svg "));
    assert.equal(seen.has(svg), false);
    seen.add(svg);
  }
  assert.equal(avatarSvg("preset:missing"), avatarSvg(DEFAULT_AVATAR));
});

test("overtime store normalization persists valid assistantAvatar", () => {
  const saved = normalizeData({ assistantAvatar: "preset:cat" });
  assert.equal(saved.assistantAvatar, "preset:cat");
  assert.equal(normalizeData({ assistantAvatar: "bad" }).assistantAvatar, DEFAULT_AVATAR);
});
