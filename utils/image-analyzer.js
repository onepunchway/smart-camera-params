/**
 * 画面分析引擎（文档 2.2、5.2、6.2）。
 *
 * 直接对 onCameraFrame 的 RGBA ArrayBuffer 做下采样计算（不经过 Canvas，
 * 计算量更小、结果一致）。输出：
 *   - 平均亮度（连续3帧平滑，中心区加权，剔除刘海区与纯黑/纯白像素）
 *   - 高光/暗部占比、分区光比
 *   - 画面色温估算（R/B 比值法，饱和度过高时标记不可靠）
 *   - 抖动检测（分区均值帧间差异）
 */

const rules = require('./rules');
const util = require('./util');

const GRID_ROWS = 9;
const GRID_COLS = 12;

// 降采样步长：每 2 行 × 每 4 列取 1 个像素，medium 帧约十几万采样，1fps 下开销可忽略
const Y_STEP = 2;
const X_STEP = 4;

// 顶部刘海/挖孔避让比例（6.2.2）
const TOP_SKIP_RATIO = 0.06;

// 抖动判定阈值：分区均值平均绝对差（0-255）
const SHAKE_DIFF_THRESHOLD = 8;

// 色温采样最少像素数
const CCT_MIN_SAMPLES = 50;

function createImageAnalyzer() {
  const state = {
    lastGridMeans: null,     // 上一帧分区均值（抖动检测用）
    brightnessHistory: [],   // 最近3帧平均亮度（帧间平滑 6.2.4）
    colorTempHistory: []     // 最近3帧画面色温
  };

  function reset() {
    state.lastGridMeans = null;
    state.brightnessHistory = [];
    state.colorTempHistory = [];
  }

  /**
   * 分析一帧。
   * @param {{data:ArrayBuffer, width:number, height:number, isBGRA?:boolean}} frame
   *        isBGRA：iOS 平台相机帧字节序为 BGRA，需交换 R/B（页面层通过 getPlatform 判断）
   * @returns {object|null} 统计结果；全黑/无效帧返回 null
   */
  function process(frame) {
    const width = frame.width;
    const height = frame.height;
    const bytes = new Uint8Array(frame.data);
    const rIdx = frame.isBGRA ? 2 : 0;
    const bIdx = frame.isBGRA ? 0 : 2;

    const cellCount = GRID_ROWS * GRID_COLS;
    const cellSum = new Float64Array(cellCount);
    const cellPixels = new Float64Array(cellCount);
    // 中心 1/3 行（3-5）× 中心 4 列（4-7）权重 ×2，模拟中央重点测光（6.2.1）
    const cellWeight = new Float64Array(cellCount);
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        cellWeight[r * GRID_COLS + c] = (r >= 3 && r <= 5 && c >= 4 && c <= 7) ? 2 : 1;
      }
    }

    const yStart = Math.floor(height * TOP_SKIP_RATIO);
    const cellW = width / GRID_COLS;
    const cellH = height / GRID_ROWS;

    let weightedSum = 0, weightedCount = 0, pxCount = 0;
    let hiCount = 0, loCount = 0;
    let rSum = 0, gSum = 0, bSum = 0, cctSamples = 0;

    for (let y = yStart; y < height; y += Y_STEP) {
      const rowOffset = y * width * 4;
      const gy = Math.min(GRID_ROWS - 1, Math.floor(y / cellH));
      for (let x = 0; x < width; x += X_STEP) {
        const i = rowOffset + x * 4;
        const r = bytes[i + rIdx];
        const g = bytes[i + 1];
        const b = bytes[i + bIdx];
        // 标准灰度公式（5.2.1）
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        if (Y < 5 || Y > 250) continue; // 排除纯黑/纯白边缘像素（6.2.2）

        const gx = Math.min(GRID_COLS - 1, Math.floor(x / cellW));
        const ci = gy * GRID_COLS + gx;
        const w = cellWeight[ci];
        cellSum[ci] += Y;
        cellPixels[ci] += 1;
        weightedSum += Y * w;
        weightedCount += w;
        pxCount += 1;

        if (Y > rules.HIGHLIGHT_PIXEL_Y) hiCount += 1;
        else if (Y < rules.SHADOW_PIXEL_Y) loCount += 1;

        // 色温估算采样：排除暗部噪声（噪声下 R/B 比值不可信）
        if (Y >= 60) {
          rSum += r; gSum += g; bSum += b; cctSamples += 1;
        }
      }
    }

    if (weightedCount === 0) return null;

    // 分区均值 + 分区光比
    const gridMeans = new Array(cellCount);
    let minMean = Infinity, maxMean = 0;
    for (let ci = 0; ci < cellCount; ci++) {
      const mean = cellPixels[ci] > 0 ? cellSum[ci] / cellPixels[ci] : 0;
      gridMeans[ci] = mean;
      if (cellPixels[ci] > 0) {
        if (mean < minMean) minMean = mean;
        if (mean > maxMean) maxMean = mean;
      }
    }
    const contrastRatio = util.clamp(maxMean / Math.max(1, minMean), 1, 10);

    // 画面色温：CCT ≈ 6500K × (B/R)，中性光锚定 6500K（5.2 色温估算）
    let colorTemp = null;
    let colorReliable = false;
    if (cctSamples >= CCT_MIN_SAMPLES) {
      const rAvg = rSum / cctSamples;
      const gAvg = gSum / cctSamples;
      const bAvg = bSum / cctSamples;
      const mx = Math.max(rAvg, gAvg, bAvg);
      const mn = Math.min(rAvg, gAvg, bAvg);
      const saturation = mx > 0 ? (mx - mn) / mx : 0;
      colorReliable = saturation <= rules.WB.saturationUnreliable;
      if (rAvg > 0) colorTemp = util.clamp(rules.WB.neutralAnchorK * bAvg / rAvg, rules.LIMITS.whiteBalance.min, rules.LIMITS.whiteBalance.max);
    }

    // 帧间平滑：连续3帧平均（6.2.4）
    state.brightnessHistory.push(weightedSum / weightedCount);
    if (state.brightnessHistory.length > 3) state.brightnessHistory.shift();
    let avgBrightness = 0;
    for (let i = 0; i < state.brightnessHistory.length; i++) avgBrightness += state.brightnessHistory[i];
    avgBrightness /= state.brightnessHistory.length;

    if (colorTemp != null && colorReliable) {
      state.colorTempHistory.push(colorTemp);
      if (state.colorTempHistory.length > 3) state.colorTempHistory.shift();
    }
    let colorTempSmooth = null;
    if (state.colorTempHistory.length) {
      colorTempSmooth = 0;
      for (let i = 0; i < state.colorTempHistory.length; i++) colorTempSmooth += state.colorTempHistory[i];
      colorTempSmooth /= state.colorTempHistory.length;
    }

    // 抖动检测：分区均值帧间平均绝对差（2.2 抖动检测）
    let shaking = false;
    if (state.lastGridMeans) {
      let diff = 0;
      for (let ci = 0; ci < cellCount; ci++) diff += Math.abs(gridMeans[ci] - state.lastGridMeans[ci]);
      shaking = diff / cellCount > SHAKE_DIFF_THRESHOLD;
    }
    state.lastGridMeans = gridMeans;

    return {
      avgBrightness,
      highlightRatio: pxCount > 0 ? hiCount / pxCount : 0,
      shadowRatio: pxCount > 0 ? loCount / pxCount : 0,
      contrastRatio,
      colorTemp: colorTempSmooth,
      colorReliable,
      shaking,
      gridMeans
    };
  }

  return { process, reset };
}

module.exports = { createImageAnalyzer, GRID_ROWS, GRID_COLS };
