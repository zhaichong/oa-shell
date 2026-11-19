const IMAGE_SELECTOR = ".oli-message .image-content img.image:not(.error-image):not(.delete-image), .oli-message .rich-text-content img.image[data-type='img']:not(.error-image):not(.delete-image)";

function createPreviewFeedback({ show, hide, schedule = setTimeout, cancel = clearTimeout }) {
  let loading = false;
  let timer = null;

  function finish() {
    loading = false;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    hide();
  }

  function click(detail) {
    if (loading) {
      return false;
    }
    if (detail !== 0 && detail !== 1) {
      return false;
    }
    finish();
    loading = true;
    show("正在打开图片…", true);
    timer = schedule(() => {
      loading = false;
      show("图片打开较慢，请稍后重试", false);
      timer = schedule(finish, 4000);
    }, 10000);
    return true;
  }

  return { click, finish, isLoading: () => loading };
}

function installImagePreview(win = window) {
  const doc = win.document;
  let status = null;
  const feedback = createPreviewFeedback({
    show(text, busy) {
      if (!status) {
        status = doc.createElement("div");
        status.className = "oa-image-preview-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        doc.body.appendChild(status);
      }
      status.textContent = text;
      status.classList.toggle("is-loading", busy);
    },
    hide() {
      if (status) {
        status.remove();
        status = null;
      }
    }
  });

  function imageAt(target) {
    return target && typeof target.closest === "function" ? target.closest(IMAGE_SELECTOR) : null;
  }

  function stop(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  win.addEventListener("click", (event) => {
    if (event.button === 0 && imageAt(event.target) && !feedback.click(event.detail)) {
      stop(event);
    }
  }, true);
  win.addEventListener("dblclick", (event) => {
    if (imageAt(event.target)) {
      stop(event);
    }
  }, true);
  win.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      feedback.finish();
    }
  });
  win.addEventListener("blur", feedback.finish);
  win.addEventListener("pagehide", feedback.finish);
  const observer = new win.MutationObserver(() => {
    if (!feedback.isLoading()) {
      return;
    }
    const viewer = doc.querySelector(".PhotoView-Portal, .PhotoView-PhotoSlider__Backdrop, .weapp-em-photo-view-index");
    if (viewer && viewer.getClientRects().length) {
      feedback.finish();
    }
  });
  observer.observe(doc, { childList: true, subtree: true });
  return feedback;
}

module.exports = { createPreviewFeedback, installImagePreview };
