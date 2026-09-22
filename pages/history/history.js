// 拍摄历史页：倒序列表 / 详情摘要 / 复用参数 / 删除（文档 8.4、2.5）
const app = getApp();
const store = require('../../utils/store');
const rules = require('../../utils/rules');

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

Page({
  data: {
    records: []
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const records = store.getHistory().map((h) => {
      const p = h.params || {};
      const env = h.env || {};
      return {
        id: h.id,
        thumb: h.thumb || '',
        paramsText: [p.isoText, p.shutterText, p.apertureText, p.evCompText, p.wbText]
          .filter(Boolean).join(' · '),
        envText: [
          env.city,
          env.weather ? rules.weatherLabel(env.weather) : '',
          env.period ? rules.TIME_PERIOD_CORRECTION[env.period].label : ''
        ].filter(Boolean).join(' · ') || '环境信息缺失',
        timeText: formatTime(h.ts)
      };
    });
    this.setData({ records });
  },

  reuseRecord(e) {
    const id = e.currentTarget.dataset.id;
    const record = store.getHistory().find((h) => h.id === id);
    if (!record || !record.params) return;
    app.globalData.appliedPreset = { name: '历史参数', params: record.params };
    wx.navigateBack();
  },

  deleteRecord(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除记录',
      content: '确定删除这条拍摄记录？',
      confirmColor: '#ff7875',
      success: (res) => {
        if (!res.confirm) return;
        store.removeHistory(id);
        this.refresh();
      }
    });
  },

  clearAll() {
    wx.showModal({
      title: '清空历史',
      content: '将删除全部拍摄记录（最多保留100条），确定？',
      confirmColor: '#ff7875',
      success: (res) => {
        if (!res.confirm) return;
        store.clearHistory();
        this.refresh();
      }
    });
  }
});
