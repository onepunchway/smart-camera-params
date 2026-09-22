/**
 * 智能参数生成引擎（纯函数，可在 Node 中单测）。
 *
 * 计算链路（对应开发文档第五章）：
 *   基础EV   = 天气基准EV + 时段修正EV + 季节修正EV
 *   画面EV   = 基础EV + 亮度修正EV + 光比附加修正EV
 *   目标EV   = 基础EV×环境权重 + 画面EV×画面权重（|画面修正|>2 时强制 0.2/0.8）
 *   参数映射 = EV100 → ISO/光圈/快门（ISO 优先，快门钳制 1/4000~1/30，残差进曝光补偿）
 *   白平衡   = 环境色温×0.5 + 画面估算色温×0.5
 *   输出稳定 = EMA 平滑（0.7/0.3）+ 测光模式滞回（连续5帧）
 *
 * 说明：文档附录B 的 EV-参数对照表与 EV 物理定义不自洽，本引擎按物理公式
 *   EV100 = log2(N²/t)（ISO100）实现，与"阳光16法则"锚点一致（文档 5.1 要求物理逻辑自洽）。
 */

const rules = require('./rules');
const util = require('./util');

const METERING_LABEL = { matrix: '评价测光', center: '中央重点测光', spot: '点测光' };
const METERING_DESC = {
  matrix: '画面整体平均测光，适合光照均匀的场景',
  center: '偏重画面中心区域测光，适合主体居中的场景',
  spot: '仅对画面小范围测光，适合逆光、大光比场景'
};

/** 基础EV（天气+时段+季节） */
function computeBaseEV(weather, period, season) {
  const w = weather || 'sunny';
  return rules.WEATHER_BASE_EV[w]
    + rules.TIME_PERIOD_CORRECTION[period].ev
    + rules.SEASON_CORRECTION[season];
}

/** 画面修正EV = 亮度区间修正 + 光比附加修正，同时给出测光模式建议（5.2） */
function computeImageCorrection(frameStats) {
  const brightnessCorr = rules.brightnessCorrectionEV(frameStats.avgBrightness);
  let lightRatioAdj = 0;
  let metering = 'center';

  if (frameStats.highlightRatio > rules.HIGHLIGHT_RATIO_LIMIT) {
    lightRatioAdj = -rules.LIGHT_RATIO_ADJUST_EV;
    metering = 'spot';
  } else if (frameStats.shadowRatio > rules.SHADOW_RATIO_LIMIT) {
    lightRatioAdj = rules.LIGHT_RATIO_ADJUST_EV;
    metering = 'matrix';
  } else {
    // 无极端占比时按分区光比（最亮格/最暗格）推荐
    const ratio = frameStats.contrastRatio || 1;
    if (ratio > 4) metering = 'spot';
    else if (ratio > 2) metering = 'center';
    else metering = 'matrix';
  }

  return {
    ev: brightnessCorr + lightRatioAdj,
    brightnessCorr,
    lightRatioAdj,
    metering
  };
}

/** 融合权重（5.3）：|画面修正|>2 视为非典型场景，强制画面权重 0.8 */
function fusionWeights(imageCorrection) {
  const diff = Math.abs(imageCorrection);
  if (diff > rules.FUSION.atypicalDiff) {
    return { env: rules.FUSION.envWeightAtypical, image: 1 - rules.FUSION.envWeightAtypical };
  }
  return { env: rules.FUSION.envWeightTypical, image: 1 - rules.FUSION.envWeightTypical };
}

/** 在 ISO_STOPS 中找比 iso 高一档且不超过 cap 的档位 */
function nextIsoStopAbove(iso, cap) {
  for (let i = 0; i < rules.ISO_STOPS.length; i++) {
    const s = rules.ISO_STOPS[i];
    if (s > iso && s <= cap + 1e-9) return s;
  }
  return null;
}

/**
 * EV100 → 参数组合（5.4）。
 * 顺序：最低原生ISO → 调光圈 → 调快门（钳制 1/4000~1/30），残差由曝光补偿吸收（步进0.3）。
 * @param {number} targetEV 目标EV100
 * @param {object} device 设备档案（rules.DEFAULT_DEVICE）
 * @param {{extremeBright?:boolean, extremeDark?:boolean}} flags 极端场景标记（6.4）
 */
