// 预设管理页：列表 / 新增 / 改名 / 删除 / 一键应用（文档 8.3）
const app = getApp();
const store = require('../../utils/store');

function presetSummary(params) {
  if (!params) return '';
  return [params.isoText, params.shutterText, params.apertureText, params.evCompText, params.wbText]
    .filter(Boolean).join('  ·  ');
}

Page({
  data: {
    presets: [],
    canSaveCurrent: false
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const presets = store.getPresets().map((p) => ({
      id: p.id,
      name: p.name,
      params: p.params,
      summary: presetSummary(p.params)
    }));
    const rec = app.globalData.session.recommendation;
    this.setData({ presets, canSaveCurrent: !!rec });
  },

  saveCurrent() {
    const rec = app.globalData.session.recommendation;
    if (!rec) {
      wx.showToast({ title: '暂无推荐参数', icon: 'none' });
      return;
    }
    const session = app.globalData.session;
    const ua = session.userAdjust;
    const params = {
      isoText: rec.texts.isoText,
      shutterText: rec.texts.shutterText,
      apertureText: rec.texts.apertureText,
      evCompText: ua && ua.evComp != null ? formatEv(ua.evComp) : rec.texts.evCompText,
      wbText: ua && ua.colorTemp != null ? ua.colorTemp + 'K' : rec.texts.wbText,
      meteringText: rec.texts.meteringText
    };
    wx.showModal({
      title: '保存当前参数',
      editable: true,
      placeholderText: '预设名称',
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) {
          wx.showToast({ title: '名称不能为空', icon: 'none' });
          return;
        }
        store.addPreset({ name, params });
        this.refresh();
        wx.showToast({ title: '已保存', icon: 'success' });
      }
    });
  },

  applyPreset(e) {
    const id = e.currentTarget.dataset.id;
    const preset = this.data.presets.find((p) => p.id === id);
    if (!preset) return;
    app.globalData.appliedPreset = { name: preset.name, params: preset.params };
    wx.navigateBack();
  },

  renamePreset(e) {
    const id = e.currentTarget.dataset.id;
    const preset = this.data.presets.find((p) => p.id === id);
    if (!preset) return;
    wx.showModal({
      title: '修改预设名称',
      editable: true,
      placeholderText: preset.name,
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return;
        store.updatePreset(id, { name });
        this.refresh();
      }
    });
  },

  deletePreset(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除预设',
      content: '删除后不可恢复，确定删除？',
      confirmColor: '#ff7875',
      success: (res) => {
        if (!res.confirm) return;
        store.removePreset(id);
        this.refresh();
      }
    });
  }
});

function formatEv(ev) {
  return (ev >= 0 ? '+' : '') + ev.toFixed(1) + 'EV';
}
