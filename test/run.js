/**
 * 单元测试：参数引擎 / 画面分析 / 太阳时段 / 工具函数。
 * 运行：node test/run.js
 * 仅覆盖纯逻辑模块（页面与 wx API 需在微信开发者工具中人工验收）。
 */

const assert = require('assert');
const rules = require('../utils/rules');
const engine = require('../utils/param-engine');
const solar = require('../utils/solar');
const util = require('../utils/util');
const analyzerMod = require('../utils/image-analyzer');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name + '\n      ' + e.message);
    console.log('  ✗ ' + name);
    console.log('      ' + e.message);
  }
}

function close(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= tol, (label || 'value') + ' 期望 ' + expected + '±' + tol + '，实际 ' + actual);
}

function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, (label || 'value') + ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function ok(cond, label) {
  assert.ok(cond, label || '条件不成立');
}

// ---------- 构造辅助 ----------
const envOf = (weather, period, season) => ({ weather, period, season, city: '测试', weatherSource: 'api' });

function statsOf(avgBrightness, opts) {
  const o = opts || {};
  return {
    avgBrightness,
    highlightRatio: o.highlightRatio || 0,
    shadowRatio: o.shadowRatio || 0,
    contrastRatio: o.contrastRatio || 1,
    colorTemp: o.colorTemp != null ? o.colorTemp : null,
    colorReliable: o.colorReliable !== false,
    shaking: false,
    gridMeans: []
  };
}

const D = rules.DEFAULT_DEVICE;

console.log('\n[1] 基础EV计算（5.1）');
test('晴天+日间+春 = 15（阳光16法则锚点）', () => {
  close(engine.computeBaseEV('sunny', 'morningAfternoon', 'spring'), 15, 1e-9);
});
test('晴天+正午强光+夏 = 16', () => {
  close(engine.computeBaseEV('sunny', 'noonStrong', 'summer'), 16, 1e-9);
});
test('雪天+正午强光+冬 = 16.4', () => {
  close(engine.computeBaseEV('snowy', 'noonStrong', 'winter'), 16.4, 1e-9);
});
test('夜间+深夜+冬 = 3.7', () => {
  close(engine.computeBaseEV('night', 'lateNight', 'winter'), 3.7, 1e-9);
});
test('多云+黄昏+春 = 13', () => {
  close(engine.computeBaseEV('cloudy', 'dusk', 'spring'), 13, 1e-9);
});

console.log('\n[2] 亮度区间映射（5.2.2）');
test('20→+1.3、50→+0.7、120→0、195→-0.7、230→-1.3', () => {
  close(rules.brightnessCorrectionEV(20), 1.3, 1e-9, '20');
  close(rules.brightnessCorrectionEV(50), 0.7, 1e-9, '50');
  close(rules.brightnessCorrectionEV(120), 0, 1e-9, '120');
  close(rules.brightnessCorrectionEV(195), -0.7, 1e-9, '195');
  close(rules.brightnessCorrectionEV(230), -1.3, 1e-9, '230');
});

