const test = require("node:test");
const assert = require("node:assert/strict");
const { createBoundsSaver, restoreWindowBounds } = require("../src/bounds-saver");

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

test("a failing save does not throw out of flush and keeps the bounds for retry", () => {
  let attempts = 0;
  let saved = null;
  const errors = [];
  const saver = createBoundsSaver((bounds) => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk full");
    saved = bounds;
  }, 1000, (error) => errors.push(error));
  saver.submit({ width: 9 });
  assert.doesNotThrow(() => saver.flush());
  assert.equal(errors.length, 1);
  assert.equal(saved, null);
  saver.flush();
  assert.deepEqual(saved, { width: 9 });
});

test("restoreWindowBounds keeps a position that overlaps a display", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepEqual(
    restoreWindowBounds({ x: 100, y: 50, width: 1440, height: 900 }, displays),
    { x: 100, y: 50, width: 1440, height: 900 }
  );
});

test("restoreWindowBounds drops a position on a disconnected monitor", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  // The window used to live on a second monitor at x=3000; it must not
  // be restored off-screen where the user can never reach it.
  assert.deepEqual(
    restoreWindowBounds({ x: 3000, y: 100, width: 1440, height: 900 }, displays),
    { width: 1440, height: 900 }
  );
  // A 1px sliver is not a usable window either: the title bar cannot
  // be grabbed, so the position is dropped as well.
  assert.deepEqual(
    restoreWindowBounds({ x: 1919, y: 100, width: 1440, height: 900 }, displays),
    { width: 1440, height: 900 }
  );
  // A window whose title bar sits above the display cannot be moved.
  assert.deepEqual(
    restoreWindowBounds({ x: 100, y: -100, width: 1440, height: 900 }, displays),
    { width: 1440, height: 900 }
  );
  // Straddling the edge with plenty visible is fine.
  assert.deepEqual(
    restoreWindowBounds({ x: 1600, y: 100, width: 1440, height: 900 }, displays),
    { x: 1600, y: 100, width: 1440, height: 900 }
  );
});

test("restoreWindowBounds falls back on unusable saved sizes", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepEqual(restoreWindowBounds({ x: 100, y: 50, width: "wide", height: -5 }, displays), { width: 1440, height: 700, x: 100, y: 50 });
  assert.deepEqual(restoreWindowBounds(null, displays), { width: 1440, height: 900 });
  // A width below the window minimum is clamped up, not dropped.
  assert.deepEqual(
    restoreWindowBounds({ x: 100, y: 50, width: 800, height: 900 }, displays),
    { x: 100, y: 50, width: 1100, height: 900 }
  );
});

test("restoreWindowBounds clamps an oversized window to the display it overlaps", () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepEqual(
    restoreWindowBounds({ x: 100, y: 50, width: 3000, height: 2000 }, displays),
    { x: 100, y: 50, width: 1920, height: 1040 }
  );
});
