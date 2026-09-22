/**
 * 太阳位置计算 —— 日出日落与特殊光线时段判定。
 * 用于划分黄金时刻/蓝调时刻/正午强光等时段（文档 5.1.2、2.1 特殊光线识别）。
 *
 * 算法：NOAA 简化太阳位置公式（General Solar Position Calculations），
 * 精度约 ±2 分钟，满足时段划分需求。
 */

const RAD = Math.PI / 180;

// 无定位时的兜底日出日落（当地钟点近似：06:30 / 18:30）
function fallbackSunTimes() {
  return { sunrise: 6.5 * 60, sunset: 18.5 * 60, fallback: true };
}

/**
 * 计算某地某日的日出日落（当地时间分钟数 0-1439）。
 * @param {Date} date 当地日期
 * @param {number} lat 纬度（北正）
 * @param {number} lng 经度（东正）
 * @param {number} [tzOffsetMinutes] 当地对 UTC 偏移（如中国 +480），缺省取系统时区
 * 极昼返回 sunrise=0/sunset=1439，极夜返回 sunrise=null/sunset=null。
 */
function sunTimes(date, lat, lng, tzOffsetMinutes) {
  const tz = tzOffsetMinutes != null ? tzOffsetMinutes : -date.getTimezoneOffset();
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const doy = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000);

  const g = (2 * Math.PI / 365) * (doy - 1 + 0.5);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);

  const latRad = lat * RAD;
  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(latRad) * Math.cos(decl)) - Math.tan(latRad) * Math.tan(decl);

  const noonUTC = 720 - 4 * lng - eqtime;
  const toLocal = (utcMin) => (((utcMin + tz) % 1440) + 1440) % 1440;

  if (cosHa > 1) {
    // 极夜：太阳整日不升
    return { sunrise: null, sunset: null, solarNoon: toLocal(noonUTC), polarNight: true };
  }
  if (cosHa < -1) {
    // 极昼：太阳整日不落
    return { sunrise: 0, sunset: 1439, solarNoon: toLocal(noonUTC), midnightSun: true };
  }
  const ha = Math.acos(cosHa) / RAD;
  return {
    sunrise: Math.round(toLocal(noonUTC - 4 * ha)),
    sunset: Math.round(toLocal(noonUTC + 4 * ha)),
    solarNoon: Math.round(toLocal(noonUTC))
  };
}

/**
 * 时段判定（5.1.2）。优先级：深夜 > 蓝调 > 黄金 > 正午强光 > 黄昏黎明 > 日间。
 * @param {number} m 当地时间分钟数（0-1439）
 * @param {{sunrise:number|null, sunset:number|null}} sun sunTimes 结果
 */
function classifyPeriod(m, sun) {
  const LATE_NIGHT_START = 22 * 60;
  const LATE_NIGHT_END = 5 * 60;
  const mod = (x) => ((x % 1440) + 1440) % 1440;
  // 支持跨午夜的区间判断
  const inRange = (x, a, b) => (a <= b ? x >= a && x < b : x >= a || x < b);

  if (m >= LATE_NIGHT_START || m < LATE_NIGHT_END) return 'lateNight';

  const sr = sun && sun.sunrise;
  const ss = sun && sun.sunset;
  if (sr == null || ss == null) {
    // 极夜等异常：按钟点粗略划分
    if (m >= 11 * 60 && m < 14 * 60) return 'noonStrong';
    if (m >= 18 * 60 || m < 6 * 60) return 'dusk';
    return 'morningAfternoon';
  }

  // 蓝调：日出前30min / 日落后30min
  if (inRange(m, mod(sr - 30), sr)) return 'blueHour';
  if (inRange(m, ss, mod(ss + 30))) return 'blueHour';
  // 黄金：日出后1h / 日落前1h
  if (inRange(m, sr, mod(sr + 60))) return 'goldenHour';
  if (inRange(m, mod(ss - 60), ss)) return 'goldenHour';
  // 正午强光（文档固定 11:00-14:00）
  if (m >= 11 * 60 && m < 14 * 60) return 'noonStrong';
  // 黄昏/黎明：日落后30min至深夜前；深夜结束至蓝调开始前（仅当区间存在，如冬季日出晚）
  if (inRange(m, mod(ss + 30), LATE_NIGHT_START)) return 'dusk';
  if (sr - 30 > LATE_NIGHT_END && m >= LATE_NIGHT_END && m < sr - 30) return 'dusk';

  return 'morningAfternoon';
}

// 季节判定（5.1.3：夏6-8月，冬12-2月）
function getSeason(date) {
  const month = date.getMonth() + 1;
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

module.exports = { sunTimes, classifyPeriod, getSeason, fallbackSunTimes };
