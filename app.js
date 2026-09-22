// 全局状态：会话数据跨页面共享（主取景页产出 → 详情/预设/历史页消费）
App({
  globalData: {
    // 当前会话：环境数据、画面统计、推荐结果、用户微调、预设覆盖
    session: {
      env: null,
      frameStats: null,
      recommendation: null, // param-engine 输出
      userAdjust: null,     // { evComp, colorTemp } 详情页滑块微调
      locked: false
    },
    // 设置版本号：设置页每次保存自增，取景页 onShow 检测后刷新环境
    settingsRev: 0,
    // 预设页/历史页点"应用/复用"后暂存，取景页 onShow 消费
    appliedPreset: null
  },

  onLaunch() {
    // 无需登录，打开即用（3.4）
  }
});
