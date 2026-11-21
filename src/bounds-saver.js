function createBoundsSaver(save, waitMs, onError) {
  let timer = null;
  let pending = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) {
      return;
    }
    const value = pending;
    pending = null;
    try {
      save(value);
    } catch (error) {
      // A disk failure must not become an uncaught main-process
      // exception (and must not skip the remaining before-quit
      // cleanup): keep the bounds for the next flush and report it.
      pending = value;
      if (typeof onError === "function") {
        onError(error);
      }
    }
  }

  function submit(bounds) {
    pending = bounds;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(flush, waitMs);
  }

  return { submit, flush };
}

// Validate a saved window rectangle against the displays that are
// actually connected. A saved position is only restored when the window
// would overlap a display: a monitor that was unplugged (or a smaller
// replacement screen) must not strand the window off-screen. Sizes are
// clamped to the window's own minimums and a sane maximum; anything
// unusable falls back to the default size with no position, letting the
// OS place the window.
function restoreWindowBounds(saved, displays) {
  const fallback = { width: 1440, height: 900 };
  const rect = saved && typeof saved === "object" ? saved : {};
  const width = Number.isInteger(rect.width) ? Math.min(Math.max(rect.width, 1100), 7680) : fallback.width;
  const height = Number.isInteger(rect.height) ? Math.min(Math.max(rect.height, 700), 4320) : fallback.height;
  const x = Number.isInteger(rect.x) ? rect.x : undefined;
  const y = Number.isInteger(rect.y) ? rect.y : undefined;
  if (x === undefined || y === undefined) {
    return { width, height };
  }
  const areas = (Array.isArray(displays) ? displays : []).map((display) => display.workArea || display.bounds || display);
  // A sliver is not enough: the window must overlap a display by at
  // least 200px wide and 40px tall, with its title bar on screen,
  // otherwise it cannot be grabbed or moved back.
  let best = null;
  let bestOverlap = 0;
  for (const area of areas) {
    if (!area || !Number.isFinite(area.x) || !Number.isFinite(area.y) || !Number.isFinite(area.width) || !Number.isFinite(area.height)) {
      continue;
    }
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    const titleOnScreen = y < area.y + area.height && y + 40 > area.y;
    const overlap = overlapX >= 200 && overlapY >= 40 && titleOnScreen ? overlapX * overlapY : 0;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = area;
    }
  }
  if (!best) {
    return { width, height };
  }
  // Sizes are also clamped to the display they overlap: a 7680px-wide
  // window used to be "valid" on a 1920px screen as long as 200px of it
  // overlapped, leaving most of it off-screen.
  return { width: Math.min(width, best.width), height: Math.min(height, best.height), x, y };
}

module.exports = { createBoundsSaver, restoreWindowBounds };