console.log('\n[3] 融合权重与推荐EV（5.3）');
test('典型场景权重 0.6/0.4，非典型（|修正|>2）强制 0.2/0.8', () => {
  close(engine.fusionWeights(1).env, 0.6, 1e-9);
  close(engine.fusionWeights(3).env, 0.2, 1e-9);
});
test('晴天+正常亮度120 → 目标EV 15（无修正）', () => {
  const rec = engine.computeRecommendation(envOf('sunny', 'morningAfternoon', 'spring'), statsOf(120), null);
  close(rec.meta.targetEV, 15, 1e-6, 'targetEV');
});
test('画面偏暗(30) → 修正+1.3，目标EV = 15+1.3×0.4 = 15.52', () => {
  const rec = engine.computeRecommendation(envOf('sunny', 'morningAfternoon', 'spring'), statsOf(30), null);
  close(rec.meta.targetEV, 15.52, 1e-6, 'targetEV');
});
test('高光占比35% → 修正-0.5EV，推荐点测光', () => {
  const rec = engine.computeRecommendation(envOf('sunny', 'morningAfternoon', 'spring'), statsOf(120, { highlightRatio: 0.35 }), null);
  close(rec.meta.targetEV, 15 - 0.5 * 0.4, 1e-6, 'targetEV');
  eq(rec.params.metering, 'spot', '测光模式');
});
test('暗部占比45% → 修正+0.5EV，推荐评价测光', () => {
  const rec = engine.computeRecommendation(envOf('sunny', 'morningAfternoon', 'spring'), statsOf(120, { shadowRatio: 0.45 }), null);
  close(rec.meta.targetEV, 15 + 0.5 * 0.4, 1e-6, 'targetEV');
  eq(rec.params.metering, 'matrix', '测光模式');
});
test('纯画面模式（环境全不可用）→ 先验EV12为基准', () => {
  const rec = engine.computeRecommendation(null, statsOf(120), null);
  close(rec.meta.targetEV, 12, 1e-6, 'targetEV');
  close(rec.meta.envWeight, 0, 1e-9, 'envWeight');
});
test('纯环境模式（相机不可用）→ 环境权重1', () => {
  const rec = engine.computeRecommendation(envOf('sunny', 'morningAfternoon', 'spring'), null, null);
  close(rec.meta.envWeight, 1, 1e-9, 'envWeight');
  close(rec.meta.targetEV, 15, 1e-6, 'targetEV');
});

console.log('\n[4] EV→参数映射（5.4，物理公式 EV100=log2(N²/t)）');
test('EV15 → ISO100 f/4 1/2000s 无补偿', () => {
  const m = engine.mapParams(15, D, {});
  eq(m.iso, 100, 'ISO');
  close(m.aperture, 4, 1e-9, '光圈');
  eq(m.shutter, 1 / 2000, '快门');
  close(m.evComp, 0, 1e-9, '补偿');
});
test('EV6（夜间）→ 开大光圈+升ISO：ISO200 f/1.8 1/30s +0.3EV', () => {
  const m = engine.mapParams(6, D, {});
  eq(m.iso, 200, 'ISO');
  close(m.aperture, 1.8, 1e-9, '光圈');
  eq(m.shutter, 1 / 30, '快门');
  close(m.evComp, 0.3, 1e-9, '补偿');
});
test('EV3.7（深夜）→ ISO800 f/1.8 1/30s 无补偿', () => {
  const m = engine.mapParams(3.7, D, {});
  eq(m.iso, 800, 'ISO');
  close(m.aperture, 1.8, 1e-9, '光圈');
  eq(m.shutter, 1 / 30, '快门');
  close(m.evComp, 0, 1e-9, '补偿');
});
test('EV0（极暗不可达）→ ISO6400 1/30s，残差-0.6EV进补偿，画质警告', () => {
  const m = engine.mapParams(0, D, {});
  eq(m.iso, 6400, 'ISO');
  eq(m.shutter, 1 / 30, '快门');
  close(m.evComp, -0.6, 1e-9, '补偿');
  ok(m.qualityWarn, '应有画质警告');
});
test('EV17（过亮）→ 收小光圈：ISO100 f/8 1/2000s', () => {
  const m = engine.mapParams(17, D, {});
  eq(m.iso, 100, 'ISO');
  close(m.aperture, 8, 1e-9, '光圈');
  eq(m.shutter, 1 / 2000, '快门');
});
test('快门始终不低于安全快门1/30s、不快于1/4000s（硬边界）', () => {
  for (let ev = 2; ev <= 17; ev += 0.5) {
    const m = engine.mapParams(ev, D, {});
    ok(m.shutter <= 1 / 30 + 1e-12 && m.shutter >= 1 / 4000 - 1e-12, 'EV' + ev + ' 时快门越界: ' + m.shutter);
    ok(m.iso >= 50 && m.iso <= 6400, 'EV' + ev + ' 时ISO越界');
    ok(m.evComp >= -3 - 1e-9 && m.evComp <= 3 + 1e-9, 'EV' + ev + ' 时补偿越界');
  }
});

