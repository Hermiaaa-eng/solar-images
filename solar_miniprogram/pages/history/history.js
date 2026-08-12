// pages/history/history.js - 历史记录页（丰富版 v4）
// 新增：时间尺度切换 / 多周期对比 / 点击详情弹窗 / 趋势预判
// 数据来源：CDN 实时拉取 daily_solar.json（SILSO + NOAA），失败回退本地

let resultData = {}
try {
  resultData = require('../../result.js')
} catch (e) {
  resultData = {}
}

// 官方实时数据：先加载本地兜底，再异步从 CDN 拉最新
let dailySolar = {}
try {
  dailySolar = require('../../daily_solar.json')
} catch (e) {
  dailySolar = {}
}

// CDN 地址（jsdelivr 自动刷新 GitHub 仓库的最新 daily_solar.json）
// 仓库：Hermiaaa-eng/solar-images
const DAILY_SOLAR_CDN = 'https://cdn.jsdelivr.net/gh/Hermiaaa-eng/solar-images@main/solar_miniprogram/daily_solar.json'

// 等级阈值
const LEVEL_HIGH = 100
const LEVEL_MEDIUM = 50

// 耀斑分级模拟数据（按黑子数估算，科普演示用）
function estimateFlareStats(value) {
  // 黑子数越高，耀斑爆发越频繁
  const xFlares = Math.max(0, Math.floor((value - 100) / 25))     // X 级：最强
  const mFlares = Math.max(0, Math.floor(value / 20))              // M 级：中等
  const cFlares = Math.max(0, Math.floor(value / 5))               // C 级：常见
  return { x: xFlares, m: mFlares, c: cFlares }
}

// 当月对地影响事件估算
function estimateGeoEffects(value, level) {
  if (value >= 120) return '强地磁暴事件 2-3 次，短波通信中断，极光可见至中纬度'
  if (value >= 100) return '中等地磁暴 1-2 次，卫星姿态扰动，高纬度极光增强'
  if (value >= 80) return '弱地磁暴可能，短波通信轻微干扰，极光活动正常'
  if (value >= 50) return '地磁活动平静，无明显对地影响'
  return '太阳活动平静期，空间天气稳定'
}

