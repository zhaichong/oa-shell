const DEFAULT_AVATAR = "preset:default";
const MAX_CUSTOM_AVATAR_LENGTH = 260000;

const AVATAR_PRESETS = [
  {
    id: "preset:default",
    label: "经典分身",
    svg: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="8" fill="#3555c5"></rect><circle cx="20" cy="17" r="9.2" fill="#f3efe6"></circle><path d="M11 15.2C11.8 9.2 15.4 6.2 20 6.2s8.2 3 9 9c-2.2-1.6-5.2-2.3-9-2.3s-6.8.7-9 2.3z" fill="#243044"></path><path d="M7 36.5c2-7.2 7-11 13-11s11 3.8 13 11" fill="#2b46a7"></path><circle cx="16.4" cy="17.6" r="1.35" fill="#243044"></circle><circle cx="23.4" cy="17.6" r="1.35" fill="#243044"></circle><path d="M17.6 21.1q2.4 1.5 4.8 0" fill="none" stroke="#243044" stroke-width="1.1" stroke-linecap="round"></path></svg>'
  },
  {
    id: "preset:orbit",
    label: "星轨",
    svg: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="8" fill="#2b46a7"></rect><path d="M29 9.7c1.1 0 1.9 1.2 1.4 2.2l-6.9 11.7a2.2 2.2 0 0 1-1.9 1.1h-3.4l6.5-11 2.3-4H29z" fill="#b8ceff"></path><path d="M10.9 9.7h4.2c.8 0 1.6.4 1.9 1.1l4.8 8.4V30c0 1.2-1 2.2-2.2 2.2h-1.5a2.2 2.2 0 0 1-2.2-2.2v-8.4L9.5 11.9c-.6-1 .2-2.2 1.4-2.2z" fill="#ffffff"></path><circle cx="29.6" cy="29.1" r="2.6" fill="#63e6be"></circle></svg>'
  },
  {
    id: "preset:bot",
    label: "蓝釉机甲",
    svg: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="8" fill="#1e293b"></rect><rect x="18.5" y="5" width="3" height="5" rx="1.5" fill="#748ffc"></rect><circle cx="20" cy="5.5" r="2" fill="#63e6be"></circle><rect x="8.5" y="11" width="23" height="19" rx="7" fill="#3555c5"></rect><rect x="11.5" y="15" width="17" height="9" rx="4.5" fill="#0f172a"></rect><circle cx="16.2" cy="19.5" r="2" fill="#74c0fc"></circle><circle cx="23.8" cy="19.5" r="2" fill="#74c0fc"></circle><path d="M16 26.5h8" stroke="#dbe4ff" stroke-width="1.8" stroke-linecap="round"></path></svg>'
  },
  {
    id: "preset:owl",
    label: "夜航猫头鹰",
    svg: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="8" fill="#2c3e6b"></rect><path d="M10 11l5 4.5h10L30 11v12c0 6.5-4.5 11-10 11s-10-4.5-10-11V11z" fill="#e8eefb"></path><circle cx="15.5" cy="20" r="4" fill="#ffffff" stroke="#3555c5" stroke-width="1.6"></circle><circle cx="24.5" cy="20" r="4" fill="#ffffff" stroke="#3555c5" stroke-width="1.6"></circle><circle cx="15.5" cy="20" r="1.7" fill="#222c38"></circle><circle cx="24.5" cy="20" r="1.7" fill="#222c38"></circle><path d="M18.3 24.2L20 26.8l1.7-2.6z" fill="#f59f00"></path></svg>'
  },
  {
    id: "preset:cat",
    label: "办公小猫",
    svg: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="8" fill="#eef3fc"></rect><path d="M9.5 11.5L15.5 16h9l6-4.5v13.8c0 5.4-4.7 9.7-10.5 9.7S9.5 30.7 9.5 25.3V11.5z" fill="#3555c5"></path><circle cx="15.5" cy="21.5" r="1.6" fill="#ffffff"></circle><circle cx="24.5" cy="21.5" r="1.6" fill="#ffffff"></circle><path d="M18.4 25.2q1.6 1.4 3.2 0" fill="none" stroke="#ffd8a8" stroke-width="1.6" stroke-linecap="round"></path><circle cx="20" cy="23.6" r="1.2" fill="#ffa8a8"></circle></svg>'
  }
];

const PRESET_MAP = new Map(AVATAR_PRESETS.map((item) => [item.id, item]));
const DATA_URL_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/**
 * Validate and normalize a preset avatar ID or base64 raster data URL.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAvatar(value) {
  if (typeof value !== "string") {
    return DEFAULT_AVATAR;
  }
  const trimmed = value.trim();
  if (PRESET_MAP.has(trimmed)) {
    return trimmed;
  }
  if (trimmed.length <= MAX_CUSTOM_AVATAR_LENGTH && DATA_URL_RE.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_AVATAR;
}

/**
 * Return the inline SVG string for a preset avatar ID, or the default preset SVG.
 * @param {string} id
 * @returns {string}
 */
function avatarSvg(id) {
  const preset = PRESET_MAP.get(id) || PRESET_MAP.get(DEFAULT_AVATAR);
  return preset ? preset.svg : "";
}

module.exports = {
  DEFAULT_AVATAR,
  AVATAR_PRESETS,
  normalizeAvatar,
  avatarSvg
};