function mapParams(targetEV, device, flags) {
  device = device || rules.DEFAULT_DEVICE;
  flags = flags || {};

  const isoMin = Math.max(rules.LIMITS.iso.min, device.nativeIsoMin || rules.LIMITS.iso.min);
  const isoMax = Math.min(rules.LIMITS.iso.max, device.isoMax || rules.LIMITS.iso.max);
  // 极暗场景：ISO 上限压到设备原生上限的 2/3（取标准档）
  let isoCap = isoMax;
  if (flags.extremeDark) {
    const cap = isoMax * 2 / 3;
    for (let i = rules.ISO_STOPS.length - 1; i >= 0; i--) {
      if (rules.ISO_STOPS[i] <= cap) { isoCap = rules.ISO_STOPS[i]; break; }
    }
  }

  const fStops = rules.APERTURE_STOPS.filter((f) =>
    f >= (device.apertureMin || rules.APERTURE_STOPS[0]) - 1e-9
    && f <= (device.apertureMax || rules.APERTURE_STOPS[rules.APERTURE_STOPS.length - 1]) + 1e-9);

  const twoPowEV = Math.pow(2, targetEV);
  const solveT = (f, iso) => (f * f * 100) / (twoPowEV * iso);

  let iso = isoMin;
  let aperture = util.nearestByLog(util.clamp(device.defaultAperture || 4, fStops[0], fStops[fStops.length - 1]), fStops);
  let t = solveT(aperture, iso);
  let guard = 0;

  if (flags.extremeBright) {
    // 极亮兜底：强制最低ISO + 最快快门，光圈按公式反解，曝光补偿 -1EV 起步
    t = rules.LIMITS.shutter.fastest;
    const f = Math.sqrt(twoPowEV * t * iso / 100);
    aperture = util.nearestByLog(util.clamp(f, fStops[0], fStops[fStops.length - 1]), fStops);
  } else {
    // 过快（过亮）：先收小光圈，仍过快则后面钳制到最快快门
    while (t < rules.LIMITS.shutter.fastest && guard++ < 20) {
      const idx = fStops.indexOf(aperture);
      if (idx < fStops.length - 1) {
        aperture = fStops[idx + 1];
        t = solveT(aperture, iso);
      } else break;
    }
    // 过慢（过暗）：先开大光圈，再逐档升ISO
    guard = 0;
    while (t > rules.LIMITS.shutter.slowestHandheld && guard++ < 20) {
      const idx = fStops.indexOf(aperture);
      if (idx > 0) {
        aperture = fStops[idx - 1];
        t = solveT(aperture, iso);
        continue;
      }
      const nextIso = nextIsoStopAbove(iso, isoCap);
      if (nextIso) {
        iso = nextIso;
        t = solveT(aperture, iso);
        continue;
      }
      break;
    }
  }

  // 快门钳制到硬边界并吸附标准档位
  const tClamped = util.clamp(t, rules.LIMITS.shutter.fastest, rules.LIMITS.shutter.slowestHandheld);
  const shutter = util.nearestByLog(tClamped, rules.SHUTTER_STOPS);

  // 残差 → 曝光补偿
  const achievedEV = Math.log2((aperture * aperture) / shutter) - Math.log2(iso / 100);
  let evComp = util.roundTo(targetEV - achievedEV, rules.LIMITS.exposureComp.step);
  evComp = util.clamp(evComp, rules.LIMITS.exposureComp.min, rules.LIMITS.exposureComp.max);
  if (flags.extremeBright) evComp = Math.min(evComp, rules.EXTREME.brightCompStart);

  const qualityWarn = iso > rules.LIMITS.iso.qualityWarnAbove;
  const tripodHint = !!flags.extremeDark
    || (shutter >= rules.LIMITS.shutter.slowestHandheld * 0.999 && targetEV - achievedEV > 0.05);

  return {
    iso,
    aperture,
    shutter,
    evComp,
    qualityWarn,
    tripodHint,
    apertureAtWidest: fStops.indexOf(aperture) === 0,
    apertureAtNarrowest: fStops.indexOf(aperture) === fStops.length - 1
  };
}

