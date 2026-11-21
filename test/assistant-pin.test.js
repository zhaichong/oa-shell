const assert = require("node:assert/strict")
const test = require("node:test")
const { messagePane, pinMatches, shouldBlockComposer } = require("../src/assistant-pin")

test("keeps the assistant visible unless the search is for someone else", () => {
  assert.equal(pinMatches(""), true)
  assert.equal(pinMatches("  "), true)
  // A single character is a session search, not the assistant: only a
  // query containing the full word "分身" keeps the pin visible.
  assert.equal(pinMatches("分"), false)
  assert.equal(pinMatches("身"), false)
  assert.equal(pinMatches("分身"), true)
  assert.equal(pinMatches("找分身"), true)
  assert.equal(pinMatches("张三"), false)
})

test("uses the message pane and falls back beside the session list", () => {
  assert.deepEqual(messagePane(
    { x: 0, y: 48, right: 1000, bottom: 700, width: 1000, height: 652 },
    { x: 72, y: 48, right: 360, bottom: 700, width: 288, height: 652 },
    { x: 360, y: 48, width: 640, height: 652 }
  ), { x: 360, y: 48, width: 640, height: 652 })

  assert.deepEqual(messagePane(
    { x: 0, y: 48, right: 1000, bottom: 700, width: 1000, height: 652 },
    { x: 72, y: 48, right: 360, bottom: 700, width: 288, height: 652 },
    null
  ), { x: 360, y: 48, width: 640, height: 652 })

  assert.equal(messagePane(null, null, { x: 0, y: 0, width: 20, height: 20 }), null)
})

test("covers the native composer without stretching over the session search box", () => {
  assert.deepEqual(messagePane(
    { x: 0, y: 48, right: 1000, bottom: 760, width: 1000, height: 712 },
    { x: 72, y: 48, right: 360, bottom: 760, width: 288, height: 712 },
    { x: 360, y: 48, width: 640, height: 520 },
    { x: 360, y: 568, width: 640, height: 192 }
  ), { x: 360, y: 48, width: 640, height: 712 })

  assert.deepEqual(messagePane(
    { x: 0, y: 48, right: 1000, bottom: 760, width: 1000, height: 712 },
    { x: 72, y: 48, right: 360, bottom: 760, width: 288, height: 712 },
    { x: 360, y: 48, width: 640, height: 520 },
    { x: 84, y: 56, width: 250, height: 36 }
  ), { x: 360, y: 48, width: 640, height: 520 })
})

test("blocks the native composer only while the assistant is open", () => {
  const composer = { closest: (selector) => selector.indexOf(".chat-input") !== -1 }
  const session = { closest: () => null }
  assert.equal(shouldBlockComposer(true, composer), true)
  assert.equal(shouldBlockComposer(false, composer), false)
  assert.equal(shouldBlockComposer(true, session), false)
  assert.equal(shouldBlockComposer(true, null), false)
})
