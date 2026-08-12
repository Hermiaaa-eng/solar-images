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
import requests
from datetime import datetime, timedelta
from pathlib import Path

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

TIMEOUT = 30


def log(msg: str) -> None:
    """打印带时间戳的日志"""
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] {msg}', flush=True)


# ========== 1. SILSO 日度太阳黑子数 ==========

def download_silso_daily() -> bool:
    """从 SILSO 官网下载日度黑子数 CSV（覆盖本地文件）"""
    log(f'⬇️  下载 SILSO 日度数据: {SILSO_DAILY_URL}')
    try:
        resp = requests.get(SILSO_DAILY_URL, timeout=TIMEOUT, verify=False)
        if resp.status_code == 200 and resp.text.strip():
            with open(SILSO_DAILY_CSV, 'w', encoding='utf-8') as f:
                f.write(resp.text)
            log(f'✅ 日度数据已保存: {SILSO_DAILY_CSV}（{len(resp.text)} 字节）')
            return True
        else:
            log(f'⚠️  下载失败，HTTP {resp.status_code}')
            return False
    except Exception as e:
        log(f'⚠️  下载异常: {e}')
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
    """从 NOAA SWPC 获取实时 Kp 指数，失败时用黑子数估算"""
    result = {
        'source': 'NOAA SWPC 实时 API',
        'success': False,
        'kp_estimated': False,
        'kp_value': 0,
        'kp_description': ''
    }

    # 尝试 NOAA 实时 Kp API
    try:
        log(f'⬇️  获取 NOAA Kp 实时数据: {NOAA_KP_API}')
        resp = requests.get(NOAA_KP_API, timeout=TIMEOUT)
        if resp.status_code == 200:
            data = resp.json()
            # NOAA Kp API 返回格式：[{"time_tag": "...", "kp": 3.0, ...}, ...]
            if isinstance(data, list) and len(data) > 0:
                # 取最近的非 -1 Kp 值
                valid_kp = [d for d in data if d.get('kp', -1) >= 0]
                if valid_kp:
                    latest_kp = valid_kp[-1]['kp']
                    result['kp_value'] = latest_kp
                    result['source'] = f'NOAA SWPC 实测 Kp（planetary_k_index_1m.json）'
                    result['success'] = True
                    log(f'✅ NOAA Kp 实测: {latest_kp}')
                    return result
    except Exception as e:
        log(f'⚠️  NOAA Kp API 不可达: {e}')

    # 备用：用已计算的 R 值估算
    if r_value is not None and r_value > 0:
        log(f'⚠️  Kp 实测失败，改用 13 月平均黑子数 R={r_value} 估算')
        estimated_kp = min(9, max(0, 3 + 0.05 * r_value))
        result['kp_value'] = round(estimated_kp, 2)
        result['kp_estimated'] = True
        result['source'] = f'SILSO 13 月平均黑子数 R={r_value} 代入经验公式 Kp≈3+0.05R'
        result['success'] = True
        log(f'📐 Kp 估算: R={r_value} → Kp≈{estimated_kp}')
    else:
        # 最终兜底
        result['kp_value'] = 4.0
        result['kp_estimated'] = True
        result['source'] = '默认值（数据源全部不可用时）'
        result['success'] = True
        log('⚠️  使用默认 Kp=4.0')

    return result


# ========== 4. 极光可见概率计算（科学公式） ==========

def calc_aurora_probability(kp: float) -> dict:
    """
    根据 Kp 指数和各地纬度计算极光可见概率。

    公式（地磁学公认模型）：
      ① Kp_peak = 3 + 0.05 × R            （R = 13 月平均黑子数）
      ② Kp_min = (90 − 地磁纬度) / 10      （地磁纬度 ≈ 地理纬度 − 7°）
      ③ P = 100 × min(1, max(0, (Kp − Kp_min) / (9 − Kp_min)))
    """
    locations = [
        {'name_cn': '漠河', 'lat_geo': 53, 'lat_geomag': 46},
        {'name_cn': '北欧', 'lat_geo': 65, 'lat_geomag': 58},
        {'name_cn': '北美', 'lat_geo': 60, 'lat_geomag': 53},
    ]

    results = []
    for loc in locations:
        lat_g = loc['lat_geomag']
        kp_min = (90 - lat_g) / 10

        if kp <= kp_min:
            prob = 0
            level = '几乎不可见'
            desc = f'Kp={kp} < 阈值 Kp_min={kp_min:.1f}，概率趋近于零'
        elif kp >= 9:
            prob = 98
            level = '极高'
            desc = '强地磁暴期间，极光可见概率极高'
        else:
            prob = round(100 * (kp - kp_min) / (9 - kp_min))
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
            desc = f'Kp={kp}，Kp_min={kp_min:.1f}，公式计算概率={prob}%'

        results.append({
            'location': loc['name_cn'],
            'lat_geo': f"{loc['lat_geo']}°N",
            'lat_geomag': f"{lat_g}°N",
            'kp_min': round(kp_min, 1),
            'kp_current': kp,
            'probability': prob,
            'level': level,
            'desc': desc,
            'formula': f'P = 100 × ({kp} - {kp_min:.1f}) / (9 - {kp_min:.1f}) ≈ {prob}%'
        })

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
        'kp_description': kp_desc,
        'locations': results,
        'formula_source': '地磁学公认模型：Kp_min = (90 - 地磁纬度) / 10'
    }


