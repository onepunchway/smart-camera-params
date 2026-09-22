// 手动设置页：手动环境 / 采样频率 / 设备校准 / 关于（文档 8.5、2.1 手动修正、6.3 校准）
const app = getApp();
const store = require('../../utils/store');
const rules = require('../../utils/rules');
const envService = require('../../utils/env-service');
const config = require('../../config/config');

const INTERVAL_NAMES = ['0.5秒/帧', '1秒/帧（推荐）', '2秒/帧', '3秒/帧（省电）'];
const INTERVAL_VALUES = [500, 1000, 2000, 3000];

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

Page({
  data: {
    manualEnabled: false,
    city: '',
    weatherNames: [],
    weatherKeys: [],
    weatherIndex: 0,
    dateValue: '',
    timeValue: '',
    hasManualTime: false,
    intervalNames: INTERVAL_NAMES,
    intervalIndex: 1,
    calibrationEv: 0,
    calibrationText: '+0.0EV',
    version: config.version
  },

  onLoad() {
    const s = store.getSettings();
    const manual = s.manualEnv || {};
    const weatherNames = ['自动（按城市/时段）'].concat(rules.WEATHER_OPTIONS.map((w) => w.label));
    const weatherKeys = [''].concat(rules.WEATHER_OPTIONS.map((w) => w.key));

    let dateValue = '';
    let timeValue = '';
    if (manual.datetime) {
      const parts = manual.datetime.split(' ');
      dateValue = parts[0] || '';
      timeValue = parts[1] || '';
    }
    if (!dateValue) {
      const now = new Date();
      dateValue = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate());
    }
    if (!timeValue) timeValue = '12:00';

    this.setData({
      manualEnabled: !!manual.enabled,
      city: manual.city || '',
      weatherNames,
      weatherKeys,
      weatherIndex: Math.max(0, weatherKeys.indexOf(manual.weather || '')),
      dateValue,
      timeValue,
      hasManualTime: !!manual.datetime,
      intervalIndex: Math.max(0, INTERVAL_VALUES.indexOf(s.sampleIntervalMs || 1000)),
      calibrationEv: s.calibrationEv || 0,
      calibrationText: this.formatCal(s.calibrationEv || 0)
    });
  },

  formatCal(v) {
    return (v >= 0 ? '+' : '') + Number(v).toFixed(1) + 'EV';
  },

  persist(patch) {
    store.setSettings(patch);
    app.globalData.settingsRev += 1;
  },

  // ---------- 手动环境 ----------
  onToggleManual(e) {
    this.setData({ manualEnabled: e.detail.value });
    this.persist({ manualEnv: this.buildManualEnv({ enabled: e.detail.value }) });
  },

  buildManualEnv(patch) {
    const s = store.getSettings();
    const manual = Object.assign({}, s.manualEnv, patch || {});
    return manual;
  },

  onCityInput(e) {
    const city = (e.detail.value || '').trim();
    this.setData({ city });
    this.persist({ manualEnv: this.buildManualEnv({ city }) });
  },

  testCity() {
    const city = this.data.city;
    if (!city) {
      wx.showToast({ title: '请先输入城市名', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '查询中…' });
    envService.lookupCity(city).then((result) => {
      wx.hideLoading();
      if (result) {
        wx.showToast({ title: '已找到：' + result.name, icon: 'success' });
      } else {
        wx.showToast({ title: '未找到该城市，请检查名称', icon: 'none' });
      }
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '查询失败：请检查网络与天气Key配置', icon: 'none' });
    });
  },

  onWeatherPick(e) {
    const idx = Number(e.detail.value);
    this.setData({ weatherIndex: idx });
    this.persist({ manualEnv: this.buildManualEnv({ weather: this.data.weatherKeys[idx] || '' }) });
  },

  onDatePick(e) {
    this.setData({ dateValue: e.detail.value });
    this.saveManualTime();
  },

  onTimePick(e) {
    this.setData({ timeValue: e.detail.value });
    this.saveManualTime();
  },

  saveManualTime() {
    const { dateValue, timeValue } = this.data;
    this.setData({ hasManualTime: true });
    this.persist({ manualEnv: this.buildManualEnv({ datetime: dateValue + ' ' + timeValue }) });
  },

  clearManualTime() {
    this.setData({ hasManualTime: false });
    this.persist({ manualEnv: this.buildManualEnv({ datetime: '' }) });
    wx.showToast({ title: '已恢复系统时间', icon: 'success' });
  },

  // ---------- 采样频率 ----------
  onIntervalPick(e) {
    const idx = Number(e.detail.value);
    this.setData({ intervalIndex: idx });
    this.persist({ sampleIntervalMs: INTERVAL_VALUES[idx] });
  },

  // ---------- 设备校准 ----------
  onCalChanging(e) {
    this.setData({ calibrationText: this.formatCal(e.detail.value) });
  },

  onCalChange(e) {
    const v = Number(e.detail.value.toFixed(1));
    this.setData({ calibrationEv: v, calibrationText: this.formatCal(v) });
    this.persist({ calibrationEv: v });
  }
});
