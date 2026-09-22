/**
 * 通用工具函数（纯函数，可在 Node 中单测）。
 */

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// 按 step 取整（步进 0.3 的曝光补偿等），结果保留 3 位小数避免浮点误差
function roundTo(v, step) {
  return Number((Math.round(v / step) * step).toFixed(3));
}

// 在档位数组中取对数距离最近的档位（适合 ISO/快门/光圈这类等比数列）
function nearestByLog(value, stops) {
  if (!stops || !stops.length) return value;
  let best = stops[0];
  let bestDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const dist = Math.abs(Math.log2(value / stops[i]));
    if (dist < bestDist) {
      bestDist = dist;
      best = stops[i];
    }
  }
  return best;
}

// 指数移动平均：输出值 = 上一帧输出 × prevWeight + 当前计算值 × (1 - prevWeight)（6.5.1）
function ema(prev, cur, prevWeight) {
  if (typeof prev !== 'number' || isNaN(prev)) return cur;
  return prev * prevWeight + cur * (1 - prevWeight);
}

// 快门展示：1/2000s 或 1.6s
function formatShutter(seconds) {
  if (seconds >= 1) {
    const v = Math.round(seconds * 10) / 10;
    return Number.isInteger(v) ? v + 's' : v.toFixed(1) + 's';
  }
  return '1/' + Math.round(1 / seconds) + 's';
}

// 光圈展示：f/4、f/2.8
function formatAperture(n) {
  return 'f/' + (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
}

// 曝光补偿展示：+0.3EV / -1.0EV
function formatEvComp(ev) {
  return (ev >= 0 ? '+' : '') + ev.toFixed(1) + 'EV';
}

// 色温展示：5200K
function formatColorTemp(k) {
  return Math.round(k) + 'K';
}

// 时间分钟数 → HH:mm
function formatMinuteOfDay(m) {
  const mm = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60);
  const min = mm % 60;
  return (h < 10 ? '0' + h : String(h)) + ':' + (min < 10 ? '0' + min : String(min));
}

// 获取设备平台（ios 的相机帧为 BGRA 序，需要交换 R/B）
// 仅在小程序环境调用；Node 单测环境无 wx，安全返回空串
function getPlatform() {
  try {
    if (typeof wx !== 'undefined' && wx.getDeviceInfo) return wx.getDeviceInfo().platform || '';
  } catch (e) { /* ignore */ }
  try {
    if (typeof wx !== 'undefined' && wx.getSystemInfoSync) return wx.getSystemInfoSync().platform || '';
  } catch (e) { /* ignore */ }
  return '';
}

function getWindowInfo() {
  try {
    if (typeof wx !== 'undefined' && wx.getWindowInfo) return wx.getWindowInfo();
  } catch (e) { /* ignore */ }
  try {
    if (typeof wx !== 'undefined' && wx.getSystemInfoSync) return wx.getSystemInfoSync();
  } catch (e) { /* ignore */ }
  return { statusBarHeight: 20 };
}

module.exports = {
  clamp,
  roundTo,
  nearestByLog,
  ema,
  formatShutter,
  formatAperture,
  formatEvComp,
  formatColorTemp,
  formatMinuteOfDay,
  getPlatform,
  getWindowInfo
};
