function createBoundsSaver(save, waitMs) {
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
    save(value);
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

module.exports = { createBoundsSaver };