console.log('\n[5] 极端场景兜底（6.4）');
test('极亮(亮度250) → 强制最低ISO+最快快门，补偿-1.0起步', () => {
  const rec = engine.computeRecommendation(envOf('sunny', 'noonStrong', 'spring'), statsOf(250), null);
  eq(rec.params.iso, 100, 'ISO');
  eq(rec.params.shutter, 1 / 4000, '快门');
  close(rec.params.evComp, -1.0, 1e-9, '补偿');
  ok(rec.warnings.some((w) => w.indexOf('光线过强') >= 0), '应有光线过强警告');
});
test('极暗(亮度20) → ISO压到上限2/3内、建议三脚架', () => {
  const rec = engine.computeRecommendation(envOf('night', 'lateNight', 'winter'), statsOf(20), null);
  ok(rec.params.iso <= 3200, 'ISO应≤3200（6400的2/3取档）');
  ok(rec.params.tripodHint, '应有三脚架提示');
  ok(rec.warnings.some((w) => w.indexOf('三脚架') >= 0), '应有三脚架警告');
});

console.log('\n[6] 白平衡（5.4.2 / 6.2.3）');
test('环境色温×0.5 + 画面色温×0.5：5200与7000 → 6100K', () => {
  const rec = engine.computeRecommendation(
    envOf('sunny', 'morningAfternoon', 'spring'),
    statsOf(120, { colorTemp: 7000, colorReliable: true }), null);
  eq(rec.params.colorTemp, 6100, '色温');
});
test('画面饱和度过高（不可靠）→ 锁定环境色温 5200+蓝调1000 = 6200K', () => {
  const rec = engine.computeRecommendation(
    envOf('sunny', 'blueHour', 'spring'),
    statsOf(120, { colorTemp: 8000, colorReliable: false }), null);
  eq(rec.params.colorTemp, 6200, '色温');
});
test('夜间+深夜 → 环境色温 4200-1000 = 3200K', () => {
  const rec = engine.computeRecommendation(envOf('night', 'lateNight', 'winter'), null, null);
  eq(rec.params.colorTemp, 3200, '色温');
});
test('色温钳制在 2000-10000K', () => {
  const wb = engine.computeWhiteBalance('night', 'lateNight', { colorTemp: 2000, colorReliable: true });
  ok(wb.colorTemp >= 2000 && wb.colorTemp <= 10000, '越界: ' + wb.colorTemp);
});

console.log('\n[7] 输出稳定（6.5）');
test('EMA平滑：(10×0.7)+(12×0.3) = 10.6', () => {
  close(util.ema(10, 12, 0.7), 10.6, 1e-9);
});
test('EMA首帧直接采用当前值', () => {
  close(util.ema(undefined, 12, 0.7), 12, 1e-9);
});
test('测光模式滞回：连续5帧才切换（matrix→spot）', () => {
  const env = envOf('sunny', 'morningAfternoon', 'spring');
  let state = null;
  let rec = engine.computeRecommendation(env, statsOf(120), state); // 冷启动确认 matrix
  state = rec.state;
  eq(rec.params.metering, 'matrix', '冷启动');
  for (let i = 1; i <= 4; i++) {
    rec = engine.computeRecommendation(env, statsOf(120, { highlightRatio: 0.35 }), state);
    state = rec.state;
    eq(rec.params.metering, 'matrix', '第' + i + '帧suggestion=spot仍应保持matrix');
  }
  rec = engine.computeRecommendation(env, statsOf(120, { highlightRatio: 0.35 }), state);
  eq(rec.params.metering, 'spot', '第5帧应切换为spot');
});
test('目标EV经EMA平滑收敛（第二帧为0.7×15+0.3×15.52）', () => {
  const env = envOf('sunny', 'morningAfternoon', 'spring');
  const r1 = engine.computeRecommendation(env, statsOf(120), null);
  const r2 = engine.computeRecommendation(env, statsOf(30), r1.state);
  close(r2.meta.targetEV, 0.7 * 15 + 0.3 * 15.52, 1e-6, 'targetEV');
});

