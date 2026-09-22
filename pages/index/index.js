// 主取景页：实时取景 + 帧采样分析 + 参数实时推荐 + 降级处理
const app = getApp();
const engine = require('../../utils/param-engine');
const analyzerMod = require('../../utils/image-analyzer');
const envService = require('../../utils/env-service');
const store = require('../../utils/store');
const rules = require('../../utils/rules');
const config = require('../../config/config');
const util = require('../../utils/util');

Page({
  data: {
    statusBarHeight: 20,
    devicePosition: 'back',
    cameraDenied: false,
    locked: false,
    envText: '环境识别中…',
    envSourceText: '',
    modeBanner: '',
    overrideName: '',
    isoText: '--',
    shutterText: '--',
    apertureText: '--',
    evCompText: '--',
    evCompAdjusted: false,
    paramsHintText: '点击参数查看详情 · 双击锁定'
  },

  onLoad() {
    const win = util.getWindowInfo();
    this.setData({ statusBarHeight: win.statusBarHeight || 20 });

    this.analyzer = analyzerMod.createImageAnalyzer();
    this.engineState = null;
    this.lastFrameTs = 0;
    this.envFetchedAt = 0;
    this.envPromise = null;
    this.overrideParams = null;
    // iOS 相机帧为 BGRA 字节序，需交换 R/B 后再做色温估算
    this.isBGRA = util.getPlatform() === 'ios';

    this.refreshSettings();
    this.initEnv();
  },

  onReady() {
    this._ready = true;
    this.setupCamera();
  },

  onShow() {
    // 设置页修改过配置 → 刷新设置与环境
    if (this.settingsRev !== undefined && app.globalData.settingsRev !== this.settingsRev) {
      this.refreshSettings();
      this.analyzer.reset();
      this.engineState = null;
      this.initEnv();
    }
    // 预设/历史页应用了参数
    const preset = app.globalData.appliedPreset;
    if (preset) {
      app.globalData.appliedPreset = null;
      this.overrideParams = preset.params || null;
      this.setData({ overrideName: preset.name || '' });
      this.renderCurrent();
    }
    // 从其他页面返回：重启帧监听（onHide 中已停止）
    if (this._ready && !this.data.cameraDenied) this.setupCamera();
  },

  onUnload() {
    if (this.frameListener) {
      try { this.frameListener.stop(); } catch (e) { /* ignore */ }
    }
  },

  onHide() {
    if (this.frameListener) {
      try { this.frameListener.stop(); } catch (e) { /* ignore */ }
    }
  },

  refreshSettings() {
    this.settings = store.getSettings();
    this.settingsRev = app.globalData.settingsRev;
  },

  // ---------- 环境数据 ----------
  initEnv() {
    this.envFetchedAt = Date.now();
    this.envPromise = envService.getEnvironment(this.settings).then((env) => {
      app.globalData.session.env = env;
      this.applyEnv(env);
      // 相机不可用时也要给出纯环境推荐（6.4 降级）
      if (this.data.cameraDenied || !app.globalData.session.recommendation) {
        this.computeOnce(null);
      }
      return env;
    }).catch(() => {
      this.applyEnv(null);
      if (!app.globalData.session.recommendation) this.computeOnce(null);
      return null;
    });
  },

  applyEnv(env) {
    if (!env) {
      this.setData({
        envText: '环境数据不可用',
        envSourceText: '纯画面分析模式',
        modeBanner: '定位与天气均不可用：已切换纯画面分析模式，可在设置中手动配置环境'
      });
      return;
    }
    const icon = rules.weatherIcon(env.weather);
    const label = rules.weatherLabel(env.weather);
    const seasonText = rules.SEASON_LABEL[env.season];
    const envText = icon + ' ' + label + (env.city ? ' · ' + env.city : '') + ' · ' + rules.TIME_PERIOD_CORRECTION[env.period].label + ' · ' + seasonText + '季';

    let envSourceText = '';
    if (env.weatherSource === 'manual') envSourceText = '手动模式';
    else if (env.weatherSource === 'estimated') envSourceText = '天气为估算值';
    else if (env.weatherSource === 'cache') envSourceText = '天气缓存';

    const weatherUnavailable = env.weatherSource === 'none';
    const modeBanner = (!this.data.cameraDenied && weatherUnavailable)
      ? '定位与天气均不可用：已切换纯画面分析模式，可在设置中手动配置环境'
      : '';
    this.setData({ envText, envSourceText, modeBanner });
  },

  // ---------- 相机与帧回调 ----------
  setupCamera() {
    if (this.data.cameraDenied) return;
    if (this.frameListener) {
      try { this.frameListener.stop(); } catch (e) { /* ignore */ }
      this.frameListener = null;
    }
    try {
      this.cameraContext = wx.createCameraContext();
      this.frameListener = this.cameraContext.onCameraFrame((frame) => this.onFrame(frame));
      this.frameListener.start();
    } catch (e) {
      this.onCameraError();
    }
  },

  onCameraError() {
    if (this.data.cameraDenied) return;
    this.setData({ cameraDenied: true, modeBanner: '' });
    if (this.frameListener) {
      try { this.frameListener.stop(); } catch (e) { /* ignore */ }
      this.frameListener = null;
    }
    this.computeOnce(null);
  },

  onFrame(frame) {
    if (this.data.locked) return;
    const now = Date.now();
    const interval = (this.settings && this.settings.sampleIntervalMs) || config.defaultSampleIntervalMs;
    if (now - this.lastFrameTs < interval) return;
    this.lastFrameTs = now;

    // 环境数据定时刷新
    if (now - this.envFetchedAt > config.envRefreshIntervalMs) this.initEnv();

    const stats = this.analyzer.process({
      data: frame.data,
      width: frame.width,
      height: frame.height,
      isBGRA: this.isBGRA
    });
    // 无效帧或抖动中：暂停参数更新（2.2 抖动检测）
    if (!stats || stats.shaking) return;

    this.envPromise.then(() => {
      if (this.data.locked) return;
      this.computeOnce(stats);
    });
  },

  computeOnce(frameStats) {
    const session = app.globalData.session;
    if (frameStats) session.frameStats = frameStats;
    const device = Object.assign({}, rules.DEFAULT_DEVICE, {
      evOffset: (this.settings && this.settings.calibrationEv) || 0
    });
    const rec = engine.computeRecommendation(session.env, frameStats, this.engineState, device);
    this.engineState = rec.state;
    session.recommendation = rec;
    this.renderRecommendation(rec);
  },

  // ---------- 渲染 ----------
  renderRecommendation(rec) {
    const session = app.globalData.session;
    const ua = session.userAdjust;
    const o = this.overrideParams;
    const evCompAdjusted = !!(ua && ua.evComp != null);
    this.setData({
      isoText: o ? o.isoText : rec.texts.isoText,
      shutterText: o ? o.shutterText : rec.texts.shutterText,
      apertureText: o ? o.apertureText : rec.texts.apertureText,
      evCompText: evCompAdjusted ? util.formatEvComp(ua.evComp) : (o ? o.evCompText : rec.texts.evCompText),
      evCompAdjusted,
      paramsHintText: this.data.locked ? '参数已锁定 · 双击解锁' : '点击参数查看详情 · 双击锁定'
    });
  },

  renderCurrent() {
    const rec = app.globalData.session.recommendation;
    if (rec) this.renderRecommendation(rec);
  },

  // ---------- 交互 ----------
  toggleLock() {
    const locked = !this.data.locked;
    this.setData({ locked });
    app.globalData.session.locked = locked;
    wx.showToast({ title: locked ? '参数已锁定' : '已解锁，继续实时推荐', icon: 'none' });
    this.renderCurrent();
  },

  onParamBarTap() {
    // 单击 → 详情；双击（300ms内）→ 锁定/解锁
    const now = Date.now();
    if (this._lastTap && now - this._lastTap < 300) {
      clearTimeout(this._tapTimer);
      this._lastTap = 0;
      this.toggleLock();
      return;
    }
    this._lastTap = now;
    this._tapTimer = setTimeout(() => {
      this._lastTap = 0;
      wx.navigateTo({ url: '/pages/detail/detail' });
    }, 320);
  },

  switchCamera() {
    this.analyzer.reset();
    this.engineState = null;
    this.setData({
      devicePosition: this.data.devicePosition === 'back' ? 'front' : 'back'
    });
  },

  clearOverride() {
    this.overrideParams = null;
    this.setData({ overrideName: '' });
    this.renderCurrent();
  },

  openCameraSetting() {
    wx.openSetting({});
  },

  takeShot() {
    const session = app.globalData.session;
    const rec = session.recommendation;
    if (!rec) {
      wx.showToast({ title: '参数计算中，请稍候', icon: 'none' });
      return;
    }
    const params = this.snapshotParams();
    const env = session.env;
    const envInfo = env ? {
      city: env.city || '',
      weather: env.weather || '',
      period: env.period || '',
      season: env.season || ''
    } : {};

    const record = (thumb) => {
      store.addHistory({ params, env: envInfo, thumb: thumb || '' });
      wx.showToast({ title: '已记录到拍摄历史', icon: 'success' });
    };

    if (this.data.cameraDenied || !this.cameraContext) {
      record(null);
      return;
    }
    this.cameraContext.takePhoto({
      quality: 'high',
      success: (res) => this.saveThumb(res.tempImagePath).then(record).catch(() => record(null)),
      fail: () => record(null)
    });
  },

  // 缩略图持久化：临时文件跨会话失效，复制到用户目录
  saveThumb(tempPath) {
    return new Promise((resolve, reject) => {
      const fs = wx.getFileSystemManager();
      const target = wx.env.USER_DATA_PATH + '/shot_' + Date.now() + '.jpg';
      fs.copyFile({
        srcPath: tempPath,
        destPath: target,
        success: () => resolve(target),
        fail: (e) => reject(e)
      });
    });
  },

  snapshotParams() {
    const rec = app.globalData.session.recommendation;
    const ua = app.globalData.session.userAdjust;
    const o = this.overrideParams;
    return {
      isoText: o ? o.isoText : rec.texts.isoText,
      shutterText: o ? o.shutterText : rec.texts.shutterText,
      apertureText: o ? o.apertureText : rec.texts.apertureText,
      evCompText: ua && ua.evComp != null ? util.formatEvComp(ua.evComp) : (o ? o.evCompText : rec.texts.evCompText),
      wbText: ua && ua.colorTemp != null ? ua.colorTemp + 'K' : (o ? o.wbText : rec.texts.wbText),
      meteringText: o ? o.meteringText : rec.texts.meteringText
    };
  },

  goPresets() { wx.navigateTo({ url: '/pages/presets/presets' }); },
  goHistory() { wx.navigateTo({ url: '/pages/history/history' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); }
});
