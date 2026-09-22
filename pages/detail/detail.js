// 参数详情页：完整参数 + 推荐理由 + 滑块微调 + 保存预设（文档 8.2）
const app = getApp();
const store = require('../../utils/store');
const util = require('../../utils/util');

const PARAM_DESC = {
  iso: '感光度：越高对光越敏感，但噪点越多、画质越差',
  shutter: '快门速度：控制进光时长，过慢容易手抖模糊',
  aperture: '光圈值：f 后数字越小进光越多、景深越浅',
  evComp: '曝光补偿：在推荐组合上整体增减曝光，步进 0.3EV',
  wb: '白平衡色温：决定画面冷暖，数值越高画面越偏暖',
  metering: '测光模式：决定相机以画面哪个区域为曝光基准'
};

Page({
  data: {
    loaded: false,
    items: [],
    warnings: []
  },

  onShow() {
    const session = app.globalData.session;
    const rec = session.recommendation;
    if (!rec) {
      wx.showToast({ title: '暂无推荐参数，请先回到取景页', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.buildItems(rec, session.userAdjust);
    this.setData({ loaded: true, warnings: rec.warnings || [] });
  },

  buildItems(rec, userAdjust) {
    const ua = userAdjust || {};
    const evCompValue = ua.evComp != null ? ua.evComp : rec.params.evComp;
    const wbValue = ua.colorTemp != null ? ua.colorTemp : rec.params.colorTemp;

    const items = [
      {
        key: 'iso', label: 'ISO 感光度',
        value: rec.texts.isoText, reason: rec.reasons.iso, desc: PARAM_DESC.iso
      },
      {
        key: 'shutter', label: '快门速度',
        value: rec.texts.shutterText, reason: rec.reasons.shutter, desc: PARAM_DESC.shutter
      },
      {
        key: 'aperture', label: '光圈值',
        value: rec.texts.apertureText, reason: rec.reasons.aperture, desc: PARAM_DESC.aperture
      },
      {
        key: 'evComp', label: '曝光补偿',
        value: util.formatEvComp(evCompValue), reason: rec.reasons.evComp, desc: PARAM_DESC.evComp,
        slider: { min: -3, max: 3, step: 0.3, value: evCompValue, minLabel: '-3EV', maxLabel: '+3EV' }
      },
      {
        key: 'wb', label: '白平衡色温',
        value: Math.round(wbValue) + 'K', reason: rec.reasons.wb, desc: PARAM_DESC.wb,
        slider: { min: 2000, max: 10000, step: 100, value: wbValue, minLabel: '2000K', maxLabel: '10000K' }
      },
      {
        key: 'metering', label: '测光模式',
        value: rec.texts.meteringText, reason: rec.reasons.metering, desc: PARAM_DESC.metering
      }
    ];
    this.setData({ items });
  },

  onSliderChanging(e) {
    this.applySlider(e, false);
  },

  onSliderChange(e) {
    this.applySlider(e, true);
  },

  applySlider(e, persist) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    const items = this.data.items;
    const idx = items.findIndex((it) => it.key === key);
    if (idx < 0) return;

    const patch = {};
    if (key === 'evComp') {
      items[idx].value = util.formatEvComp(value);
      patch.evComp = value;
    } else if (key === 'wb') {
      items[idx].value = Math.round(value) + 'K';
      patch.colorTemp = value;
    }
    this.setData({ items });

    if (persist) {
      const session = app.globalData.session;
      session.userAdjust = Object.assign({}, session.userAdjust, patch);
    }
  },

  restoreRecommend() {
    app.globalData.session.userAdjust = null;
    const rec = app.globalData.session.recommendation;
    this.buildItems(rec, null);
    wx.showToast({ title: '已恢复推荐值', icon: 'success' });
  },

  savePreset() {
    const items = this.data.items;
    const find = (key) => items.find((it) => it.key === key) || {};
    const params = {
      isoText: find('iso').value,
      shutterText: find('shutter').value,
      apertureText: find('aperture').value,
      evCompText: find('evComp').value,
      wbText: find('wb').value,
      meteringText: find('metering').value
    };
    wx.showModal({
      title: '保存为预设',
      editable: true,
      placeholderText: '给这组参数起个名字，如"夕阳人像"',
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        store.addPreset({ name, params });
        wx.showToast({ title: '预设已保存', icon: 'success' });
      }
    });
  }
});