console.log('\n[8] 设备校准与边界（6.3 / 5.4.3）');
test('校准偏移+0.5EV 并入目标EV（15 → 15.5）', () => {
  const device = Object.assign({}, D, { evOffset: 0.5 });
  const rec = engine.computeRecommendation(envOf('sunny', 'morningAfternoon', 'spring'), statsOf(120), null, device);
  close(rec.meta.targetEV, 15.5, 1e-6, 'targetEV');
  ok(rec.reasons.ev.indexOf('校准') >= 0, '理由应说明校准');
});
test('自定义机型（ISO最低200、光圈f/2.8-11）映射仍在硬件范围内', () => {
  const device = Object.assign({}, D, { nativeIsoMin: 200, apertureMin: 2.8, apertureMax: 11 });
  const m = engine.mapParams(8, device, {});
  ok(m.iso >= 200, 'ISO不应低于机型下限');
  ok(m.aperture >= 2.8 - 1e-9 && m.aperture <= 11 + 1e-9, '光圈越界: ' + m.aperture);
});

console.log('\n[9] 太阳时角与时段判定（solar.js）');
test('北京 2026-06-21：日出≈4:46、日落≈19:46（±20min）', () => {
  const sun = solar.sunTimes(new Date(2026, 5, 21), 39.904, 116.407, 480);
  close(sun.sunrise, 286, 20, '日出(分钟)');
  close(sun.sunset, 1186, 20, '日落(分钟)');
});
test('北京 2026-12-21：日出≈7:31、日落≈16:54（±20min）', () => {
  const sun = solar.sunTimes(new Date(2026, 11, 21), 39.904, 116.407, 480);
  close(sun.sunrise, 451, 20, '日出(分钟)');
  close(sun.sunset, 1014, 20, '日落(分钟)');
});
test('夏至北京：12:00正午强光、19:00黄金时刻、20:00蓝调、23:00深夜', () => {
  const sun = solar.sunTimes(new Date(2026, 5, 21), 39.904, 116.407, 480);
  eq(solar.classifyPeriod(12 * 60, sun), 'noonStrong');
  eq(solar.classifyPeriod(19 * 60, sun), 'goldenHour');
  eq(solar.classifyPeriod(20 * 60, sun), 'blueHour');
  eq(solar.classifyPeriod(23 * 60, sun), 'lateNight');
});
test('夏至北京：5:00黄金时刻、6:00日间；冬至北京：6:00黎明、18:00黄昏（蓝调之后）', () => {
  const sunS = solar.sunTimes(new Date(2026, 5, 21), 39.904, 116.407, 480);
  eq(solar.classifyPeriod(5 * 60, sunS), 'goldenHour');
  eq(solar.classifyPeriod(6 * 60, sunS), 'morningAfternoon');
  const sunW = solar.sunTimes(new Date(2026, 11, 21), 39.904, 116.407, 480);
  eq(solar.classifyPeriod(6 * 60, sunW), 'dusk');
  // 冬至日落约16:54，蓝调为16:54-17:24，黄昏为17:24之后
  eq(solar.classifyPeriod(17 * 60, sunW), 'blueHour');
  eq(solar.classifyPeriod(18 * 60, sunW), 'dusk');
});
test('无定位兜底日出日落（6:30/18:30）可正常划分时段', () => {
  const sun = solar.fallbackSunTimes();
  eq(solar.classifyPeriod(12 * 60, sun), 'noonStrong');
  eq(solar.classifyPeriod(18 * 60 + 45, sun), 'blueHour');
  eq(solar.classifyPeriod(23 * 60, sun), 'lateNight');
});
test('季节：1月冬、4月春、7月夏、10月秋', () => {
  eq(solar.getSeason(new Date(2026, 0, 15)), 'winter');
  eq(solar.getSeason(new Date(2026, 3, 15)), 'spring');
  eq(solar.getSeason(new Date(2026, 6, 15)), 'summer');
  eq(solar.getSeason(new Date(2026, 9, 15)), 'autumn');
});

console.log('\n[10] 画面分析器（image-analyzer.js）');
function buildFrame(width, height, fillFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { data: data.buffer, width, height };
}