/** 白平衡（5.4.2 / 6.2.3）：环境色温×0.5 + 画面色温×0.5，画面偏色干扰时锁定环境色温 */
function computeWhiteBalance(weather, period, frameStats) {
  const w = weather || 'sunny';
  const baseColorTemp = rules.WEATHER_COLOR_TEMP[w] + rules.TIME_PERIOD_CORRECTION[period].colorTemp;

  let final = baseColorTemp;
  let frameColorTemp = null;
  let colorLocked = false;
  if (frameStats && frameStats.colorTemp != null && frameStats.colorReliable !== false) {
    frameColorTemp = frameStats.colorTemp;
    final = baseColorTemp * rules.WB.envWeight + frameColorTemp * rules.WB.frameWeight;
  } else if (frameStats && frameStats.colorTemp != null && frameStats.colorReliable === false) {
    colorLocked = true;
  }
  return {
    colorTemp: util.clamp(Math.round(final / 50) * 50, rules.LIMITS.whiteBalance.min, rules.LIMITS.whiteBalance.max),
    baseColorTemp,
    frameColorTemp,
    colorLocked
  };
}

/**
 * 主入口：融合环境数据与画面统计，输出完整推荐。
 * @param {object|null} env 环境数据 {weather, period, season, city, weatherSource...}，null 为纯画面模式
 * @param {object|null} frameStats 画面分析结果，null 为纯环境模式（相机不可用）
 * @param {object|null} state 上一帧引擎状态 {rawEV, metering, meteringStreak}
 * @param {object} [device] 设备档案
 */
