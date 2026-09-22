/**
 * 环境感知服务（文档 2.1、6.1）。
 *
 * 数据获取与降级链：
 *   定位：wx.getLocation，失败 → 手动城市 / 纯画面模式
 *   天气：和风天气 GeoAPI 反查城市 → 实时天气；按城市缓存 1 小时；
 *         请求失败复用过期缓存；完全不可用 → 按时段估算（夜间/日间）
 *   时间季节：系统时间（支持手动覆盖）+ solar.js 时段判定
 * 手动模式（设置页开启）优先级最高。
 *
 * 说明：文档提到的"IP 定位兜底"需要服务端支持，V1.0 无后端，以手动选择城市替代。
 */

const config = require('../config/config');
const solar = require('./solar');
const store = require('./store');

const CACHE_PREFIX = 'cam_weather_';

function hasApiKey() {
  return !!(config.weather && config.weather.apiKey);
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      success: (res) => {
        if (res.statusCode === 200 && res.data) resolve(res.data);
        else reject(new Error('HTTP ' + res.statusCode));
      },
      fail: (err) => reject(err)
    });
  });
}

function getLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => resolve({ latitude: res.latitude, longitude: res.longitude }),
      fail: (err) => reject(err)
    });
  });
}

// GeoAPI：坐标/城市名 → {id, name}
function lookupCity(query) {
  const url = config.weather.apiHost + '/geo/v2/city/lookup?location='
    + encodeURIComponent(query) + '&number=1&lang=zh&key=' + config.weather.apiKey;
  return requestJson(url).then((data) => {
    if (data && data.code === '200' && data.location && data.location.length) {
      const loc = data.location[0];
      return { id: loc.id, name: loc.name };
    }
    return null;
  });
}

// 实时天气：{icon, temp}
function fetchWeatherNow(cityId) {
  const url = config.weather.apiHost + '/v7/weather/now?location='
    + cityId + '&lang=zh&key=' + config.weather.apiKey;
  return requestJson(url).then((data) => {
    if (data && data.code === '200' && data.now) {
      return { icon: data.now.icon, temp: data.now.temp };
    }
    throw new Error('weather code ' + (data && data.code));
  });
}

// 和风 icon 码 → 内部天气类型（附录A 七类）
function mapQWeatherIcon(icon) {
  const code = parseInt(icon, 10) || 0;
  if (code === 100 || code === 150) return 'sunny';
  if ([101, 102, 103, 151, 152, 153].indexOf(code) >= 0) return 'cloudy';
  if (code === 104 || code === 154) return 'overcast';
  if (code >= 300 && code < 400) return 'rainy';
  if (code >= 400 && code < 500) return 'snowy';
  if ((code >= 500 && code <= 515) || code === 900) return 'foggy';
  return 'cloudy';
}

function readCache(cityId) {
  try {
    return wx.getStorageSync(CACHE_PREFIX + cityId) || null;
  } catch (e) {
    return null;
  }
}

function writeCache(cityId, cityName, weather) {
  try {
    wx.setStorageSync(CACHE_PREFIX + cityId, { ts: Date.now(), cityId, cityName, icon: weather.icon, temp: weather.temp });
  } catch (e) { /* 存储失败不影响主流程 */ }
}

// 天气获取：新鲜缓存 → 请求 → 过期缓存兜底（6.1.2 失败兜底）
function getWeatherWithCache(city) {
  const cached = readCache(city.id);
  if (cached && Date.now() - cached.ts < config.weather.cacheTtl) {
    return Promise.resolve({ icon: cached.icon, temp: cached.temp, source: 'cache' });
  }
  return fetchWeatherNow(city.id).then((w) => {
    writeCache(city.id, city.name, w);
    return { icon: w.icon, temp: w.temp, source: 'api' };
  }).catch(() => {
    if (cached) return Promise.resolve({ icon: cached.icon, temp: cached.temp, source: 'cache' });
    return Promise.resolve(null);
  });
}

/**
 * 组装环境数据（异步，一次调用完成定位/天气/时段/季节）。
 * 返回 {date, city, weather, weatherSource, temperature, latitude, longitude, period, season, sun}
 * weatherSource: manual | api | cache | estimated | none
 */
function getEnvironment(settings) {
  const s = settings || store.getSettings();
  const manual = s.manualEnv || {};
  const result = {
    date: new Date(),
    city: null,
    weather: null,
    weatherSource: 'none',
    temperature: null,
    latitude: null,
    longitude: null,
    rawWeather: null,
    period: 'morningAfternoon',
    season: 'spring',
    sun: solar.fallbackSunTimes()
  };

  const coordsPromise = manual.enabled ? Promise.resolve(null) : getLocation().catch(() => null);

  return coordsPromise.then((coords) => {
    if (coords) {
      result.latitude = coords.latitude;
      result.longitude = coords.longitude;
    }

    // 手动指定天气：直接生效
    if (manual.enabled && manual.weather) {
      result.weather = manual.weather;
      result.weatherSource = 'manual';
      if (manual.city) result.city = manual.city;
      return null;
    }

    // 城市解析：手动城市（手动模式）或坐标反查
    let cityPromise = Promise.resolve(null);
    if (hasApiKey()) {
      if (manual.enabled && manual.city) {
        cityPromise = lookupCity(manual.city).catch(() => null);
      } else if (coords) {
        cityPromise = lookupCity(coords.longitude + ',' + coords.latitude).catch(() => null);
      }
    }

    return cityPromise.then((city) => {
      if (!city) return null;
      result.city = city.name;
      return getWeatherWithCache(city).then((w) => {
        if (w) {
          result.rawWeather = w;
          result.weatherSource = w.source;
          if (w.temp != null) result.temperature = w.temp;
        }
        return null;
      });
    });
  }).then(() => {
    // 时间（支持手动覆盖）与时段/季节判定
    let effDate = new Date();
    if (manual.enabled && manual.datetime) {
      const parsed = new Date(String(manual.datetime).replace(/-/g, '/'));
      if (!isNaN(parsed.getTime())) effDate = parsed;
    }
    result.date = effDate;

    const sun = result.latitude != null
      ? solar.sunTimes(effDate, result.latitude, result.longitude)
      : solar.fallbackSunTimes();
    result.sun = sun;
    const minuteOfDay = effDate.getHours() * 60 + effDate.getMinutes();
    result.period = solar.classifyPeriod(minuteOfDay, sun);
    result.season = solar.getSeason(effDate);

    // 天气决策：手动 > API/缓存 > 时段估算
    if (!result.weather) {
      if (result.rawWeather) {
        let weather = mapQWeatherIcon(result.rawWeather.icon);
        // 夜间晴/多云按"夜间"处理（附录A 天气类型含夜间）
        if ((result.period === 'lateNight' || result.period === 'blueHour')
          && (weather === 'sunny' || weather === 'cloudy')) {
          weather = 'night';
        }
        result.weather = weather;
      } else {
        result.weather = (result.period === 'lateNight' || result.period === 'blueHour') ? 'night' : 'sunny';
        result.weatherSource = 'estimated';
      }
    }
    return result;
  });
}

module.exports = {
  getEnvironment,
  getLocation,
  lookupCity,
  fetchWeatherNow,
  mapQWeatherIcon
};
