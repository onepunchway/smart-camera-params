/**
 * 参数规则表 —— 所有可调规则集中于此，便于快速迭代。
 * 对应开发文档：5.1 EV基准体系、5.2 画面分析修正、5.3 融合权重、5.4.3 硬边界、6.4 降级兜底、附录A。
 */

// ---------- 天气基准（以正午、春秋季、ISO100 为基准） ----------
const WEATHER_BASE_EV = {
  sunny: 15,     // 阳光16法则：f/16、约1/125s
  cloudy: 14,
  overcast: 13,
  rainy: 12,
  foggy: 12.5,
  snowy: 16,     // 雪地反光强
  night: 6
};

// 天气基准色温（K），附录A
const WEATHER_COLOR_TEMP = {
  sunny: 5200,
  cloudy: 5600,
  overcast: 6500,
  rainy: 6000,
  foggy: 5800,
  snowy: 5500,
  night: 4200
};

// ---------- 时段修正（5.1.2） ----------
const TIME_PERIOD_CORRECTION = {
  goldenHour:       { ev: -0.5, colorTemp: -300,  label: '黄金时刻' },
  blueHour:         { ev: -1.5, colorTemp: 1000,  label: '蓝调时刻' },
  noonStrong:       { ev: 0.7,  colorTemp: 0,     label: '正午强光' },
  morningAfternoon: { ev: 0,    colorTemp: 0,     label: '日间' },
  dusk:             { ev: -1,   colorTemp: -200,  label: '黄昏黎明' },
  lateNight:        { ev: -2,   colorTemp: -1000, label: '深夜' }
};

// ---------- 季节修正（5.1.3） ----------
const SEASON_CORRECTION = { spring: 0, summer: 0.3, autumn: 0, winter: -0.3 };
const SEASON_LABEL = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };

// ---------- 画面亮度修正（5.2） ----------
// 平均亮度（0-255）→ 曝光修正EV
function brightnessCorrectionEV(avgBrightness) {
  if (avgBrightness < 40) return 1.3;    // 严重欠曝
  if (avgBrightness < 60) return 0.7;    // 轻度欠曝
  if (avgBrightness <= 180) return 0;    // 曝光正常
  if (avgBrightness <= 210) return -0.7; // 轻度过曝
  return -1.3;                           // 严重过曝
}

function brightnessZone(avgBrightness) {
  if (avgBrightness < 40) return '严重欠曝';
  if (avgBrightness < 60) return '轻度欠曝';
  if (avgBrightness <= 180) return '曝光正常';
  if (avgBrightness <= 210) return '轻度过曝';
  return '严重过曝';
}

// 高光/暗部像素判定阈值（Y值）与占比阈值（5.2.3）
const HIGHLIGHT_PIXEL_Y = 210;
const SHADOW_PIXEL_Y = 40;
const HIGHLIGHT_RATIO_LIMIT = 0.30; // 高光占比>30%：追加-0.5EV，推荐点测光
const SHADOW_RATIO_LIMIT = 0.40;    // 暗部占比>40%：追加+0.5EV，推荐评价测光
const LIGHT_RATIO_ADJUST_EV = 0.5;

// ---------- 极端场景兜底（6.4） ----------
const EXTREME = {
  brightBrightness: 240,
  darkBrightness: 30,
  brightCompStart: -1.0
};

// ---------- 融合权重（5.3） ----------
const FUSION = {
  envWeightTypical: 0.6,
  envWeightAtypical: 0.2,
  atypicalDiff: 2,
  // 纯画面分析模式（定位+天气均不可用）时的基础EV先验：典型室内/日常照度
  imageOnlyPriorEV: 12
};

// ---------- 输出稳定（6.5） ----------
const SMOOTH = {
  emaPrevWeight: 0.7,
  emaCurWeight: 0.3,
  hysteresisFrames: 5
};

// ---------- 硬边界（5.4.3） ----------
const LIMITS = {
  iso: { min: 50, max: 6400, qualityWarnAbove: 3200 },
  shutter: { fastest: 1 / 4000, slowestHandheld: 1 / 30 },
  exposureComp: { min: -3.0, max: 3.0, step: 0.3 },
  whiteBalance: { min: 2000, max: 10000 },
  // 目标EV整体钳制范围，防御异常输入
  targetEV: { min: 2, max: 17 }
};

// ---------- 设备档案默认值（6.3，可按机型扩展覆盖） ----------
const DEFAULT_DEVICE = {
  nativeIsoMin: 100,
  isoMax: 6400,
  apertureMin: 1.8,
  apertureMax: 16,
  defaultAperture: 4.0,
  evOffset: 0 // 用户校准的EV偏移（设置页可调）
};

// ---------- 标准档位 ----------
const ISO_STOPS = [50, 100, 200, 400, 800, 1600, 3200, 6400];
const APERTURE_STOPS = [1.8, 2, 2.8, 4, 5.6, 8, 11, 16];
const SHUTTER_STOPS = [1 / 4000, 1 / 2000, 1 / 1000, 1 / 500, 1 / 250, 1 / 125, 1 / 60, 1 / 30];

// ---------- 白平衡（5.4.2 / 6.2.3） ----------
const WB = {
  envWeight: 0.5,
  frameWeight: 0.5,
  // 画面主色饱和度超过该值视为偏色干扰，锁定环境色温
  saturationUnreliable: 0.6,
  neutralAnchorK: 6500 // RGB 比值法的中性色温锚点
};

// ---------- 天气选项（设置页/展示用） ----------
const WEATHER_OPTIONS = [
  { key: 'sunny', label: '晴天', icon: '☀️' },
  { key: 'cloudy', label: '多云', icon: '⛅' },
  { key: 'overcast', label: '阴天', icon: '☁️' },
  { key: 'rainy', label: '雨天', icon: '🌧' },
  { key: 'foggy', label: '雾天', icon: '🌫' },
  { key: 'snowy', label: '雪天', icon: '❄️' },
  { key: 'night', label: '夜间', icon: '🌙' }
];

function weatherLabel(key) {
  const found = WEATHER_OPTIONS.find((w) => w.key === key);
  return found ? found.label : '未知';
}

function weatherIcon(key) {
  const found = WEATHER_OPTIONS.find((w) => w.key === key);
  return found ? found.icon : '🌤';
}

module.exports = {
  WEATHER_BASE_EV,
  WEATHER_COLOR_TEMP,
  TIME_PERIOD_CORRECTION,
  SEASON_CORRECTION,
  SEASON_LABEL,
  brightnessCorrectionEV,
  brightnessZone,
  HIGHLIGHT_PIXEL_Y,
  SHADOW_PIXEL_Y,
  HIGHLIGHT_RATIO_LIMIT,
  SHADOW_RATIO_LIMIT,
  LIGHT_RATIO_ADJUST_EV,
  EXTREME,
  FUSION,
  SMOOTH,
  LIMITS,
  DEFAULT_DEVICE,
  ISO_STOPS,
  APERTURE_STOPS,
  SHUTTER_STOPS,
  WB,
  WEATHER_OPTIONS,
  weatherLabel,
  weatherIcon
};
