const test = require("node:test");
const assert = require("node:assert/strict");
const { createBoundsSaver } = require("../src/bounds-saver");

test("rapid resizes save the latest bounds once", async () => {
  const saved = [];
  const saver = createBoundsSaver((bounds) => saved.push(bounds), 30);
  saver.submit({ width: 1 });
  saver.submit({ width: 2 });
  saver.submit({ width: 3 });
  assert.equal(saved.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(saved, [{ width: 3 }]);
});

test("flush writes pending bounds immediately and only once", () => {
  const saved = [];
  const saver = createBoundsSaver((bounds) => saved.push(bounds), 1000);
  saver.submit({ width: 9 });
  saver.flush();
  saver.flush();
  assert.deepEqual(saved, [{ width: 9 }]);
});