test('合成帧：左40%暗(30)、右60%亮(230)，顶部4行干扰240应被刘海区排除', () => {
  const W = 96, H = 72;
  const analyzer = analyzerMod.createImageAnalyzer();
  const frame = buildFrame(W, H, (x, y) => {
    if (y < 4) return [240, 240, 240]; // 刘海区干扰，应被跳过
    return x < W * 0.4 ? [30, 30, 30] : [230, 230, 230];
  });
  const s = analyzer.process(frame);
  ok(s, '应返回有效统计');
  // 中心区（9×12网格的3-5行、4-7列，含2暗格+6亮格采样）权重×2：
  // 加权均值 = (22行×3520 + 12行×4960) / (22行×24 + 12行×32) ≈ 150.18
  close(s.avgBrightness, 136960 / 912, 3, '中心加权平均亮度');
  close(s.highlightRatio, 14 / 24, 0.03, '高光占比');
  close(s.shadowRatio, 10 / 24, 0.03, '暗部占比');
  eq(s.gridMeans.length, 9 * 12, '分区数9×12');
  close(s.gridMeans[0], 30, 1, '角落分区均值（暗）');
  close(s.gridMeans[11], 230, 1, '角落分区均值（亮）');
  close(s.contrastRatio, 230 / 30, 0.5, '分区光比');
  close(s.colorTemp, 6500, 50, '中性光色温');
  ok(s.colorReliable, '灰阶画面色温应可信');
  ok(!s.shaking, '首帧不应判定抖动');
});
test('两帧画面突变 → 抖动检测为真', () => {
  const W = 96, H = 72;
  const analyzer = analyzerMod.createImageAnalyzer();
  analyzer.process(buildFrame(W, H, (x) => (x < W * 0.4 ? [30, 30, 30] : [230, 230, 230])));
  const s2 = analyzer.process(buildFrame(W, H, (x) => (x < W * 0.4 ? [230, 230, 230] : [30, 30, 30])));
  ok(s2.shaking, '画面突变应判定抖动');
});
test('BGRA 字节序（iOS）：同一暖色像素在两种字节序下色温一致', () => {
  // 暖灰：R=180 G=160 B=140 → cct = 6500×B/R ≈ 5056K
  const expectedCct = 6500 * 140 / 180;
  const sRgba = analyzerMod.createImageAnalyzer()
    .process(buildFrame(96, 72, () => [180, 160, 140])); // 内存序即 R,G,B
  const frameBgra = buildFrame(96, 72, () => [140, 160, 180]); // 内存序 B,G,R（同一颜色）
  frameBgra.isBGRA = true;
  const sBgra = analyzerMod.createImageAnalyzer().process(frameBgra);
  close(sRgba.colorTemp, expectedCct, 10, 'RGBA暖色色温');
  close(sBgra.colorTemp, expectedCct, 10, 'BGRA交换后色温');
});
test('全黑帧（所有像素被过滤）返回 null 不崩溃', () => {
  const analyzer = analyzerMod.createImageAnalyzer();
  const s = analyzer.process(buildFrame(64, 64, () => [0, 0, 0]));
  eq(s, null, '应返回null');
});

console.log('\n[11] 工具函数（util.js）');
test('快门/光圈/补偿/色温格式化', () => {
  eq(util.formatShutter(1 / 2000), '1/2000s');
  eq(util.formatShutter(1 / 30), '1/30s');
  eq(util.formatShutter(2), '2s');
  eq(util.formatAperture(4), 'f/4');
  eq(util.formatAperture(2.8), 'f/2.8');
  eq(util.formatEvComp(0.3), '+0.3EV');
  eq(util.formatEvComp(0), '+0.0EV');
  eq(util.formatEvComp(-1.2), '-1.2EV');
  eq(util.formatColorTemp(5200), '5200K');
});
test('档位吸附：1/39.5s → 1/30s；f/3.65 → f/4', () => {
  eq(util.nearestByLog(1 / 39.5, rules.SHUTTER_STOPS), 1 / 30);
  close(util.nearestByLog(3.65, rules.APERTURE_STOPS), 4, 1e-9);
});
test('roundTo 步进0.3：0.24→0.3、-0.45→-0.3、0.1→0', () => {
  close(util.roundTo(0.24, 0.3), 0.3, 1e-9);
  close(util.roundTo(-0.45, 0.3), -0.3, 1e-9);
  close(util.roundTo(0.1, 0.3), 0, 1e-9);
});

// ---------- 汇总 ----------
console.log('\n========== 测试结果 ==========');
console.log('通过: ' + passed + '  失败: ' + failed);
if (failed) {
  console.log('\n失败用例:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
} else {
  console.log('全部通过 ✓');
}