Page({
  data: {
    // 当前时间尺度：1y / 5y / 11y
    timeScale: '1y',
    scaleButtons: [
      { key: '1y', label: '近 1 年' },
      { key: '5y', label: '近 5 年' },
      { key: '11y', label: '完整 11 年周期' }
    ],
    // 是否开启多周期对比
    compareEnabled: false,
    // 历史数据列表（按当前尺度）
    historyList: [],
    // 对比周期数据（第 24 周）
    compareList: [],
    // 统计值
    maxValue: 0,
    minValue: 0,
    avgValue: 0,
    // Canvas 尺寸
    canvasWidth: 340,
    canvasHeight: 260,
    // 周期结论
    cycleConclusion: '',
    // 折叠科普卡片
    kbOpen: false,
    // 详情弹窗
    modalVisible: false,
    modalData: null,
    // 趋势预判
    trendPrediction: '',
    // ===== 新增 4 大功能数据 =====
    // 1. 太阳活动钟
    clockCanvasSize: 280,
    cycleInfo: {
      currentCycle: 25,
      cycleStart: 2019,
      cycleEnd: 2030,
      currentYear: 2026,
      phase: '下降期',
      phaseColor: '#ff9800',
      progress: 64,           // 当前周期完成百分比
      yearsToPeak: 0,
      yearsToMin: 4,
      nextMilestone: '下一个活动极小期',
      nextMilestoneYear: 2030
    },
    // 2. 极光可见概率（默认空，等待 CDN 数据加载后填充）
    auroraInfo: {
      currentLevel: '加载中...',
      currentVal: '—',
      currentDate: '—',
      snMonthlyAvg: '—',
      kpDisplayValue: '—',
      kpPeakValue: '—',
      kpDisplayDesc: '',
      kpDescription: '',
      kpEstimated: false,
      kpPeakNote: '',
      mohe: { prob: 0, level: '加载中', desc: '正在获取官方数据...', peakProb: 0, peakLevel: '', peakDesc: '' },
      nordic: { prob: 0, level: '加载中', desc: '正在获取官方数据...', peakProb: 0, peakLevel: '', peakDesc: '' },
      northAmerica: { prob: 0, level: '加载中', desc: '正在获取官方数据...', peakProb: 0, peakLevel: '', peakDesc: '' },
      dataSource: 'SILSO + NOAA',
      auroraNote: ''
    },
    // 3. 历史大事件
    historicalEvents: [
      {
        year: 1859,
        name: '卡林顿事件',
        cycle: '第 10 周',
        desc: '人类首次记录到的最强太阳风暴，电报系统自发火光，极光可见至赤道',
        value: 200,
        severity: 'extreme'
      },
      {
        year: 1989,
        name: '魁北克大停电',
        cycle: '第 22 周',
        desc: '强地磁暴导致加拿大魁北克全省停电 9 小时，影响 600 万人',
        value: 180,
        severity: 'severe'
      },
      {
        year: 2003,
        name: '万圣节太阳风暴',
        cycle: '第 23 周',
        desc: 'X28 级超级耀斑，多颗卫星受损，国际空间站宇航员避险',
        value: 165,
        severity: 'severe'
      }
    ],
    eventModalVisible: false,
    eventModalData: null,
    // 4. 观测建议
    observationAdvice: {
      title: '',
      icon: '',
      items: [],
      warning: ''
    },
    // CDN 数据更新状态
    cdnUpdateTime: '',
    cdnStatus: '加载中...'
  },

  onLoad: function () {
    const sysInfo = wx.getSystemInfoSync()
    this.setData({
      canvasWidth: sysInfo.windowWidth - 80,
      canvasHeight: 280,
      clockCanvasSize: Math.min(280, sysInfo.windowWidth - 100)
    })
    this.loadData()
    this.computeCycleClock()
    // 先用本地数据渲染一次
    this.computeAurora()
    this.computeObservationAdvice()
    setTimeout(() => this.drawCycleClock(), 200)
    // 异步从 CDN 拉取最新官方数据，成功后重新计算
    this.fetchRemoteSolarData()
  },

  // ===== 从 CDN 拉取最新 daily_solar.json =====
  fetchRemoteSolarData: function () {
    const that = this
    wx.request({
      url: DAILY_SOLAR_CDN,
      method: 'GET',
      timeout: 8000,
      success: function (res) {
        if (res.statusCode === 200 && res.data && res.data.official_sunspot) {
          console.log('[历史] CDN 数据拉取成功:', res.data.generated_at)
          // 更新全局变量
          dailySolar = res.data
          // 重新计算极光概率和观测建议
          that.computeAurora()
          that.computeObservationAdvice()
          that.setData({
            cdnUpdateTime: res.data.generated_at || '',
            cdnStatus: '已更新'
          })
        } else {
          console.warn('[历史] CDN 数据格式异常，使用本地兜底')
          that.setData({ cdnStatus: '本地数据' })
        }
      },
      fail: function (err) {
        console.warn('[历史] CDN 拉取失败，使用本地兜底:', err.errMsg)
        that.setData({ cdnStatus: '本地数据' })
      }
    })
  },

  // ===== 新功能 1：太阳活动钟 =====
  computeCycleClock: function () {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth() + 1
    const yearFraction = currentYear + (currentMonth - 1) / 12

    // 第 25 活动周：2019.0 ~ 2030.0
    const cycleStart = 2019
    const cycleEnd = 2030
    const cycleLength = cycleEnd - cycleStart
    const progress = Math.min(100, Math.max(0, ((yearFraction - cycleStart) / cycleLength) * 100))

    // 阶段判定（基于第 25 周实际进度）
    let phase, phaseColor, yearsToPeak, yearsToMin, nextMilestone, nextMilestoneYear
    if (yearFraction < 2023.5) {
      phase = '上升期'
      phaseColor = '#66bb6a'
      yearsToPeak = Math.max(0, Math.round(2024.5 - yearFraction))
      yearsToMin = Math.round(2030 - yearFraction)
      nextMilestone = '下一个活动峰值期'
      nextMilestoneYear = 2024
    } else if (yearFraction < 2025.5) {
      phase = '峰值期'
      phaseColor = '#ef5350'
      yearsToPeak = 0
      yearsToMin = Math.round(2030 - yearFraction)
      nextMilestone = '下一个活动极小期'
      nextMilestoneYear = 2030
    } else if (yearFraction < 2029.0) {
      phase = '下降期'
      phaseColor = '#ff9800'
      yearsToPeak = 0
      yearsToMin = Math.round(2030 - yearFraction)
      nextMilestone = '下一个活动极小期'
      nextMilestoneYear = 2030
    } else {
      phase = '谷值期'
      phaseColor = '#2196f3'
      yearsToPeak = Math.round(2035 - yearFraction)
      yearsToMin = 0
      nextMilestone = '下一个活动峰值期'
      nextMilestoneYear = 2035
    }

    this.setData({
      cycleInfo: {
        currentCycle: 25,
        cycleStart: cycleStart,
        cycleEnd: cycleEnd,
        currentYear: currentYear,
        phase: phase,
        phaseColor: phaseColor,
        progress: Math.round(progress),
        yearsToPeak: yearsToPeak,
        yearsToMin: yearsToMin,
        nextMilestone: nextMilestone,
        nextMilestoneYear: nextMilestoneYear
      }
    })
  },

  // 绘制环形进度条
  drawCycleClock: function () {
    const ctx = wx.createCanvasContext('cycleClock')
    const size = this.data.clockCanvasSize
    const cx = size / 2
    const cy = size / 2
    const radius = size / 2 - 30
    const lineWidth = 22

    const info = this.data.cycleInfo
    const startAngle = -Math.PI / 2   // 从顶部开始
    const endAngle = startAngle + 2 * Math.PI * (info.progress / 100)

    // 1. 背景圆环（浅灰）
    ctx.setStrokeStyle('rgba(142, 123, 255, 0.12)')
    ctx.setLineWidth(lineWidth)
    ctx.setLineCap('round')
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI)
    ctx.stroke()

    // 2. 阶段分色弧段（4 段：上升/峰值/下降/谷值）
    // 上升期 0-50%、峰值期 50-65%、下降期 65-95%、谷值 95-100%
    const phaseRanges = [
      { start: 0, end: 50, color: 'rgba(102, 187, 106, 0.35)' },     // 上升 绿
      { start: 50, end: 65, color: 'rgba(239, 83, 80, 0.4)' },        // 峰值 红
      { start: 65, end: 95, color: 'rgba(255, 152, 0, 0.35)' },       // 下降 橙
      { start: 95, end: 100, color: 'rgba(33, 150, 243, 0.4)' }       // 谷值 蓝
    ]
    phaseRanges.forEach(p => {
      ctx.setStrokeStyle(p.color)
      ctx.setLineWidth(lineWidth)
      ctx.beginPath()
      ctx.arc(cx, cy, radius, startAngle + 2 * Math.PI * (p.start / 100), startAngle + 2 * Math.PI * (p.end / 100))
      ctx.stroke()
    })

    // 3. 当前进度高亮弧（渐变色）
    const gradient = ctx.createLinearGradient(0, 0, size, size)
    gradient.addColorStop(0, '#6439ff')
    gradient.addColorStop(0.5, '#ff8c42')
    gradient.addColorStop(1, info.phaseColor)
    ctx.setStrokeStyle(gradient)
    ctx.setLineWidth(lineWidth + 2)
    ctx.setLineCap('round')
    ctx.beginPath()
    ctx.arc(cx, cy, radius, startAngle, endAngle)
    ctx.stroke()

    // 4. 当前位置标记点（大圆点）
    const markerX = cx + radius * Math.cos(endAngle)
    const markerY = cy + radius * Math.sin(endAngle)
    ctx.setFillStyle('#fff')
    ctx.beginPath()
    ctx.arc(markerX, markerY, lineWidth / 2 + 4, 0, 2 * Math.PI)
    ctx.fill()
    ctx.setFillStyle(info.phaseColor)
    ctx.beginPath()
    ctx.arc(markerX, markerY, lineWidth / 2, 0, 2 * Math.PI)
    ctx.fill()

    // 5. 中心文字
    ctx.setTextAlign('center')
    ctx.setFillStyle('#1a1050')
    ctx.setFontSize(16)
    ctx.fillText('第 25 太阳活动周', cx, cy - 32)

    ctx.setFillStyle(info.phaseColor)
    ctx.setFontSize(22)
    ctx.setFontSize(20)
    ctx.fillText(info.phase, cx, cy - 5)

    ctx.setFillStyle('#888')
    ctx.setFontSize(11)
    ctx.fillText(`进度 ${info.progress}%`, cx, cy + 20)

    ctx.setFillStyle('#aaa')
    ctx.setFontSize(10)
    const milestoneText = info.yearsToMin > 0
      ? `距极小期 ${info.yearsToMin} 年`
      : `距峰值期 ${info.yearsToPeak} 年`
    ctx.fillText(milestoneText, cx, cy + 38)

    ctx.draw()
  },

  // ===== 新功能 2：极光可见概率（基于 Kp 指数 + 地磁学公式） =====
  computeAurora: function () {
    // 优先使用官方数据（daily_solar.json from SILSO + NOAA）
    const auroraData = dailySolar.aurora_probability || []
    const kpInfo = dailySolar.official_kp || {}
    const snInfo = dailySolar.official_sunspot || {}
    const monthlyAvg = dailySolar.monthly_avg_13months || 0

    let currentLevel = '', moheInfo = { prob: 0, level: '', desc: '' }
    let nordicInfo = { prob: 0, level: '', desc: '' }
    let naInfo = { prob: 0, level: '', desc: '' }

    // 获取当前黑子数（仅用官方实测，不再用 LSTM 预测兜底）
    const snVal = snInfo.value || 0
    const avgSn = monthlyAvg || snVal

    // Kp 值：优先用官方实测/典型值，不再用 3+0.05R 理论上限
    let kpVal = 0
    if (kpInfo.value && !isNaN(kpInfo.value)) {
      kpVal = kpInfo.value
    } else {
      // 无官方数据时用 NOAA 历史典型值 3.3，不使用理论上限
      kpVal = 3.3
    }

    // 理论上限 Kp_peak（仅科普展示）
    const kpPeak = kpInfo.kp_peak_potential || 0

    if (auroraData.length >= 3) {
      // 从官方 JSON 读取三个地点的极光概率（当前概率 + 峰值概率）
      moheInfo = {
        prob: auroraData[0].probability,
        level: auroraData[0].level,
        desc: auroraData[0].desc,
        peakProb: auroraData[0].peak_probability || 0,
        peakLevel: auroraData[0].peak_level || '',
        peakDesc: auroraData[0].peak_desc || ''
      }
      nordicInfo = {
        prob: auroraData[1].probability,
        level: auroraData[1].level,
        desc: auroraData[1].desc,
        peakProb: auroraData[1].peak_probability || 0,
        peakLevel: auroraData[1].peak_level || '',
        peakDesc: auroraData[1].peak_desc || ''
      }
      naInfo = {
        prob: auroraData[2].probability,
        level: auroraData[2].level,
        desc: auroraData[2].desc,
        peakProb: auroraData[2].peak_probability || 0,
        peakLevel: auroraData[2].peak_level || '',
        peakDesc: auroraData[2].peak_desc || ''
      }

      if (snVal >= 100) currentLevel = '高活动'
      else if (snVal >= 50) currentLevel = '中活动'
      else if (snVal > 0) currentLevel = '低活动'
      else currentLevel = '暂无数据'
    } else {
      // 无官方极光数据：明确提示"暂无数据"，不再用公式自行计算
      const noDataDesc = '⚠️ 暂无官方极光概率数据，请稍后重试或检查数据更新'
      moheInfo = { prob: 0, level: '暂无数据', desc: noDataDesc, peakProb: 0, peakLevel: '', peakDesc: '' }
      nordicInfo = { prob: 0, level: '暂无数据', desc: noDataDesc, peakProb: 0, peakLevel: '', peakDesc: '' }
      naInfo = { prob: 0, level: '暂无数据', desc: noDataDesc, peakProb: 0, peakLevel: '', peakDesc: '' }
      currentLevel = '暂无数据'
    }

    // Kp 等级描述
    let kpDesc = ''
    if (kpVal <= 3) kpDesc = `${kpVal.toFixed(1)}（平静期，Kp<3 地磁活动平静）`
    else if (kpVal <= 5) kpDesc = `${kpVal.toFixed(1)}（微扰期，Kp 4-5 地磁微扰）`
    else if (kpVal <= 7) kpDesc = `${kpVal.toFixed(1)}（中等地磁暴，Kp 6-7）`
    else kpDesc = `${kpVal.toFixed(1)}（强地磁暴，Kp 8-9）`

    this.setData({
      auroraInfo: {
        currentLevel: currentLevel,
        currentVal: snVal > 0 ? snVal.toFixed(1) : '—',
        currentDate: snInfo.date || '未知',
        snMonthlyAvg: avgSn > 0 ? avgSn.toFixed(1) : '—',
        kpDisplayValue: kpVal.toFixed(1),
        kpPeakValue: kpPeak > 0 ? kpPeak.toFixed(1) : '—',
        kpDisplayDesc: kpDesc,
        kpDescription: kpInfo.description || kpDesc,
        kpEstimated: kpInfo.estimated || false,
        kpPeakNote: kpInfo.peak_note || '',
        mohe: moheInfo,
        nordic: nordicInfo,
        northAmerica: naInfo,
        dataSource: snInfo.source || 'SILSO 比利时皇家天文台',
        auroraNote: dailySolar.aurora_note || '极光可见概率基于当前 Kp 指数（NOAA 实测或历史典型值）计算。实际极光出现还受当日地磁暴强度、天气、月相影响。'
      }
    })
  },

  // ===== 新功能 3：历史大事件 =====
  onEventTap: function (e) {
    const idx = e.currentTarget.dataset.idx
    const event = this.data.historicalEvents[idx]
    if (event) {
      this.setData({
        eventModalVisible: true,
        eventModalData: event
      })
    }
  },

  closeEventModal: function () {
    this.setData({ eventModalVisible: false })
  },

  // ===== 新功能 4：观测建议助手（基于官方耀斑预报） =====
  computeObservationAdvice: function () {
    // 仅使用官方数据（daily_solar.json），不再用 LSTM 预测兜底
    const flareData = dailySolar.flare_forecast || {}
    const snInfo = dailySolar.official_sunspot || {}

    const snVal = snInfo.value || 0
    const cPct = flareData.c_class_percent || 0
    const mPct = flareData.m_class_percent || 0
    const xPct = flareData.x_class_percent || 0

    let title, icon, items, warning
    if (snVal >= 100) {
      title = '高活动期观测建议'
      icon = '🌋'
      items = [
        `🔭 太阳黑子：当前 ${snVal}（SILSO 实测），可观测到大量黑子群`,
        `☀️ 日珥：边缘日珥活跃，适合摄影记录`,
        `⚡ 耀斑：M 级概率 ${mPct}%，X 级概率 ${xPct}%`,
        `📡 短波无线电：可监听太阳射电爆发`
      ]
      warning = '⚠️ 必须使用巴德膜或专用太阳滤镜，严禁裸眼观测！'
    } else if (snVal >= 50) {
      title = '中活动期观测建议'
      icon = '🌤️'
      items = [
        `🔭 太阳黑子：当前 ${snVal}（SILSO 实测），可观测到中等数量黑子群`,
        `☀️ 日珥：边缘偶有日珥出现`,
        `⚡ 耀斑：C 级概率 ${cPct}%，M 级概率 ${mPct}%`,
        `🌌 夜间极光：高纬度地区可关注空间天气预报`
      ]
      warning = '⚠️ 观测太阳必须使用巴德膜或专用滤镜！'
    } else if (snVal > 0) {
      title = '低活动期观测建议'
      icon = '🌙'
      items = [
        `🌑 日冕：日全食时可观测壮丽日冕`,
        `💫 太阳风：关注极光预报（高纬度地区）`,
        `⚡ 耀斑：C 级概率 ${cPct}%，偶有 M 级爆发`,
        `📡 射电观测：可监听宁静太阳射电信号`
      ]
      warning = '⚠️ 即便太阳活动低，直接观测仍需专业设备！'
    } else {
      title = '暂无官方数据'
      icon = '📡'
      items = ['⚠️ 暂无 SILSO 实测黑子数数据', '请稍后重试或检查 GitHub Actions 是否正常运行']
      warning = '数据加载中，请稍候'
    }

    this.setData({
      observationAdvice: {
        title: title,
        icon: icon,
        items: items,
        warning: warning,
        currentVal: snVal > 0 ? snVal.toFixed(1) : '—',
        currentDate: snInfo.date || '未知',
        cPct: cPct,
        mPct: mPct,
        xPct: xPct,
        dataSource: flareData.source || 'NOAA SWPC 耀斑预报',
        note: flareData.note || ''
      }
    })
  },

  // ===== 时间尺度切换 =====
  onScaleChange: function (e) {
    const scale = e.currentTarget.dataset.scale
    if (scale === this.data.timeScale) return
    this.setData({ timeScale: scale })
    this.loadData()
  },

  // ===== 多周期对比开关 =====
  toggleCompare: function () {
    const newVal = !this.data.compareEnabled
    this.setData({ compareEnabled: newVal })
    this.loadData()
  },

  // ===== 折叠科普卡片 =====
  toggleKnowledge: function () {
    this.setData({ kbOpen: !this.data.kbOpen })
  },

  // ===== 详情弹窗关闭 =====
  closeModal: function () {
    this.setData({ modalVisible: false })
  },

  // 阻止冒泡（点击弹窗内部不关闭）
  stopPropagation: function () {},

  // ===== 点击折线图节点 =====
  onChartTap: function (e) {
    const idx = e.currentTarget.dataset.idx
    const item = this.data.historyList[idx]
    if (item) this.showDetail(item)
  },

  // ===== 点击列表某一行 =====
  onListItemTap: function (e) {
    const idx = e.currentTarget.dataset.idx
    const item = this.data.historyList[idx]
    if (item) this.showDetail(item)
  },

  // 显示详情弹窗
  showDetail: function (item) {
    const val = Number(item.value) || 0
    const level = this.getClassByValue(val)
    const flares = estimateFlareStats(val)
    const geoEffect = estimateGeoEffects(val, level)
    const modalData = {
      date: item.date,
      rawDate: item.raw_date || item.date,
      value: val.toFixed(1),
      level: this.getLevelName(level),
      levelClass: level,
      flares: flares,
      geoEffect: geoEffect,
      knowledgeLink: this.getKnowledgeLink(level)
    }
    this.setData({
      modalVisible: true,
      modalData: modalData
    })
  },

  getLevelName: function (level) {
    if (level === 'high') return '高活动'
    if (level === 'medium') return '中活动'
    return '低活动'
  },

  getKnowledgeLink: function (level) {
    if (level === 'high') return '耀斑与日冕物质抛射（科普知识页）'
    if (level === 'medium') return '太阳黑子活动（科普知识页）'
    return '安全观测指南（科普知识页）'
  },

  // ===== 数据加载主流程 =====
  loadData: function () {
    const scale = this.data.timeScale
    let rawList = []
    let compareList = []

    if (scale === '1y') {
      rawList = resultData['历史数据'] || []
    } else if (scale === '5y') {
      rawList = resultData['历史数据_5年'] || []
    } else {
      rawList = resultData['历史数据_11年'] || []
    }

    // 多周期对比仅 11 年尺度有意义
    if (this.data.compareEnabled && scale === '11y') {
      compareList = resultData['周期对比_第24周'] || []
    }

    if (!rawList.length) {
      console.warn('[历史] 无历史数据')
      return
    }

    // 计算统计值
    const values = rawList.map(d => Number(d.value) || 0)
    const maxVal = Math.max(...values)
    const minVal = Math.min(...values)
    const avgVal = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)

    // 构造列表
    const list = rawList.map((item, idx) => {
      const val = Number(item.value) || 0
      const level = this.getClassByValue(val)
      return {
        date: item.date,
        raw_date: item.raw_date || item.date,
        value: val,
        level: level,
        levelClass: level,
        barColor: this.getBarColorByLevel(level),
        valueColor: this.getValueColorByLevel(level),
        hasFlare: val >= LEVEL_HIGH,
        phenomenon: this.getPhenomenon(item.date, val, level, val >= LEVEL_HIGH),
        idx: idx
      }
    })

    // 对比列表处理
    const cmpList = compareList.map(item => ({
      date: item.date,
      raw_date: item.raw_date || item.date,
      value: Number(item.value) || 0
    }))

    const cycleConclusion = this.buildCycleConclusion(values, rawList, scale)
    const trendPrediction = this.buildTrendPrediction(values, scale)

    this.setData({
      historyList: list,
      compareList: cmpList,
      maxValue: maxVal,
      minValue: minVal,
      avgValue: avgVal,
      cycleConclusion: cycleConclusion,
      trendPrediction: trendPrediction
    })

    setTimeout(() => this.drawChart(list, cmpList), 150)
  },

  getClassByValue: function (val) {
    if (val >= LEVEL_HIGH) return 'high'
    if (val >= LEVEL_MEDIUM) return 'medium'
    return 'low'
  },

  getBarColorByLevel: function (level) {
    if (level === 'high') return 'linear-gradient(90deg, #ff5252 0%, #ff1744 100%)'
    if (level === 'medium') return 'linear-gradient(90deg, #2196f3 0%, #1565c0 100%)'
    return 'linear-gradient(90deg, #66bb6a 0%, #43a047 100%)'
  },

  getValueColorByLevel: function (level) {
    if (level === 'high') return '#d32f2f'
    if (level === 'medium') return '#1565c0'
    return '#2e7d32'
  },

  getPhenomenon: function (date, val, level, hasFlare) {
    const parts = (date || '').split('-')
    const year = parts[0] || ''
    if (level === 'high') {
      if (hasFlare) return `${date} 黑子数高位，耀斑高发期，需关注空间天气`
      return `${date} 活动水平较高，黑子群数量多`
    }
    if (level === 'medium') return `${date} 中度活动期，黑子数中等水平`
    if (val < 20) return `${date} 接近活动极小期，黑子群极少`
    return `${date} 低活动水平，太阳表面平静`
  },

  buildCycleConclusion: function (values, rawList, scale) {
    const maxIdx = values.indexOf(Math.max(...values))
    const peakDate = rawList[maxIdx]?.date || '未知'
    const peakVal = Math.max(...values).toFixed(1)
    const latestVal = values[values.length - 1]
    const firstVal = values[0]
    const trend = latestVal < firstVal ? '回落' : '上升'
    const scaleText = scale === '1y' ? '近 1 年' : scale === '5y' ? '近 5 年' : '完整 11 年周期'
    return `【${scaleText}视图】当前太阳处于第 25 活动周，${trend}阶段。峰值约在 ${peakDate}（${peakVal}），目前逐步向谷值过渡。`
  },

  // ===== 趋势预判（基于 11 年周期规律） =====
  buildTrendPrediction: function (values, scale) {
    const latestVal = values[values.length - 1]
    const maxVal = Math.max(...values)
    const yearsToMin = 2030 - 2026

    let trend = ''
    if (latestVal < 50) {
      trend = `当前黑子数 ${latestVal.toFixed(1)} 已处于中低位区间。按 11 年周期规律，未来 2 年太阳活动将持续减弱，预计 ${yearsToMin} 年前后进入下一个活动极小期，地磁暴、极光出现概率会相应降低。`
    } else if (latestVal < 100) {
      trend = `当前黑子数 ${latestVal.toFixed(1)} 处于中等水平。本轮周期峰值已过（约 ${maxVal.toFixed(1)}），未来 12-18 个月将持续回落，预计 2028-2030 年进入低谷期。`
    } else {
      trend = `当前黑子数 ${latestVal.toFixed(1)} 仍处于高位。本轮周期可能仍接近峰值，未来 6-12 个月需持续关注耀斑与地磁暴活动。`
    }
    return trend
  },

  // ===== Canvas 绘制（支持多周期对比） =====
  drawChart: function (list, compareList) {
    const ctx = wx.createCanvasContext('lineChart')
    const w = this.data.canvasWidth
    const h = this.data.canvasHeight
    const padding = { top: 25, right: 20, bottom: 45, left: 45 }
    const chartW = w - padding.left - padding.right
    const chartH = h - padding.top - padding.bottom

    // 合并计算 Y 轴范围
    const allValues = list.map(d => d.value)
    if (compareList.length) {
      compareList.forEach(d => allValues.push(d.value))
    }
    const maxV = Math.max(...allValues, 140)
    const minV = Math.min(...allValues, 0)
    const range = maxV - minV || 1

    const dataPoints = list.map((d, i) => ({
      x: padding.left + (i / (list.length - 1 || 1)) * chartW,
      y: padding.top + chartH - ((d.value - minV) / range) * chartH,
      v: d.value,
      date: d.date,
      level: d.level,
      hasFlare: d.hasFlare,
      isPeak: d.value === Math.max(...list.map(x => x.value)),
      idx: i
    }))

    // 对比周期数据点
    let comparePoints = []
    if (compareList.length) {
      comparePoints = compareList.map((d, i) => ({
        x: padding.left + (i / (compareList.length - 1 || 1)) * chartW,
        y: padding.top + chartH - ((d.value - minV) / range) * chartH,
        v: d.value,
        date: d.date
      }))
    }

    // 1. 背景
    ctx.setFillStyle('#ffffff')
    ctx.fillRect(0, 0, w, h)

    // 2. 等级色带背景
    const highY = padding.top + chartH - ((LEVEL_HIGH - minV) / range) * chartH
    const mediumY = padding.top + chartH - ((LEVEL_MEDIUM - minV) / range) * chartH

    ctx.setFillStyle('rgba(255, 82, 82, 0.06)')
    ctx.fillRect(padding.left, padding.top, chartW, highY - padding.top)
    ctx.setFillStyle('rgba(33, 150, 243, 0.06)')
    ctx.fillRect(padding.left, highY, chartW, mediumY - highY)
    ctx.setFillStyle('rgba(102, 187, 106, 0.06)')
    ctx.fillRect(padding.left, mediumY, chartW, padding.top + chartH - mediumY)

    // 3. 等级分界虚线
    ctx.setStrokeStyle('#ff5252')
    ctx.setLineDash([4, 4])
    ctx.setLineWidth(1)
    ctx.beginPath()
    ctx.moveTo(padding.left, highY)
    ctx.lineTo(padding.left + chartW, highY)
    ctx.stroke()

    ctx.setStrokeStyle('#2196f3')
    ctx.beginPath()
    ctx.moveTo(padding.left, mediumY)
    ctx.lineTo(padding.left + chartW, mediumY)
    ctx.stroke()
    ctx.setLineDash([])

    // 4. 等级标签
    ctx.setFontSize(10)
    ctx.setFillStyle('#ff5252')
    ctx.fillText('高/中 100', padding.left + 4, highY - 3)
    ctx.setFillStyle('#2196f3')
    ctx.fillText('中/低 50', padding.left + 4, mediumY - 3)

    // 5. Y 轴刻度
    ctx.setFillStyle('#888')
    ctx.setFontSize(10)
    const ySteps = [0, 0.25, 0.5, 0.75, 1]
    ySteps.forEach(step => {
      const val = Math.round(minV + step * range)
      const y = padding.top + chartH - step * chartH
      ctx.setFillStyle('#aaa')
      ctx.fillText(String(val), 6, y + 3)
      ctx.setStrokeStyle('#eee')
      ctx.setLineWidth(0.5)
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(padding.left + chartW, y)
      ctx.stroke()
    })

    // 6. 对比周期折线（第 24 周，灰色虚线）
    if (comparePoints.length) {
      ctx.setStrokeStyle('rgba(150, 150, 150, 0.6)')
      ctx.setLineDash([6, 4])
      ctx.setLineWidth(1.8)
      ctx.beginPath()
      comparePoints.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      })
      ctx.stroke()
      ctx.setLineDash([])

      // 对比周期数据点（灰色小圆）
      comparePoints.forEach(p => {
        ctx.setFillStyle('#999')
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
        ctx.fill()
      })
    }

    // 7. 主折线渐变
    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
    gradient.addColorStop(0, 'rgba(255, 107, 53, 0.95)')
    gradient.addColorStop(0.5, 'rgba(100, 57, 255, 0.95)')
    gradient.addColorStop(1, 'rgba(102, 187, 106, 0.95)')

    ctx.setStrokeStyle(gradient)
    ctx.setLineWidth(2.8)
    ctx.beginPath()
    dataPoints.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.stroke()

    // 8. 折线下方填充
    const fillGradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
    fillGradient.addColorStop(0, 'rgba(255, 107, 53, 0.22)')
    fillGradient.addColorStop(1, 'rgba(102, 187, 106, 0.02)')
    ctx.setFillStyle(fillGradient)
    ctx.beginPath()
    ctx.moveTo(dataPoints[0].x, padding.top + chartH)
    dataPoints.forEach(p => ctx.lineTo(p.x, p.y))
    ctx.lineTo(dataPoints[dataPoints.length - 1].x, padding.top + chartH)
    ctx.closePath()
    ctx.fill()

    // 9. 数据点
    dataPoints.forEach(p => {
      const colorMap = { high: '#ff5252', medium: '#2196f3', low: '#66bb6a' }
      ctx.setFillStyle(colorMap[p.level] || '#6439ff')
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.setStrokeStyle('#ffffff')
      ctx.setLineWidth(1.5)
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2)
      ctx.stroke()
    })

    // 10. 峰值标注
    const peakPoint = dataPoints.find(p => p.isPeak)
    if (peakPoint) {
      ctx.setStrokeStyle('#ff1744')
      ctx.setLineWidth(2)
      ctx.beginPath()
      ctx.arc(peakPoint.x, peakPoint.y, 9, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setFillStyle('#ff1744')
      ctx.setFontSize(9)
      ctx.fillText('⬇ 本轮峰值', peakPoint.x - 28, peakPoint.y - 14)
    }

    // 11. 耀斑 ⚡ 图标
    dataPoints.forEach(p => {
      if (p.hasFlare && !p.isPeak) {
        ctx.setFontSize(12)
        ctx.setFillStyle('#ff9800')
        ctx.fillText('⚡', p.x - 5, p.y - 10)
      }
    })

    // 12. X 轴日期
    ctx.setFillStyle('#888')
    ctx.setFontSize(9)
    const step = Math.max(1, Math.floor(dataPoints.length / 6))
    dataPoints.forEach((p, i) => {
      if (i % step === 0 || i === dataPoints.length - 1) {
        ctx.fillText(p.date, p.x - 18, h - padding.bottom + 18)
      }
    })

    // 13. 对比图例（如果开启）
    if (comparePoints.length) {
      ctx.setFontSize(10)
      ctx.setFillStyle('#ff6b35')
      ctx.fillText('━ 第 25 周（当前）', padding.left + chartW - 200, padding.top + 12)
      ctx.setFillStyle('#999')
      ctx.fillText('┄ 第 24 周（上一轮）', padding.left + chartW - 100, padding.top + 12)
    }

    ctx.draw()
  },

  onPullDownRefresh: function () {
    this.loadData()
    wx.stopPullDownRefresh()
  }
})