function computeRecommendation(env, frameStats, state, device) {
  device = device || rules.DEFAULT_DEVICE;
  env = env || {};
  const period = env.period || 'morningAfternoon';
  const season = env.season || 'spring';
  const weatherKnown = !!env.weather;
  const weather = env.weather || null;
  const hasFrame = !!frameStats;

  // 1. 基础EV
  let baseEV;
  if (weatherKnown) {
    baseEV = computeBaseEV(weather, period, season);
  } else {
    // 纯画面模式：室内/日常照度先验 + 时段/季节修正
    baseEV = rules.FUSION.imageOnlyPriorEV
      + rules.TIME_PERIOD_CORRECTION[period].ev
      + rules.SEASON_CORRECTION[season];
  }

  // 2. 画面修正EV
  let imageCorrection = { ev: 0, brightnessCorr: 0, lightRatioAdj: 0, metering: 'center' };
  if (hasFrame) imageCorrection = computeImageCorrection(frameStats);
  const imageEV = baseEV + imageCorrection.ev;

  // 3. 动态权重融合
  let weights;
  if (!hasFrame) weights = { env: 1, image: 0 };              // 纯环境模式（相机不可用）
  else if (!weatherKnown) weights = { env: 0, image: 1 };     // 纯画面模式（环境不可用）
  else weights = fusionWeights(imageCorrection.ev);
  let targetEV = baseEV * weights.env + imageEV * weights.image;

  // 4. 设备校准偏移 + 防御性钳制
  targetEV += device.evOffset || 0;
  targetEV = util.clamp(targetEV, rules.LIMITS.targetEV.min, rules.LIMITS.targetEV.max);

  // 5. EMA 平滑（6.5.1）
  const rawEV = state && typeof state.rawEV === 'number'
    ? util.ema(state.rawEV, targetEV, rules.SMOOTH.emaPrevWeight)
    : targetEV;

  // 6. 极端场景兜底（6.4）
  const flags = {
    extremeBright: hasFrame && frameStats.avgBrightness > rules.EXTREME.brightBrightness,
    extremeDark: hasFrame && frameStats.avgBrightness < rules.EXTREME.darkBrightness
  };

  // 7. 参数映射
  const mapped = mapParams(rawEV, device, flags);

  // 8. 测光模式滞回（6.5.2）：连续5帧满足条件才切换
  const suggest = imageCorrection.metering;
  let confirmed = (state && state.metering) || suggest;
  let meteringStreak = (state && state.meteringStreak) || 0;
  if (suggest !== confirmed) {
    meteringStreak += 1;
    if (meteringStreak >= rules.SMOOTH.hysteresisFrames) {
      confirmed = suggest;
      meteringStreak = 0;
    }
  } else {
    meteringStreak = 0;
  }
  const metering = confirmed;

  // 9. 白平衡
  const wb = computeWhiteBalance(weather, period, frameStats);

  // 10. 推荐理由与警告（1.4 可解释性）
  const weatherText = weatherKnown ? rules.weatherLabel(weather) : '环境未知';
  const periodText = rules.TIME_PERIOD_CORRECTION[period].label;
  const seasonText = rules.SEASON_LABEL[season] + '季';
  const zoneText = hasFrame ? rules.brightnessZone(frameStats.avgBrightness) : '';
  const corrText = (imageCorrection.ev >= 0 ? '+' : '') + imageCorrection.ev.toFixed(1);

  const reasons = {
    ev: '基础EV ' + baseEV.toFixed(1) + '（' + weatherText + ' · ' + periodText + ' · ' + seasonText + '）'
      + (hasFrame ? '；画面亮度 ' + Math.round(frameStats.avgBrightness) + '（' + zoneText + '），画面修正 ' + corrText + 'EV' : '')
      + (device.evOffset ? '；含设备校准 ' + (device.evOffset > 0 ? '+' : '') + device.evOffset.toFixed(1) + 'EV' : ''),
    iso: mapped.iso === Math.max(rules.LIMITS.iso.min, device.nativeIsoMin)
      ? 'ISO 优先保证画质：光线充足，使用最低原生 ISO'
      : '光线较弱：逐档提升 ISO 至 ' + mapped.iso + '，保证手持安全快门' + (mapped.qualityWarn ? '（已超3200，画质会下降）' : ''),
    shutter: '快门 ' + util.formatShutter(mapped.shutter) + '，手持安全下限 1/30s'
      + (mapped.tripodHint ? '；已接近下限，建议使用三脚架' : ''),
    aperture: flags.extremeBright
      ? '光线过强：光圈 ' + util.formatAperture(mapped.aperture) + ' 配合最快快门防止过曝'
      : (mapped.apertureAtWidest && !flags.extremeDark
        ? '光圈 ' + util.formatAperture(mapped.aperture) + '，兼顾进光量与景深'
        : (flags.extremeDark || mapped.apertureAtWidest
          ? '开大光圈至 ' + util.formatAperture(mapped.aperture) + '，增加进光量'
          : '光圈 ' + util.formatAperture(mapped.aperture) + '，平衡画质与景深')),
    evComp: Math.abs(mapped.evComp) < 1e-6
      ? '当前组合可准确曝光，无需补偿'
      : '参数已达硬件边界，曝光补偿 ' + util.formatEvComp(mapped.evComp) + ' 吸收残差',
    wb: '环境色温约 ' + Math.round(wb.baseColorTemp) + 'K（' + weatherText + ' · ' + periodText + '）'
      + (wb.frameColorTemp != null ? '，融合画面色温 ' + Math.round(wb.frameColorTemp) + 'K' : '')
      + (wb.colorLocked ? '；画面色彩饱和度过高，已锁定环境色温避免偏色误导' : ''),
    metering: METERING_DESC[metering]
  };

  const warnings = [];
  if (flags.extremeBright) warnings.push('光线过强：已强制最低ISO与最快快门，曝光补偿 -1EV 起步');
  if (flags.extremeDark) warnings.push('光线极弱：ISO 已限制在原生上限 2/3 内，建议使用三脚架');
  if (mapped.qualityWarn && !flags.extremeDark) warnings.push('ISO 超过 3200，画质可能明显下降');
  if (wb.colorLocked) warnings.push('画面色彩过于鲜艳，白平衡已锁定环境基准');
  if (!weatherKnown) warnings.push('环境数据不可用：完全基于画面分析计算，可在设置中手动配置');
  if (env.weatherSource === 'estimated') warnings.push('天气为按时段估算值，可在设置中手动修正');

  return {
    params: {
      iso: mapped.iso,
      shutter: mapped.shutter,
      aperture: mapped.aperture,
      evComp: mapped.evComp,
      colorTemp: wb.colorTemp,
      metering,
      qualityWarn: mapped.qualityWarn,
      tripodHint: mapped.tripodHint
    },
    texts: {
      isoText: String(mapped.iso),
      shutterText: util.formatShutter(mapped.shutter),
      apertureText: util.formatAperture(mapped.aperture),
      evCompText: util.formatEvComp(mapped.evComp),
      wbText: util.formatColorTemp(wb.colorTemp),
      meteringText: METERING_LABEL[metering]
    },
    reasons,
    warnings,
    state: { rawEV, metering, meteringStreak },
    meta: {
      baseEV,
      imageEV,
      imageCorrection: imageCorrection.ev,
      targetEV: rawEV,
      envWeight: weights.env,
      flags,
      weatherKnown,
      hasFrame
    }
  };
}

module.exports = {
  computeRecommendation,
  computeBaseEV,
  computeImageCorrection,
  computeWhiteBalance,
  mapParams,
  fusionWeights,
  METERING_LABEL,
  METERING_DESC
};
