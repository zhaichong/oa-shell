require("./oa-bridge");
(function () {
  var TARGET = "/api/em/msg/getMsgInfo";
  var CLOSE_KEY = "CLOSE_WEB_IM_VALUE";

  function remember(extra) {
    try {
      window.__oaMsgInfo = extra;
    } catch (error) {
      return;
    }
  }

  try {
    var storage = window.sessionStorage;
    var readItem = storage.getItem.bind(storage);
    storage.getItem = function (key) {
      if (key === CLOSE_KEY) {
        return "0";
      }
      return readItem(key);
    };
    storage.setItem(CLOSE_KEY, "0");
  } catch (error) {
    remember({ closeWebIm: null, patched: false, cache: "unavailable" });
  }

  function pathnameOf(url) {
    try {
      return new URL(String(url), window.location.href).pathname;
    } catch (error) {
      return String(url || "");
    }
  }

  function isMsgInfo(url, method) {
    if (method && String(method).toUpperCase() !== "GET") {
      return false;
    }
    return pathnameOf(url).indexOf(TARGET) !== -1;
  }

  function patchValue(value, depth) {
    if (!value || typeof value !== "object" || depth > 8) {
      return false;
    }
    var changed = false;
    if (Object.prototype.hasOwnProperty.call(value, "closeWebIm") && Number(value.closeWebIm) === 1) {
      remember({ closeWebIm: value.closeWebIm, patched: true });
      value.closeWebIm = 0;
      changed = true;
    }
    var keys = Object.keys(value);
    for (var index = 0; index < keys.length; index += 1) {
      if (patchValue(value[keys[index]], depth + 1)) {
        changed = true;
      }
    }
    return changed;
  }

  function rewriteText(text) {
    if (typeof text !== "string" || text.indexOf("closeWebIm") === -1) {
      return text;
    }
    try {
      var data = JSON.parse(text);
      if (!patchValue(data, 0)) {
        remember({ closeWebIm: null, patched: false });
        return text;
      }
      return JSON.stringify(data);
    } catch (error) {
      return text.replace(/("closeWebIm"\s*:\s*)1\b/g, "$10");
    }
  }

  var prototype = XMLHttpRequest.prototype;
  var textDescriptor = Object.getOwnPropertyDescriptor(prototype, "responseText");
  var responseDescriptor = Object.getOwnPropertyDescriptor(prototype, "response");
  var originalOpen = prototype.open;

  prototype.open = function (method, url) {
    if (isMsgInfo(url, method) && textDescriptor && textDescriptor.get && responseDescriptor && responseDescriptor.get) {
      var xhr = this;
      var cache = { text: null, response: null };
      try {
        Object.defineProperty(xhr, "responseText", {
          configurable: true,
          get: function () {
            var raw = textDescriptor.get.call(xhr);
            if (xhr.readyState !== 4) {
              return raw;
            }
            if (cache.text === null) {
              cache.text = rewriteText(raw);
            }
            return cache.text;
          }
        });
        Object.defineProperty(xhr, "response", {
          configurable: true,
          get: function () {
            var raw = responseDescriptor.get.call(xhr);
            if (xhr.readyState !== 4) {
              return raw;
            }
            var type = xhr.responseType;
            if (type === "" || type === "text") {
              if (cache.text === null) {
                cache.text = rewriteText(typeof raw === "string" ? raw : textDescriptor.get.call(xhr));
              }
              return cache.text;
            }
            if (cache.response === null) {
              if (raw && typeof raw === "object") {
                patchValue(raw, 0);
                cache.response = raw;
              } else if (typeof raw === "string") {
                cache.response = rewriteText(raw);
              } else {
                cache.response = raw;
              }
            }
            return cache.response;
          }
        });
      } catch (error) {
        remember({ closeWebIm: null, patched: false, cache: "getter" });
      }
    }
    return originalOpen.apply(this, arguments);
  };

  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
      return originalFetch.apply(this, arguments).then(function (response) {
        if (!isMsgInfo(url, method)) {
          return response;
        }
        return response.clone().text().then(function (text) {
          var headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(rewriteText(text), {
            status: response.status,
            statusText: response.statusText,
            headers: headers
          });
        });
      });
    };
  }
})();
