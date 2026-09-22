/**
 * 全局配置 —— 填入和风天气密钥后即可启用自动天气感知；
 * 不填也能用：小程序会降级为「手动天气/时间」模式，核心参数功能不受影响。
 *
 * 申请地址：https://dev.qweather.com/ （开发版免费）
 * 注意：开发版密钥对应的请求域名一般是 devapi.qweather.com；
 *      如果你的控制台分配了专属 API Host，请把 apiHost 改成对应值。
 */
module.exports = {
  version: '1.0.0',

  weather: {
    // TODO: 在这里填入你的和风天气 Key
    apiKey: '',
    // 和风天气请求域名（开发版默认 devapi，商业版一般为 api.qweather.com）
    apiHost: 'https://devapi.qweather.com',
    // 天气缓存有效期（毫秒），文档要求同一城市 1 小时内不重复请求
    cacheTtl: 60 * 60 * 1000
  },

  // 画面分析默认帧间隔（毫秒），可在设置页修改
  defaultSampleIntervalMs: 1000,

  // 环境数据（定位/天气）自动刷新间隔
  envRefreshIntervalMs: 30 * 60 * 1000
};
