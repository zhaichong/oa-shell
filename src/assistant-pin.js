const { DEFAULT_AVATAR, avatarSvg, normalizeAvatar } = require("./assistant-avatar")
const PIN_ID = "oa-shell-assistant"

function pinMatches(query) {
  const text = String(query || "").replace(/\s+/g, "").toLowerCase()
  if (!text) {
    return true
  }
  // Only a query that actually contains "分身" matches: a single
  // character like "分" or "身" is a session search, not the assistant.
  return text.indexOf("分身") !== -1
}

const COMPOSER_SELECTOR = ".chat-input, .chat-input-main, .chat-input-container, .send-button-wrapper"

function boxEdges(box) {
  if (!box) {
    return null
  }
  const x = Number(box.x)
  const y = Number(box.y)
  const width = Number(box.width)
  const height = Number(box.height)
  if (![x, y, width, height].every(Number.isFinite)) {
    return null
  }
  const right = Number.isFinite(Number(box.right)) ? Number(box.right) : x + width
  const bottom = Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : y + height
  return {
    x: x,
    y: y,
    width: width,
    height: height,
    right: right,
    bottom: bottom
  }
}

function unionRect(boxes) {
  const list = boxes.filter(Boolean)
  if (!list.length) {
    return null
  }
  const x = Math.min.apply(null, list.map(function (box) { return box.x }))
  const y = Math.min.apply(null, list.map(function (box) { return box.y }))
  const right = Math.max.apply(null, list.map(function (box) { return box.right }))
  const bottom = Math.max.apply(null, list.map(function (box) { return box.bottom }))
  return {
    x: x,
    y: y,
    right: right,
    bottom: bottom,
    width: right - x,
    height: bottom - y
  }
}

function composerInColumn(composer, message) {
  if (!composer || composer.width < 80 || composer.height < 32 || composer.height > 520) {
    return false
  }
  if (composer.x < message.x - 24 || composer.x > message.right - 40) {
    return false
  }
  return composer.bottom >= message.y && composer.y <= message.bottom + 280
}

function shouldBlockComposer(open, target) {
  if (open !== true || !target || typeof target.closest !== "function") {
    return false
  }
  return Boolean(target.closest(COMPOSER_SELECTOR))
}

