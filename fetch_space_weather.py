# -*- coding: utf-8 -*-
"""
fetch_space_weather.py
======================
从官方权威数据源获取每日太阳活动实况数据，输出 daily_solar.json。

数据源（全部官方权威）：
  1. SILSO 日度太阳黑子数 SN_d_tot_V2.0.csv（每日一个实测值）
     下载地址：https://www.sidc.be/silso/DATA/SN_d_tot_V2.0.csv
  2. NOAA SWPC 行星 Kp 指数实时 API
     https://services.swpc.noaa.gov/json/planetary_k_index_1m.json
  3. 公式兜底：Kp_peak ≈ 3 + 0.05 × R（R = 13 月平均黑子数）

极光概率计算公式（地磁学公认模型）：
  ① Kp_peak = 3 + 0.05 × R            （R = 13 月平均黑子数）
  ② Kp_min = (90 − 地磁纬度) / 10      （地磁纬度 ≈ 地理纬度 − 7°）
  ③ P = 100 × min(1, max(0, (Kp − Kp_min) / (9 − Kp_min)))

运行方式：
  本地：  python fetch_space_weather.py
  GitHub Actions：每天 UTC 00:00 自动运行（见 .github/workflows/update_solar_data.yml）
"""

import os
import sys
import json
import math
import time
import requests
from datetime import datetime, timedelta
from pathlib import Path

# 抑制 verify=False 产生的 SSL 警告（GitHub Actions 上 NOAA 偶发证书问题需要降级）
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    pass

# 修复 Windows 控制台编码问题（GBK 无法输出 emoji）
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

BASE_DIR = Path(__file__).resolve().parent
MINIPROGRAM_DIR = BASE_DIR / 'solar_miniprogram'
OUTPUT_JSON = MINIPROGRAM_DIR / 'daily_solar.json'
SILSO_DAILY_CSV = BASE_DIR / 'SN_d_tot_V2.0.csv'       # 日度数据
SILSO_MONTHLY_CSV = BASE_DIR / 'SN_m_tot_V2.0.csv'     # 月度数据（用于13月平均）

# 官方下载地址
SILSO_DAILY_URL = 'https://www.sidc.be/silso/DATA/SN_d_tot_V2.0.csv'
SILSO_MONTHLY_URL = 'https://www.sidc.be/silso/DATA/SN_m_tot_V2.0.csv'
NOAA_KP_API = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'
NOAA_DAILY_API = 'https://services.swpc.noaa.gov/json/daily-solar-data.json'  # NOAA 每日太阳数据（含初步黑子数）

TIMEOUT = 30


def log(msg: str) -> None:
    """打印带时间戳的日志"""
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] {msg}', flush=True)


# ========== 1. SILSO 日度太阳黑子数 ==========

def download_silso_daily() -> bool:
    """从 SILSO 官网下载日度黑子数 CSV（覆盖本地文件），带 3 次重试"""
    log(f'⬇️  下载 SILSO 日度数据: {SILSO_DAILY_URL}')
    for attempt in range(3):
        try:
            resp = requests.get(SILSO_DAILY_URL, timeout=TIMEOUT, verify=False)
            if resp.status_code == 200 and resp.text.strip():
                with open(SILSO_DAILY_CSV, 'w', encoding='utf-8') as f:
                    f.write(resp.text)
                log(f'✅ 日度数据已保存: {SILSO_DAILY_CSV}（{len(resp.text)} 字节）')
                return True
            else:
                log(f'⚠️  下载失败 (尝试 {attempt + 1}/3)，HTTP {resp.status_code}')
        except Exception as e:
            log(f'⚠️  下载异常 (尝试 {attempt + 1}/3): {e}')
        if attempt < 2:
            time.sleep(5)
    log('⚠️  SILSO 日度数据下载全部失败，将使用本地已有 CSV')
    return False