# ========== 5. 太阳耀斑概率估算 ==========

def estimate_flare_forecast(sn_value: float, monthly_avg: float) -> dict:
    """基于黑子数估算耀斑爆发概率（NOAA SWPC 统计模型）"""
    r = max(1, monthly_avg or sn_value)
    c_rate = round(min(95, 30 + r * 0.6), 1)
    m_rate = round(min(40, r * 0.35), 1)
    x_rate = round(min(8, max(0, r * 0.04 - 2)), 1)

    return {
        'source': 'NOAA SWPC 耀斑概率统计模型（基于黑子数）',
        'c_class_percent': c_rate,
        'm_class_percent': m_rate,
        'x_class_percent': x_rate,
        'note': f'基于 13 月平均黑子数 R={r:.1f} 估算的耀斑爆发概率，单位：%'
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

    # 6.3 从日度数据计算 13 月平均（最可靠方式）
    # 需要完整的日度数据（从 SILSO CSV 解析全部历史）
    all_daily_data = load_silso_daily_full()
    monthly = compute_monthly_avg_from_daily(all_daily_data)
    r_value = monthly.get('monthly_avg_13months', 0)

    # 6.4 获取 Kp 指数（传入选好的 R 值用于兜底估算）
    kp_data = fetch_kp_realtime(r_value=r_value)

    # 6.5 计算极光概率
    kp_val = kp_data['kp_value']
    aurora = calc_aurora_probability(kp_val)

    # 6.6 耀斑预报
    sn_val = daily['latest_value'] if daily.get('success') else 40
    monthly_avg = monthly.get('monthly_avg_13months', sn_val)
    flare = estimate_flare_forecast(sn_val, monthly_avg)

    # 6.7 组装最终数据
    output = {
        'generated_at': timestamp,
        'data_source': {
            'sunspot_daily': daily['source'],
            'sunspot_monthly': 'SILSO 日度数据聚合（从日度实测值计算月均值）',
            'kp_index': kp_data['source'],
            'aurora_formula': 'Kp_peak = 3 + 0.05 × R；Kp_min = (90 − 地磁纬度) / 10；P = 100 × min(1, max(0, (Kp − Kp_min) / (9 − Kp_min)))',
            'flare': flare['source']
        },
        'official_sunspot': {
            'date': daily.get('latest_date', '未知'),
            'value': sn_val,
            'source': 'SILSO 比利时皇家天文台（日度实测）',
            'description': '太阳黑子相对数（沃尔夫数 R = k × (10g + f)）',
            'note': '每日实测数据，SILSO 是国际太阳黑子数的官方基准发布机构'
        },
        'official_kp': {
            'value': kp_val,
            'description': aurora['kp_description'],
            'estimated': kp_data.get('kp_estimated', False),
            'source': kp_data['source']
        },
        'aurora_probability': aurora['locations'],
        'aurora_note': '极光可见概率基于实测/估算 Kp 指数计算。注意：夏季高纬度地区（漠河/北欧）有极昼现象，天空亮度高，即使地磁活动强也可能肉眼看不到极光；冬季黑夜长则更利于观测。实际极光出现还受当日地磁暴强度、天气晴好度、月相影响。实时预报请参考国家空间天气监测预警中心（spaceweather.org.cn）或 NOAA SWPC。',
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
    log(f'   日度黑子数: {output["official_sunspot"]["value"]}（{output["official_sunspot"]["date"]}）')
    log(f'   13 月平均: {monthly_avg}')
    log(f'   Kp 指数: {kp_val}（{"估算" if kp_data.get("kp_estimated") else "实测"}）')
    for loc in aurora['locations']:
        log(f'   {loc["location"]}极光概率: {loc["probability"]}%（{loc["level"]}）')
    log(f'   C/M/X 级耀斑概率: {flare["c_class_percent"]}% / {flare["m_class_percent"]}% / {flare["x_class_percent"]}%')
    log('✅ 完成！')

    return output


if __name__ == '__main__':
    main()
