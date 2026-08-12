// pages/index/index.js - 首页：太阳活动预测面板（鲜艳天文主题 v3）
// 数据源统一：SILSO 官方实测 + LSTM 预测辅助

let resultData = {}
let remoteAssetsData = {}
let dailySolar = {}

try {
  resultData = require('../../result.js')
  console.log('[首页] result.js 加载成功，预测结果条数:', (resultData['预测结果'] || []).length)
} catch (e) {
  console.error('[首页] 加载 result.js 失败:', e)
  resultData = {}
}

try {
  remoteAssetsData = require('../../remote_assets.json')
  console.log('[首页] remote_assets.json 加载成功')
} catch (e) {
  remoteAssetsData = {}
}

try {
  dailySolar = require('../../daily_solar.json')
  console.log('[首页] daily_solar.json 加载成功')
} catch (e) {
  dailySolar = {}
}

// CDN 地址
const DAILY_SOLAR_CDN = 'https://cdn.jsdelivr.net/gh/Hermiaaa-eng/solar-images@main/solar_miniprogram/daily_solar.json'

// 异常判定阈值
const ANOMALY_LEVELS = ['中度活跃', '强爆发']
const ANOMALY_VALUE_THRESHOLD = 100

Page({
  data: {
    currentLevel: '',
    levelColor: '',
    levelDesc: '',
    forecastList: [],
    levels: {},
    imageSrc: '',
    fetchTime: '',
    imageSourceName: '',
    sourceIndex: 0,
    isAnomaly: false,      // 当前最新等级是否异常
    hasAnomaly: false,     // 7 期中是否有异常
    _fallbackLock: false,
    // 图片属性表
    imageMeta: {
      instrument: '',
      wavelength: '',
      temperature: '',
      target_layer: '',
      capture_time: '',
      satellite: '',
      launch_date: '',
      orbit: '',
      distance: '',
      resolution: '',
      copyright: '',
      file_size: ''
    },
    metaExpanded: false,    // 属性表是否展开
    // CDN 数据状态
    cdnUpdateTime: '',
    cdnStatus: '加载中...',
    // 官方实测数据
    officialVal: 0,
    officialDate: '',
    officialSource: '',
    // 数据新鲜度
    dataFreshness: '',
    dataFreshnessLevel: 'ok'  // ok / warning / danger
  },

  buildImageSources: function () {
    const today = new Date()
    const dateTag = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

    const baseSources = [
      { name: 'NASA SDO 211Å（官方最新）', url: `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0211.jpg?t=${dateTag}` },
      { name: 'NASA SDO 193Å（备用）',   url: `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0193.jpg?t=${dateTag}` },
      { name: '本地真实抓取（离线缓存）', url: `/images/solar_today.jpg?t=${dateTag}` },
      { name: '本地仿真兜底图',          url: `/images/solar_fallback.jpg?t=${dateTag}` }
    ]

    const cdnUrl = remoteAssetsData.solar_image_cdn
    if (cdnUrl && cdnUrl.startsWith('http')) {
      return [{ name: '☁️ CDN 加速（每日自动同步）', url: cdnUrl }].concat(baseSources)
    }
    return baseSources
  },

  onLoad: function () {
    this.IMAGE_SOURCES = this.buildImageSources()
    this.loadResult()
    this.tryLoadImage(0)
    this.loadImageMeta()
    // 异步从 CDN 拉取最新官方数据
    this.fetchRemoteSolarData()
  },

  tryLoadImage: function (idx) {
    if (idx >= this.IMAGE_SOURCES.length) {
      wx.showToast({ title: '图片无法加载', icon: 'none' })
      return
    }
    const source = this.IMAGE_SOURCES[idx]
    console.log(`[首页] 尝试图片源 #${idx}: ${source.name}`)
    this.setData({ imageSrc: source.url, imageSourceName: source.name, sourceIndex: idx })
  },

  onImageError: function (e) {
    if (this.data._fallbackLock) return
    this.data._fallbackLock = true
    setTimeout(() => { this.data._fallbackLock = false }, 100)
    const nextIdx = this.data.sourceIndex + 1
    console.warn(`[首页] 源 #${this.data.sourceIndex} 加载失败 → 切换到 #${nextIdx}`)
    if (nextIdx < this.IMAGE_SOURCES.length) {
      this.tryLoadImage(nextIdx)
    }
  },

  onImageLoaded: function () {
    console.log(`[首页] ✅ 图片加载成功（源 #${this.data.sourceIndex}）`)
  },

  // ===== 核心：优先使用官方实测数据 + LSTM 预测辅助 =====
  loadResult: function () {
    try {
      // 优先使用 SILSO 官方实测数据作为"当前状态"
      const officialSn = dailySolar.official_sunspot || {}
      const officialVal = officialSn.value || 0
      const officialDate = officialSn.date || ''

      // LSTM 预测数据作为"未来趋势"
      const rawList = resultData['预测结果'] || []

      const forecastList = rawList.map(item => {
        const val = Number(item.value) || 0
        const isAnomaly = ANOMALY_LEVELS.indexOf(item.level) >= 0 || val >= ANOMALY_VALUE_THRESHOLD
        return {
          date: item.date,
          value: item.value,
          level: item.level,
          isAnomaly: isAnomaly
        }
      })

      const hasAnomaly = forecastList.some(item => item.isAnomaly)

      // 当前等级：基于官方实测黑子数判定
      let currentLevel = '平静'
      if (officialVal >= 100) currentLevel = '强爆发'
      else if (officialVal >= 70) currentLevel = '中度活跃'
      else if (officialVal >= 30) currentLevel = '低度活跃'

      const currentIsAnomaly = officialVal >= ANOMALY_VALUE_THRESHOLD
      const levelConfig = this.getLevelConfig(currentLevel)

      // 计算数据新鲜度（SILSO 数据相对今天的延迟天数）
      const freshness = this.computeDataFreshness(officialDate)

      this.setData({
        currentLevel: currentLevel,
        levelColor: levelConfig.color,
        levelDesc: levelConfig.desc,
        forecastList: forecastList,
        levels: resultData['活动等级说明'] || resultData['预警等级说明'] || {},
        isAnomaly: currentIsAnomaly,
        hasAnomaly: hasAnomaly,
        officialVal: officialVal,
        officialDate: officialDate,
        officialSource: officialSn.source || 'SILSO 比利时皇家天文台',
        dataFreshness: freshness.text,
        dataFreshnessLevel: freshness.level
      })

      console.log(`[首页] 官方实测: ${officialVal} (${officialDate})，等级: ${currentLevel}，新鲜度: ${freshness.text}`)
    } catch (e) {
      console.error('[首页] 数据处理出错:', e)
    }
  },

  // ===== 从 CDN 拉取最新官方数据 =====
  fetchRemoteSolarData: function () {
    const that = this
    wx.request({
      url: DAILY_SOLAR_CDN,
      method: 'GET',
      timeout: 8000,
      success: function (res) {
        if (res.statusCode === 200 && res.data && res.data.official_sunspot) {
          console.log('[首页] CDN 数据拉取成功:', res.data.generated_at)
          dailySolar = res.data
          that.loadResult()
          that.setData({
            cdnUpdateTime: res.data.generated_at || '',
            cdnStatus: '已更新'
          })
        } else {
          that.setData({ cdnStatus: '本地数据' })
        }
      },
      fail: function () {
        console.warn('[首页] CDN 拉取失败，使用本地兜底')
        that.setData({ cdnStatus: '本地数据' })
      }
    })
  },

  // ===== 计算数据新鲜度（SILSO 数据相对今天的延迟天数） =====
  computeDataFreshness: function (dateStr) {
    if (!dateStr || dateStr === '未知' || dateStr === '') {
      return { text: '数据日期未知', level: 'danger' }
    }
    try {
      // 解析 official_date（格式 YYYY-MM-DD）
      const parts = dateStr.split('-')
      if (parts.length < 3) return { text: '数据日期格式错误', level: 'danger' }
      const dataDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
      const today = new Date()
      const diffMs = today.getTime() - dataDate.getTime()
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

      if (diffDays < 0) {
        return { text: `数据日期 ${dateStr}（未来数据？）`, level: 'danger' }
      } else if (diffDays <= 4) {
        return { text: `数据新鲜（延迟 ${diffDays} 天）`, level: 'ok' }
      } else if (diffDays <= 7) {
        return { text: `数据延迟 ${diffDays} 天（SILSO 正常延迟范围内）`, level: 'warning' }
      } else if (diffDays <= 14) {
        return { text: `⚠️ 数据延迟 ${diffDays} 天，GitHub Actions 可能未正常运行`, level: 'warning' }
      } else {
        return { text: `🚨 数据严重过期 ${diffDays} 天，请检查数据更新任务`, level: 'danger' }
      }
    } catch (e) {
      return { text: '数据日期解析失败', level: 'danger' }
    }
  },

  loadImageMeta: function () {
    const fs = wx.getFileSystemManager()
    const metaPathList = [
      `${wx.env.USER_DATA_PATH}/../images/solar_today_meta.txt`,
      `${wx.env.USER_DATA_PATH}/../images/solar_fallback_meta.txt`
    ]

    // 默认值
    const defaultMeta = {
      instrument: 'NASA SDO AIA',
      wavelength: '211 Å（极紫外）',
      temperature: '约 1,000,000 K',
      target_layer: '太阳日冕',
      capture_time: '近实时',
      satellite: 'SDO 太阳动力学天文台',
      launch_date: '2010-02-11',
      orbit: '地球同步轨道',
      distance: '距日 1 AU',
      resolution: '512 × 512 px',
      copyright: 'NASA / SDO',
      file_size: '—'
    }

    for (const p of metaPathList) {
      try {
        const content = fs.readFileSync(p, 'utf-8')
        // 解析所有 key=value 行
        const meta = Object.assign({}, defaultMeta)
        const lines = content.split('\n')
        let fetchTime = ''
        for (const line of lines) {
          const idx = line.indexOf('=')
          if (idx > 0) {
            const key = line.substring(0, idx).trim()
            const val = line.substring(idx + 1).trim()
            if (key === 'fetch_time') {
              fetchTime = val
            } else if (meta.hasOwnProperty(key)) {
              meta[key] = val
            }
          }
        }
        this.setData({
          fetchTime: fetchTime || '今日最新',
          imageMeta: meta
        })
        console.log('[首页] 图片属性加载成功:', meta)
        return
      } catch (e) { /* 继续尝试下一个文件 */ }
    }

    // meta 文件都不存在，用默认值
    const d = new Date()
    this.setData({
      fetchTime: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} （今日最新）`,
      imageMeta: defaultMeta
    })
  },

  // 切换属性表展开/折叠
  toggleMeta: function () {
    this.setData({ metaExpanded: !this.data.metaExpanded })
  },

  // 等级颜色与描述（鲜艳版）
  getLevelConfig: function (level) {
    // 4 级鲜艳渐变背景
    const config = {
      '平静': {
        color: 'linear-gradient(135deg, #66bb6a 0%, #43a047 100%)',
        desc: '☀️ 预测黑子数较低，太阳表面活动平稳，大概率无明显爆发。'
      },
      '低度活跃': {
        color: 'linear-gradient(135deg, #ffca28 0%, #ffa000 100%)',
        desc: '🌤️ 预测黑子数略有上升，可能出现少量活动区，对日常生活无影响。'
      },
      '中度活跃': {
        color: 'linear-gradient(135deg, #ff9800 0%, #f57c00 100%)',
        desc: '⚡ 预测黑子数较多，活动区可能产生耀斑，建议关注后续观测。'
      },
      '强爆发': {
        color: 'linear-gradient(135deg, #ef5350 0%, #c62828 100%)',
        desc: '🌋 预测黑子数处于高位，爆发概率显著上升，需结合专业预报综合判断。'
      }
    }
    return config[level] || config['平静']
  },

  onPullDownRefresh: function () {
    this.IMAGE_SOURCES = this.buildImageSources()
    this.loadResult()
    this.tryLoadImage(0)
    this.loadImageMeta()
    wx.stopPullDownRefresh()
  }
})