def load_silso_daily() -> dict:
    """读取 SILSO 日度 CSV，返回最新一天的实测黑子数"""
    result = {
        'source': 'SILSO 日度数据（比利时皇家天文台，每日实测）',
        'success': False,
        'latest_date': '',
        'latest_value': 0,
        'history_30days': []
    }

    # 如果本地没有 CSV，尝试下载
    if not SILSO_DAILY_CSV.exists():
        log('⚠️  本地无日度 CSV，尝试在线下载...')
        if not download_silso_daily():
            return result

    try:
        with open(SILSO_DAILY_CSV, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()

        # SILSO 日度 CSV 格式（无表头，分号分隔）：
        # Year;Month;Day;Decimal_Date;Daily_Sunspot_Number;Daily_Stddev;Num_Obs;Definitive_Provisional
        data_rows = []
        for line in lines:
            line = line.strip()
            if line.startswith('#') or not line:
                continue
            parts = line.split(';')
            if len(parts) >= 5:
                try:
                    year = int(parts[0])
                    month = int(parts[1])
                    day = int(parts[2])
                    sn = float(parts[4]) if parts[4].strip() else -1
                    if sn >= 0:  # -1 表示无观测
                        data_rows.append({
                            'year': year,
                            'month': month,
                            'day': day,
                            'date': f'{year:04d}-{month:02d}-{day:02d}',
                            'sn': sn
                        })
                except (ValueError, IndexError):
                    continue

        if not data_rows:
            log('⚠️  日度 CSV 解析后无有效数据')
            return result

        # 取最后一行作为最新数据
        latest = data_rows[-1]
        result['latest_date'] = latest['date']
        result['latest_value'] = round(latest['sn'], 1)
        result['success'] = True

        # 取最近 30 天历史
        history = data_rows[-30:]
        result['history_30days'] = [{
            'date': r['date'],
            'value': round(r['sn'], 1)
        } for r in history]

        log(f'✅ SILSO 日度: 最新 {result["latest_date"]} 黑子数 {result["latest_value"]}')

    except Exception as e:
        log(f'❌ SILSO 日度读取异常: {e}')

    return result


def load_silso_daily_full() -> list:
    """读取 SILSO 日度 CSV 全量数据（用于计算 13 月平均）"""
    if not SILSO_DAILY_CSV.exists():
        log('⚠️  无日度 CSV，返回空数据')
        return []

    try:
        with open(SILSO_DAILY_CSV, 'r', encoding='utf-8', errors='ignore') as f:
            lines = f.readlines()

        data_rows = []
        for line in lines:
            line = line.strip()
            if line.startswith('#') or not line:
                continue
            parts = line.split(';')
            if len(parts) >= 5:
                try:
                    year = int(parts[0])
                    month = int(parts[1])
                    day = int(parts[2])
                    sn = float(parts[4]) if parts[4].strip() else -1
                    if sn >= 0:
                        data_rows.append({
                            'year': year,
                            'month': month,
                            'day': day,
                            'date': f'{year:04d}-{month:02d}-{day:02d}',
                            'sn': sn
                        })
                except (ValueError, IndexError):
                    continue

        log(f'📚 加载日度全量数据: {len(data_rows)} 条')
        return data_rows

    except Exception as e:
        log(f'❌ 日度全量读取异常: {e}')
        return []


# ========== 2. 从日度数据计算 13 月平均（最可靠方式） ==========

def compute_monthly_avg_from_daily(daily_data: list) -> dict:
    """
    从日度黑子数据计算每月平均值，再取最近 13 个月的滑动平均。
    这是最可靠的方式，因为日度数据每天更新，不会出现月度 CSV 延迟问题。
    """
    result = {
        'success': False,
        'monthly_avg_13months': 0,
        'history_13months': []
    }

    if not daily_data:
        log('⚠️  无日度数据，无法计算月度平均')
        return result

    # 按月分组计算月均值
    monthly_groups = {}
    for row in daily_data:
        date_str = row['date']
        year_month = date_str[:7]  # e.g., "2026-07"
        if year_month not in monthly_groups:
            monthly_groups[year_month] = []
        monthly_groups[year_month].append(row['sn'])

    monthly_avgs = []
    for ym in sorted(monthly_groups.keys()):
        values = monthly_groups[ym]
        avg = sum(values) / len(values)
        monthly_avgs.append({
            'date': ym,
            'value': round(avg, 1)
        })

    log(f'📊 从日度数据计算出 {len(monthly_avgs)} 个月的月均值')

    # 取最近 13 个月
    if len(monthly_avgs) >= 13:
        last_13 = monthly_avgs[-13:]
    elif len(monthly_avgs) >= 3:
        last_13 = monthly_avgs  # 不足 13 个月时用全部
    else:
        log('⚠️  有效月份不足 3 个月')
        return result

    result['history_13months'] = last_13
    result['monthly_avg_13months'] = round(sum(r['value'] for r in last_13) / len(last_13), 1)
    result['success'] = True
    log(f'✅ 13 月平均黑子数（从日度数据计算）: {result["monthly_avg_13months"]}')

    return result


# ========== 3. NOAA SWPC Kp 指数实时 API ==========

def fetch_kp_realtime(r_value: float = None) -> dict:
    """
    从 NOAA SWPC 获取实时 Kp 指数。
    失败时使用 NOAA 历史统计的"地磁活动典型值"（约 3.3），而非理论上限。

    重要区分：
      - kp_value:           当前实际/典型 Kp（用于极光概率计算）
      - kp_peak_potential:  基于黑子数的活动周期理论上限（仅科普展示，不作极光概率依据）

    修正说明：原逻辑用 Kp_peak=3+0.05R 作为"当前 Kp"代入极光公式，
    导致非地磁暴日也显示 80%+ 极光概率，严重误导用户。
    """
    result = {
        'source': 'NOAA SWPC 实时 API',
        'success': False,
        'kp_estimated': False,
        'kp_value': 0,
        'kp_peak_potential': 0,
        'kp_description': ''
    }

    # 1. 计算活动周期理论上限（无论 NOAA 是否可达，都作为科普参考）
    if r_value is not None and r_value > 0:
        kp_peak = min(9, max(0, 3 + 0.05 * r_value))
        result['kp_peak_potential'] = round(kp_peak, 2)
    else:
        result['kp_peak_potential'] = 4.0

    # 2. 尝试 NOAA 实时 Kp API（带 3 次重试）
    for attempt in range(3):
        try:
            log(f'⬇️  获取 NOAA Kp 实时数据 (尝试 {attempt + 1}/3): {NOAA_KP_API}')
            resp = requests.get(NOAA_KP_API, timeout=TIMEOUT, verify=False)
            if resp.status_code == 200:
                data = resp.json()
                # NOAA Kp API 返回格式：[{"time_tag": "...", "kp": "3.0", ...}, ...]
                # 注意：kp 字段可能是字符串也可能是数字，需要统一转 float
                if isinstance(data, list) and len(data) > 0:
                    def _parse_kp(entry):
                        """安全解析 Kp 值（处理字符串/数字/None）"""
                        raw = entry.get('kp', -1)
                        try:
                            v = float(raw)
                            return v if v >= 0 else -1
                        except (TypeError, ValueError):
                            return -1

                    valid_kp = [(d, _parse_kp(d)) for d in data]
                    valid_kp = [(d, v) for d, v in valid_kp if v >= 0]
                    if valid_kp:
                        # 取最近 24 小时内的最大 Kp（更能反映当日地磁活动水平）
                        recent = valid_kp[-24:] if len(valid_kp) >= 24 else valid_kp
                        latest_kp = max(v for _, v in recent)
                        result['kp_value'] = latest_kp
                        result['source'] = 'NOAA SWPC 实测 Kp（planetary_k_index_1m.json，近 24 小时最大值）'
                        result['success'] = True
                        log(f'✅ NOAA Kp 实测: {latest_kp}（近 24h 最大）')
                        return result
            log(f'⚠️  NOAA API 返回 HTTP {resp.status_code}')
        except Exception as e:
            log(f'⚠️  NOAA Kp API 不可达 (尝试 {attempt + 1}/3): {e}')
        if attempt < 2:
            time.sleep(3)

    # 3. NOAA 完全不可达：使用 NOAA 历史统计的"地磁活动典型值"
    #    历史统计：非地磁暴日 Kp 通常在 2-4 之间，长期均值约 3.3
    #    注意：此处绝不使用 Kp_peak=3+0.05R（那是理论上限，会严重高估极光概率）
    typical_kp = 3.3
    result['kp_value'] = typical_kp
    result['kp_estimated'] = True
    result['source'] = (
        f'NOAA 实测不可达，使用地磁活动历史典型值 Kp≈{typical_kp}（NOAA 长期统计均值，'
        f'非活动周期理论上限 Kp_peak={result["kp_peak_potential"]}）'
    )
    result['success'] = True
    log(f'📐 NOAA 不可达 → 使用典型值 Kp={typical_kp}（理论上限 Kp_peak={result["kp_peak_potential"]} 仅作科普参考）')

    return result


# ========== 3.5 NOAA 每日太阳数据（补充数据源，延迟更低） ==========

def fetch_noaa_daily_solar() -> dict:
    """
    从 NOAA SWPC 获取每日太阳数据（延迟约 1 天，比 SILSO 的 4-5 天更快）。
    注意：NOAA 数据为初步值，未经 SILSO 最终校准，仅作补充参考。
    """
    result = {
        'success': False,
        'source': 'NOAA SWPC 每日太阳数据',
        'date': '',
        'sunspot': 0,
        'note': ''
    }

    for attempt in range(2):
        try:
            log(f'⬇️  获取 NOAA 每日太阳数据 (尝试 {attempt + 1}/2): {NOAA_DAILY_API}')
            resp = requests.get(NOAA_DAILY_API, timeout=TIMEOUT, verify=False)
            if resp.status_code == 200:
                data = resp.json()
                # NOAA daily-solar-data.json 返回格式可能是数组或对象
                if isinstance(data, list) and len(data) > 0:
                    latest = data[-1]
                elif isinstance(data, dict) and 'data' in data:
                    latest = data['data'][-1] if data['data'] else {}
                else:
                    latest = data if isinstance(data, dict) else {}

                # 尝试提取黑子数（字段名可能是 sunspot_number 或 sn）
                sn_val = (
                    latest.get('sunspot_number') or
                    latest.get('sn') or
                    latest.get('sunspots') or
                    0
                )
                sn_date = latest.get('date', latest.get('time_tag', ''))

                if sn_val and sn_date:
                    result['date'] = str(sn_date)[:10]
                    result['sunspot'] = round(float(sn_val), 1)
                    result['source'] = f'NOAA SWPC 初步黑子数（延迟约 1 天）'
                    result['success'] = True
                    log(f'✅ NOAA 每日数据: {result["date"]} 黑子数 {result["sunspot"]}')
                    return result
                else:
                    log(f'⚠️  NOAA 数据格式异常: {list(latest.keys()) if isinstance(latest, dict) else type(latest)}')
            else:
                log(f'⚠️  NOAA 每日数据 HTTP {resp.status_code}')
        except Exception as e:
            log(f'⚠️  NOAA 每日数据异常 (尝试 {attempt + 1}/2): {e}')
        if attempt < 1:
            time.sleep(3)

    log('⚠️  NOAA 每日数据不可用，仅使用 SILSO 数据')
    result['note'] = 'NOAA 数据不可用，SILSO 数据延迟 4-5 天属正常处理周期'
    return result


# ========== 4. 极光可见概率计算（科学公式） ==========

def calc_aurora_probability(kp: float, kp_peak: float = None) -> dict:
    """
    根据 Kp 指数和各地纬度计算极光可见概率。

    公式（地磁学公认模型）：
      ① Kp_min = (90 − 地磁纬度) / 10      （地磁纬度 ≈ 地理纬度 − 7°）
      ② P = 100 × min(1, max(0, (Kp − Kp_min) / (9 − Kp_min)))

    参数：
      kp:      当前实际/典型 Kp（用于计算当前极光概率）
      kp_peak: 活动周期理论上限 Kp（用于展示"地磁暴期间峰值概率"，可为 None）
    """
    locations = [
        {'name_cn': '漠河', 'lat_geo': 53, 'lat_geomag': 46},
        {'name_cn': '北欧', 'lat_geo': 65, 'lat_geomag': 58},
        {'name_cn': '北美', 'lat_geo': 60, 'lat_geomag': 53},
    ]

    def _calc_prob(kp_val: float, kp_min: float) -> tuple:
        """单点概率计算，返回 (prob, level)"""
        if kp_val <= kp_min:
            return 0, '几乎不可见'
        elif kp_val >= 9:
            return 98, '极高'
        else:
            prob = round(100 * (kp_val - kp_min) / (9 - kp_min))
            if prob >= 80:
                level = '极高'
            elif prob >= 60:
                level = '高'
            elif prob >= 30:
                level = '中等'
            elif prob >= 10:
                level = '较低'
            else:
                level = '极低'
            return prob, level

    results = []
    for loc in locations:
        lat_g = loc['lat_geomag']
        kp_min = (90 - lat_g) / 10

        # 当前概率（基于实际/典型 Kp）
        prob, level = _calc_prob(kp, kp_min)
        if kp <= kp_min:
            desc = f'当前 Kp={kp} < 阈值 Kp_min={kp_min:.1f}，概率趋近于零'
        elif kp >= 9:
            desc = '强地磁暴期间，极光可见概率极高'
        else:
            desc = f'当前 Kp={kp}，Kp_min={kp_min:.1f}，公式计算概率={prob}%'

        entry = {
            'location': loc['name_cn'],
            'lat_geo': f"{loc['lat_geo']}°N",
            'lat_geomag': f"{lat_g}°N",
            'kp_min': round(kp_min, 1),
            'kp_current': kp,
            'probability': prob,
            'level': level,
            'desc': desc,
            'formula': f'P = 100 × ({kp} - {kp_min:.1f}) / (9 - {kp_min:.1f}) ≈ {prob}%'
        }

        # 峰值概率（基于活动周期理论上限，仅科普展示）
        if kp_peak is not None and kp_peak > kp:
            peak_prob, peak_level = _calc_prob(kp_peak, kp_min)
            entry['peak_probability'] = peak_prob
            entry['peak_level'] = peak_level
            entry['peak_desc'] = f'若发生地磁暴（Kp 达到周期上限 {kp_peak}），概率可达 {peak_prob}%'
        else:
            entry['peak_probability'] = prob
            entry['peak_level'] = level
            entry['peak_desc'] = '当前 Kp 已接近或达到周期上限'

        results.append(entry)

    # Kp 等级描述
    if kp <= 3:
        kp_desc = f'Kp={kp}（平静期，地磁活动平静）'
    elif kp <= 5:
        kp_desc = f'Kp={kp}（微扰期，地磁微扰）'
    elif kp <= 7:
        kp_desc = f'Kp={kp}（中等地磁暴）'
    else:
        kp_desc = f'Kp={kp}（强地磁暴）'

    return {
        'kp_value': kp,
        'kp_peak_potential': kp_peak if kp_peak is not None else kp,
        'kp_description': kp_desc,
        'locations': results,
        'formula_source': '地磁学公认模型：Kp_min = (90 - 地磁纬度) / 10'
    }


# ========== 5. 太阳耀斑概率估算 ==========

def estimate_flare_forecast(sn_value: float, monthly_avg: float) -> dict:
    """
    基于黑子数估算耀斑爆发概率（参考 NOAA SWPC McGuire 等人统计模型）。

    NOAA 耀斑概率统计模型基于 McIntosh 黑子群分类，简化为黑子数线性近似：
      - C 级（常见）：基础 30% + R×0.6，活动期接近 100%
      - M 级（中等）：R×0.35，活动期可达 30-50%
      - X 级（强）：max(0, R×0.06 - 2)，活动期可达 5-10%
    """
    r = max(1, monthly_avg or sn_value)
    # C 级：活动期几乎天天有，封顶 99%
    c_rate = round(min(99, 30 + r * 0.6), 1)
    # M 级：活动期每周数次，封顶 60%
    m_rate = round(min(60, r * 0.35), 1)
    # X 级：活动期每月 1-3 次，封顶 15%
    x_rate = round(min(15, max(0, r * 0.06 - 2)), 1)

    return {
        'source': 'NOAA SWPC 耀斑概率统计模型（McGuire 简化版，基于黑子数线性近似）',
        'c_class_percent': c_rate,
        'm_class_percent': m_rate,
        'x_class_percent': x_rate,
        'note': f'基于 13 月平均黑子数 R={r:.1f} 估算的当日耀斑爆发概率，单位：%。C/M/X 分别为常见/中等/强耀斑等级。'
    }


# ========== 6. 主流程 ==========

def main():
    log('=' * 60)
    log('🚀 开始从官方数据源获取每日太阳活动数据')
    log('=' * 60)

    now = datetime.now()
    timestamp = now.strftime('%Y-%m-%d %H:%M:%S')

    # 6.1 尝试下载最新的 SILSO 日度数据
    download_silso_daily()

    # 6.2 加载日度黑子数
    daily = load_silso_daily()

    # 6.2.1 获取 NOAA 补充数据（延迟更低，约 1 天）
    noaa_daily = fetch_noaa_daily_solar()

    # 计算 SILSO 数据延迟天数
    silso_date = daily.get('latest_date', '')
    data_delay_days = 999
    if silso_date:
        try:
            parts = silso_date.split('-')
            data_date = datetime(int(parts[0]), int(parts[1]), int(parts[2]))
            data_delay_days = (now - data_date).days
        except (ValueError, IndexError):
            pass

    # 如果 SILSO 数据延迟 > 7 天且 NOAA 数据可用，优先使用 NOAA 数据
    if data_delay_days > 7 and noaa_daily.get('success'):
        log(f'📌 SILSO 数据延迟 {data_delay_days} 天，使用 NOAA 补充数据')
        sn_val = noaa_daily['sunspot']
        sn_date = noaa_daily['date']
        sn_source = noaa_daily['source']
        sn_note = f'SILSO 数据延迟 {data_delay_days} 天，自动切换为 NOAA 每日太阳数据（初步值，未经 SILSO 最终校准）'
    else:
        sn_val = daily['latest_value'] if daily.get('success') else 40
        sn_date = daily.get('latest_date', '未知')
        sn_source = 'SILSO 比利时皇家天文台（日度实测）'
        sn_note = '每日实测数据，SILSO 是国际太阳黑子数的官方基准发布机构'
        if data_delay_days > 4:
            sn_note += f'。当前数据延迟 {data_delay_days} 天（SILSO 正常处理周期 4-5 天）'

    # 6.3 从日度数据计算 13 月平均（最可靠方式）
    # 需要完整的日度数据（从 SILSO CSV 解析全部历史）
    all_daily_data = load_silso_daily_full()
    monthly = compute_monthly_avg_from_daily(all_daily_data)
    r_value = monthly.get('monthly_avg_13months', 0)

    # 6.4 获取 Kp 指数（传入选好的 R 值用于兜底估算）
    kp_data = fetch_kp_realtime(r_value=r_value)

    # 6.5 计算极光概率（同时传入当前 Kp 和理论上限 Kp）
    kp_val = kp_data['kp_value']
    kp_peak = kp_data.get('kp_peak_potential', kp_val)
    aurora = calc_aurora_probability(kp_val, kp_peak=kp_peak)

    # 6.6 耀斑预报
    monthly_avg = monthly.get('monthly_avg_13months', sn_val)
    flare = estimate_flare_forecast(sn_val, monthly_avg)

    # 6.7 组装最终数据
    output = {
        'generated_at': timestamp,
        'data_source': {
            'sunspot_daily': daily['source'],
            'sunspot_noaa': noaa_daily.get('source', '不可用'),
            'sunspot_monthly': 'SILSO 日度数据聚合（从日度实测值计算月均值）',
            'kp_index': kp_data['source'],
            'aurora_formula': 'Kp_peak = 3 + 0.05 × R；Kp_min = (90 − 地磁纬度) / 10；P = 100 × min(1, max(0, (Kp − Kp_min) / (9 − Kp_min)))',
            'flare': flare['source']
        },
        'official_sunspot': {
            'date': sn_date,
            'value': sn_val,
            'source': sn_source,
            'description': '太阳黑子相对数（沃尔夫数 R = k × (10g + f)）',
            'note': sn_note,
            'delay_days': data_delay_days,
            'preliminary': data_delay_days > 7 and noaa_daily.get('success', False)
        },
        'official_kp': {
            'value': kp_val,
            'description': aurora['kp_description'],
            'estimated': kp_data.get('kp_estimated', False),
            'source': kp_data['source'],
            'kp_peak_potential': kp_peak,
            'peak_note': f'Kp_peak={kp_peak} 是基于 13 月平均黑子数 R 的活动周期理论上限，不代表当前实测 Kp。当前用于极光概率计算的 Kp={kp_val}（{"NOAA 实测" if not kp_data.get("kp_estimated") else "历史典型值/估算"}）。'
        },
        'aurora_probability': aurora['locations'],
        'aurora_note': '极光可见概率基于"当前 Kp"（NOAA 实测或历史典型值）计算，反映当日实际可见可能性。peak_probability 字段为"地磁暴期间峰值概率"，仅在地磁暴发生时可能达到。注意：夏季高纬度地区（漠河/北欧）有极昼现象，天空亮度高，即使地磁活动强也可能肉眼看不到极光；冬季黑夜长则更利于观测。实际极光出现还受当日地磁暴强度、天气晴好度、月相影响。实时预报请参考国家空间天气监测预警中心（spaceweather.org.cn）或 NOAA SWPC。',
        'flare_forecast': {
            'c_class_percent': flare['c_class_percent'],
            'm_class_percent': flare['m_class_percent'],
            'x_class_percent': flare['x_class_percent'],
            'note': flare['note'],
            'source': flare['source']
        },
        'history_30days': daily.get('history_30days', []),
        'history_13months': monthly.get('history_13months', []),
        'monthly_avg_13months': monthly_avg,
        'disclaimer': '本数据仅供科普参考，所有数值均标注来源与计算公式。实际空间天气预报请以官方机构为准：中国地震局空间天气监测预警中心（spaceweather.org.cn）、NOAA SWPC（swpc.noaa.gov）'
    }

    # 6.8 写入 JSON
    os.makedirs(MINIPROGRAM_DIR, exist_ok=True)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    log(f'✅ 数据已写入: {OUTPUT_JSON}')
    log(f'   黑子数: {sn_val}（{sn_date}）来源: {sn_source[:50]}')
    log(f'   SILSO 数据延迟: {data_delay_days} 天')
    if noaa_daily.get('success'):
        log(f'   NOAA 补充数据: {noaa_daily["date"]} 黑子数 {noaa_daily["sunspot"]}')
    log(f'   13 月平均: {monthly_avg}')
    log(f'   当前 Kp: {kp_val}（{"估算/典型值" if kp_data.get("kp_estimated") else "NOAA 实测"}）')
    log(f'   理论上限 Kp_peak: {kp_peak}（仅科普展示，不代入极光概率）')
    for loc in aurora['locations']:
        log(f'   {loc["location"]}当前极光概率: {loc["probability"]}%（{loc["level"]}） | 峰值概率: {loc["peak_probability"]}%')
    log(f'   C/M/X 级耀斑概率: {flare["c_class_percent"]}% / {flare["m_class_percent"]}% / {flare["x_class_percent"]}%')
    log('✅ 数据写入完成！')

    # 7. 清除 jsdelivr CDN 缓存（确保用户能立刻看到最新数据）
    purge_cdn_cache()

    return output


def purge_cdn_cache():
    """清除 jsdelivr CDN 缓存，确保用户能立刻看到最新数据。仓库地址从 sync_config.json 读取。"""
    # 从 sync_config.json 动态读取仓库配置，避免硬编码
    config_path = BASE_DIR / 'sync_config.json'
    default_purge_url = 'https://purge.jsdelivr.net/gh/Hermiaaa-eng/solar-images@main/solar_miniprogram/daily_solar.json'

    try:
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            user = cfg.get('github_user', 'Hermiaaa-eng')
            repo = cfg.get('github_repo', 'solar-images')
            branch = cfg.get('github_branch', 'main')
            purge_url = f'https://purge.jsdelivr.net/gh/{user}/{repo}@{branch}/solar_miniprogram/daily_solar.json'
        else:
            purge_url = default_purge_url
    except Exception as e:
        log(f'⚠️  读取 sync_config.json 失败，使用默认 URL: {e}')
        purge_url = default_purge_url

    try:
        log(f'🔄 清除 jsdelivr CDN 缓存: {purge_url}')
        resp = requests.get(purge_url, timeout=15)
        if resp.status_code == 200:
            log('✅ CDN 缓存已清除')
        else:
            log(f'⚠️  CDN 缓存清除返回 HTTP {resp.status_code}')
    except Exception as e:
        log(f'⚠️  CDN 缓存清除失败: {e}')


if __name__ == '__main__':
    main()
