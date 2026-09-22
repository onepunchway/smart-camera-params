/**
 * 本地存储封装（7.3 数据存储方案）。
 * 预设/拍摄历史/用户设置（含设备校准）存 wx storage，天气缓存在 env-service 内按城市分键。
 */

const KEYS = {
  presets: 'cam_presets',
  history: 'cam_history',
  settings: 'cam_settings'
};

const HISTORY_LIMIT = 100;

function read(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 用户设置（含设备校准、采样间隔、手动环境） ----------
const DEFAULT_SETTINGS = {
  sampleIntervalMs: 1000,
  calibrationEv: 0,
  manualEnv: {
    enabled: false,
    city: '',
    weather: '',     // 空 = 自动（有城市则查API，否则按时段估算）
    datetime: ''     // 'YYYY/MM/DD HH:mm'，空 = 使用系统时间
  }
};

function getSettings() {
  const saved = read(KEYS.settings, {});
  const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
  merged.manualEnv = Object.assign({}, DEFAULT_SETTINGS.manualEnv, saved.manualEnv || {});
  return merged;
}

function setSettings(patch) {
  const next = Object.assign({}, getSettings(), patch || {});
  write(KEYS.settings, next);
  return next;
}

// ---------- 预设 ----------
function getPresets() {
  return read(KEYS.presets, []);
}

function addPreset(preset) {
  const list = getPresets();
  const item = Object.assign({ id: 'p' + Date.now(), createdAt: Date.now() }, preset);
  list.unshift(item);
  write(KEYS.presets, list);
  return item;
}

function updatePreset(id, patch) {
  const list = getPresets();
  const idx = list.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  list[idx] = Object.assign({}, list[idx], patch);
  write(KEYS.presets, list);
  return list[idx];
}

function removePreset(id) {
  const list = getPresets().filter((p) => p.id !== id);
  write(KEYS.presets, list);
}

// ---------- 拍摄历史（最多100条，按时间倒序） ----------
function getHistory() {
  return read(KEYS.history, []);
}

function addHistory(record) {
  const list = getHistory();
  const item = Object.assign({ id: 'h' + Date.now(), ts: Date.now() }, record);
  list.unshift(item);
  if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
  write(KEYS.history, list);
  return item;
}

function removeHistory(id) {
  const list = getHistory().filter((h) => h.id !== id);
  write(KEYS.history, list);
}

function clearHistory() {
  write(KEYS.history, []);
}

module.exports = {
  KEYS,
  HISTORY_LIMIT,
  getSettings,
  setSettings,
  getPresets,
  addPreset,
  updatePreset,
  removePreset,
  getHistory,
  addHistory,
  removeHistory,
  clearHistory
};