function messagePane(layout, session, message, composer) {
  const messageBox = boxEdges(message)
  const composerBox = boxEdges(composer)
  if (messageBox && messageBox.width >= 80 && messageBox.height >= 80) {
    const parts = [messageBox]
    if (composerInColumn(composerBox, messageBox)) {
      parts.push(composerBox)
    }
    const covered = unionRect(parts)
    return {
      x: Math.round(covered.x),
      y: Math.round(covered.y),
      width: Math.round(covered.width),
      height: Math.round(covered.height)
    }
  }
  if (!layout || !session) {
    return null
  }
  const top = Number.isFinite(layout.y) ? layout.y : layout.top
  const bottom = Number.isFinite(layout.bottom) ? layout.bottom : top + layout.height
  const width = layout.right - session.right
  const height = bottom - top
  if (!Number.isFinite(top) || width < 80 || height < 80) {
    return null
  }
  return {
    x: Math.round(session.right),
    y: Math.round(top),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function boxOf(node) {
  if (!node || typeof node.getBoundingClientRect !== "function") {
    return null
  }
  const rect = node.getBoundingClientRect()
  return {
    x: rect.left,
    y: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  }
}

function findSessionRoot(doc) {
  return doc.querySelector(".weapp-em-im-main-layout")
    || doc.querySelector(".weapp-main-em:not(.im-hide)")
}

function headerEnd(session) {
  const nodes = [
    session.querySelector(".search-bar"),
    session.querySelector(".session-tab"),
    session.querySelector(".session-title")
  ].filter(Boolean)
  return nodes.reduce(function (later, node) {
    if (!later || !later.compareDocumentPosition) {
      return node
    }
    return later.compareDocumentPosition(node) & 4 ? node : later
  }, null)
}

function placePin(session, pin) {
  const header = headerEnd(session)
  const parent = header ? header.parentNode : session
  const before = header ? header.nextSibling : session.firstChild
  if (pin.parentNode === parent && (header ? header.nextSibling === pin : session.firstChild === pin)) {
    return
  }
  parent.insertBefore(pin, before)
}

function renderAvatarNode(doc, container, avatarValue) {
  const normalized = normalizeAvatar(avatarValue)
  if (normalized.indexOf("data:image/") === 0) {
    container.textContent = ""
    const img = doc.createElement("img")
    img.src = normalized
    img.alt = ""
    img.setAttribute("aria-hidden", "true")
    container.appendChild(img)
    return
  }
  container.innerHTML = avatarSvg(normalized)
}

function createPin(doc, avatarValue) {
  const button = doc.createElement("button")
  button.id = PIN_ID
  button.type = "button"
  button.className = "oa-assistant-pin"
  button.setAttribute("aria-label", "打开分身")
  button.innerHTML = "<span class=\"oa-assistant-avatar\"></span><span class=\"oa-assistant-copy\"><span class=\"oa-assistant-name-row\"><span class=\"oa-assistant-name\">分身</span><span class=\"oa-assistant-badge\" hidden></span></span><span class=\"oa-assistant-last\">可以直接交代加班和提醒</span></span>"
  const avatarBox = button.querySelector(".oa-assistant-avatar")
  if (avatarBox) {
    renderAvatarNode(doc, avatarBox, avatarValue)
  }
  return button
}

function searchText(session) {
  const input = session.querySelector("input")
  return input && typeof input.value === "string" ? input.value : ""
}

function installAssistantPin(bridge, doc) {
  const page = doc || (typeof document === "undefined" ? null : document)
  if (!page || !page.defaultView || !bridge) {
    return
  }
  let wanted = false
  let currentAvatar = DEFAULT_AVATAR
  let overtimeAlertCount = 0
  let observer = null
  let observed = null
  let ensureQueued = false

  function pinNode() {
    return page.getElementById(PIN_ID)
  }

  function setAvatar(value) {
    currentAvatar = normalizeAvatar(value)
    const pin = pinNode()
    const box = pin && pin.querySelector(".oa-assistant-avatar")
    if (box) {
      renderAvatarNode(page, box, currentAvatar)
    }
  }

  function setPreview(text) {
    const pin = pinNode()
    const last = pin && pin.querySelector(".oa-assistant-last")
    const line = String(text || "").split("\n")[0].trim()
    // While an overtime alert is active the pin line belongs to the
    // alert, not the latest reply preview.
    if (last && line && overtimeAlertCount <= 0) {
      last.textContent = line.slice(0, 42)
    }
  }

  function setOvertimeAlert(count) {
    const pin = pinNode()
    const badge = pin && pin.querySelector(".oa-assistant-badge")
    const last = pin && pin.querySelector(".oa-assistant-last")
    const total = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.floor(Number(count)) : 0
    const hadAlert = overtimeAlertCount > 0
    overtimeAlertCount = total
    if (badge) {
      if (total > 0) {
        badge.textContent = `待核对 ${total}`
        badge.hidden = false
      } else {
        badge.textContent = ""
        badge.hidden = true
      }
    }
    if (last) {
      if (total > 0) {
        last.textContent = `有 ${total} 条加班申请待核对`
        last.classList.add("is-alert")
      } else {
        last.classList.remove("is-alert")
        // Whether the confirmation shows is decided by the alert state
        // kept here, not by reading back last.textContent: a reply
        // preview may have overwritten the line in between.
        if (hadAlert) {
          last.textContent = "加班申请已补齐"
        }
      }
    }
  }

  function setCovering(open) {
    if (page.documentElement) {
      page.documentElement.classList.toggle("oa-assistant-covering", open === true)
    }
  }

  function blurComposer() {
    const active = page.activeElement
    if (shouldBlockComposer(true, active) && typeof active.blur === "function") {
      active.blur()
    }
  }

  function guardComposer(event) {
    if (!shouldBlockComposer(wanted, event.target)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function setOpen(open) {
    wanted = open === true
    setCovering(wanted)
    const pin = pinNode()
    if (pin) {
      pin.classList.toggle("is-active", wanted)
    }
    if (wanted) {
      blurComposer()
      report()
    }
  }

  function report() {
    if (!wanted || typeof bridge.bounds !== "function") {
      return
    }
    const root = findSessionRoot(page)
    const session = root && root.querySelector(".session")
    const message = root && (root.querySelector(".message-main") || root.querySelector(".message-wrapper"))
    const composers = root ? root.querySelectorAll(COMPOSER_SELECTOR) : []
    const composerBoxes = []
    for (let index = 0; index < composers.length; index += 1) {
      const box = boxEdges(boxOf(composers[index]))
      if (box && box.width >= 80 && box.height >= 24) {
        composerBoxes.push(box)
      }
    }
    const pane = messagePane(boxOf(root), boxOf(session), boxOf(message), unionRect(composerBoxes))
    if (pane) {
      bridge.bounds(pane)
    }
  }

  function bind(session, pin) {
    if (pin.dataset.bound !== "1") {
      pin.dataset.bound = "1"
      pin.addEventListener("click", function (event) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(true)
        if (typeof bridge.open === "function") {
          bridge.open()
        }
      })
    }
    if (session.dataset.oaAssistantBound === "1") {
      return
    }
    session.dataset.oaAssistantBound = "1"
    session.addEventListener("click", function (event) {
      const target = event.target
      if (!target || typeof target.closest !== "function") {
        return
      }
      if (target.closest("#" + PIN_ID)) {
        return
      }
      if (target.closest(".session-item")) {
        setOpen(false)
        if (typeof bridge.close === "function") {
          bridge.close()
        }
      }
    }, true)
    session.addEventListener("input", function () {
      const current = pinNode()
      if (!current) {
        return
      }
      current.hidden = !pinMatches(searchText(session))
    })
  }

  function ensure() {
    const root = findSessionRoot(page)
    if (!root) {
      return
    }
    const session = root.querySelector(".session")
    if (!session) {
      return
    }
    let pin = pinNode()
    if (!pin) {
      pin = createPin(page, currentAvatar)
    }
    bind(session, pin)
    placePin(session, pin)
    const hide = !pinMatches(searchText(session))
    if (pin.hidden !== hide) {
      pin.hidden = hide
    }
    pin.classList.toggle("is-active", wanted)
    if (observed !== root) {
      if (observer) {
        observer.disconnect()
      }
      observed = root
      observer = new MutationObserver(function () {
        if (ensureQueued) {
          return
        }
        ensureQueued = true
        page.defaultView.requestAnimationFrame(function () {
          ensureQueued = false
          ensure()
        })
      })
      observer.observe(root, { childList: true, subtree: true })
    }
    if (wanted) {
      report()
    }
  }

  page.defaultView.__setAssistantOpen = setOpen
  page.defaultView.__setAssistantPreview = setPreview
  page.defaultView.__setAssistantAvatar = setAvatar
  page.defaultView.__setAssistantOvertimeAlert = setOvertimeAlert
  page.defaultView.__reportAssistantPane = report

  ;["keydown", "keypress", "keyup", "mousedown", "click"].forEach(function (type) {
    page.addEventListener(type, guardComposer, true)
  })

  if (page.readyState === "loading") {
    page.addEventListener("DOMContentLoaded", ensure)
  } else {
    ensure()
  }
  page.defaultView.addEventListener("resize", function () {
    if (wanted) {
      report()
    }
  })
  setInterval(ensure, 1500)
}

module.exports = {
  pinMatches,
  messagePane,
  shouldBlockComposer,
  installAssistantPin
}
