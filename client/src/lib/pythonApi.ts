/**
 * Python 后端 API 调用模块
 * 用于调用 FastAPI 后端进行足底压力分析
 * 确保计算结果与 Python OneStep_report.py 完全一致
 *
 * 开发模式：通过 Vite proxy /pyapi -> http://127.0.0.1:8766
 * 生产模式：直接访问 http://127.0.0.1:8766
 */

const PYTHON_API_BASE = import.meta.env.DEV ? '/pyapi' : 'http://127.0.0.1:8766';

export interface PythonAnalysisResult {
  success: boolean;
  data: {
    left_cop_metrics: Record<string, number>; // 中文键名的 COP 指标
    right_cop_metrics: Record<string, number>;
    left_sway_features: Record<string, number>;
    right_sway_features: Record<string, number>;
    arch_features: PythonArchFeatures;
    additional_data: PythonAdditionalData;
    cop_time_series: PythonCOPTimeSeries; // 英文键名的 COP 时间序列指标
    left_cop_trajectory?: number[][];  // 原始COP轨迹 [[x,y], ...]
    right_cop_trajectory?: number[][]; // 原始COP轨迹 [[x,y], ...]
  };
  images?: PythonImages;
}

export interface PythonImages {
  cop_trajectory?: string;   // base64 data URI
  arch_regions?: string;     // base64 data URI
  heatmap_internal?: string; // base64 data URI
  velocity_series?: string;  // base64 data URI
  confidence_ellipse?: string; // base64 data URI
}

// calculate_cop_time_series 返回的英文键名指标（与前端 COPMetrics 对应）
export interface PythonCOPTimeSeries {
  path_length: number;
  contact_area: number;
  ls_ratio: number;
  eccentricity: number;
  major_axis: number;
  minor_axis: number;
  delta_x: number;
  delta_y: number;
  max_displacement: number;
  min_displacement: number;
  avg_velocity: number;
  rms_displacement: number;
  center_bias: number;
  std_x: number;
  std_y: number;
  time_series: number[] | null;
  time_points: number[];
  velocity_series: number[];
}

export interface PythonArchFeatures {
  is_multi_frame: boolean;
  frame_count: number;
  peak_index: number;
  peak_total_pressure: number;
  peak_frame_data: number[];
  left_foot: PythonFootArch;
  right_foot: PythonFootArch;
}

export interface PythonFootArch {
  area_index: number;
  area_type: string;
  max_area: number[];
  section_coords: Record<string, number[][]>;
}

export interface PythonAdditionalData {
  left_length: number;
  left_width: number;
  right_length: number;
  right_width: number;
  left_area: {
    total_area_cm2: number;
    area_cm2: number[]; // [前足, 中足, 后足]
    area_ratio: number[];
  };
  right_area: {
    total_area_cm2: number;
    area_cm2: number[];
    area_ratio: number[];
  };
  left_pressure: Record<string, number>; // { "前足": 0.xx, "中足": 0.xx, "后足": 0.xx }
  right_pressure: Record<string, number>;
  cop_results: Record<string, number>;
}

/**
 * 检查 Python 后端是否可用
 */
export async function checkPythonBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${PYTHON_API_BASE}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * 调用 Python 后端分析帧数据
 * @param frames 原始帧数据（每帧4096个值的二维数组）
 */
export async function analyzePython(
  frames: number[][],
  fps = 42,
  thresholdRatio = 0.8,
): Promise<PythonAnalysisResult> {
  const res = await fetch(`${PYTHON_API_BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frames,
      fps,
      threshold_ratio: thresholdRatio,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(`Python 分析失败: ${err.detail || res.statusText}`);
  }

  return res.json();
}

/**
 * 将 Python 后端返回的结果转换为前端 FootReport 格式
 */
import type { FootReport, COPMetrics } from './FootAnalysis';

export function convertPythonResult(
  result: PythonAnalysisResult['data'],
): FootReport {
  const { arch_features, additional_data, cop_time_series } = result;

  const leftArch = arch_features.left_foot;
  const rightArch = arch_features.right_foot;

  // 使用 cop_time_series（来自 calculate_cop_time_series，英文键名）
  const cts = cop_time_series;
  let bilateralCOP: COPMetrics | null = null;
  if (cts && cts.path_length > 0) {
    bilateralCOP = {
      pathLength: cts.path_length,
      contactArea: cts.contact_area,
      majorAxis: cts.major_axis,
      minorAxis: cts.minor_axis,
      lsRatio: cts.ls_ratio,
      eccentricity: cts.eccentricity,
      deltaX: cts.delta_x,
      deltaY: cts.delta_y,
      maxDisplacement: cts.max_displacement,
      minDisplacement: cts.min_displacement,
      avgVelocity: cts.avg_velocity,
      rmsDisplacement: cts.rms_displacement,
      stdX: cts.std_x,
      stdY: cts.std_y,
    };
  }

  // 构建峰值帧矩阵用于热力图
  const peakData = arch_features.peak_frame_data || [];
  const peakMatrix: number[][] = [];
  for (let i = 0; i < 64; i++) {
    peakMatrix.push(peakData.slice(i * 64, (i + 1) * 64));
  }

  // 从峰值帧矩阵提取左右脚数据
  function extractFootMatrix(
    matrix: number[][],
    side: 'left' | 'right',
  ): { matrix: number[][]; coords: [number, number][]; pressure: number; area: number } {
    const footMatrix: number[][] = Array(64).fill(null).map(() => Array(64).fill(0));
    const coords: [number, number][] = [];
    let pressure = 0;
    let area = 0;
    const colStart = side === 'left' ? 0 : 32;
    const colEnd = side === 'left' ? 32 : 64;

    for (let r = 0; r < 64; r++) {
      for (let c = colStart; c < colEnd; c++) {
        const v = matrix[r]?.[c] || 0;
        footMatrix[r][c] = v;
        if (v > 0) {
          coords.push([r, c]);
          pressure += v;
          area++;
        }
      }
    }
    return { matrix: footMatrix, coords, pressure, area: area * 0.49 }; // 0.49 cm² per grid
  }

  const leftFoot = extractFootMatrix(peakMatrix, 'left');
  const rightFoot = extractFootMatrix(peakMatrix, 'right');

  const ad = additional_data;

  // 从峰值帧矩阵计算总压力
  const leftTotalPressure = leftFoot.pressure;
  const rightTotalPressure = rightFoot.pressure;
  const totalPressure = leftTotalPressure + rightTotalPressure;

  // 压力比例（Python 返回的是 0~1 的小数）
  const lp = ad.left_pressure || {};
  const rp = ad.right_pressure || {};

  return {
    left: {
      footData: {
        matrix: leftFoot.matrix,
        coords: leftFoot.coords,
        pressure: leftTotalPressure,
        area: ad.left_area?.total_area_cm2 ?? leftFoot.area,
        cop: null,
      },
      archAnalysis: {
        archIndex: leftArch.area_index,
        archType: leftArch.area_type,
      },
      regionPressure: {
        forefoot: {
          area: ad.left_area?.area_cm2?.[0] ?? 0,
          pressure: (lp['前足'] ?? 0) * 100,
          percent: (lp['前足'] ?? 0) * 100,
        },
        midfoot: {
          area: ad.left_area?.area_cm2?.[1] ?? 0,
          pressure: (lp['中足'] ?? 0) * 100,
          percent: (lp['中足'] ?? 0) * 100,
        },
        hindfoot: {
          area: ad.left_area?.area_cm2?.[2] ?? 0,
          pressure: (lp['后足'] ?? 0) * 100,
          percent: (lp['后足'] ?? 0) * 100,
        },
      },
      length: ad.left_length ?? 0,
      width: ad.left_width ?? 0,
    },
    right: {
      footData: {
        matrix: rightFoot.matrix,
        coords: rightFoot.coords,
        pressure: rightTotalPressure,
        area: ad.right_area?.total_area_cm2 ?? rightFoot.area,
        cop: null,
      },
      archAnalysis: {
        archIndex: rightArch.area_index,
        archType: rightArch.area_type,
      },
      regionPressure: {
        forefoot: {
          area: ad.right_area?.area_cm2?.[0] ?? 0,
          pressure: (rp['前足'] ?? 0) * 100,
          percent: (rp['前足'] ?? 0) * 100,
        },
        midfoot: {
          area: ad.right_area?.area_cm2?.[1] ?? 0,
          pressure: (rp['中足'] ?? 0) * 100,
          percent: (rp['中足'] ?? 0) * 100,
        },
        hindfoot: {
          area: ad.right_area?.area_cm2?.[2] ?? 0,
          pressure: (rp['后足'] ?? 0) * 100,
          percent: (rp['后足'] ?? 0) * 100,
        },
      },
      length: ad.right_length ?? 0,
      width: ad.right_width ?? 0,
    },
    bilateral: {
      leftPressureRatio: totalPressure > 0
        ? (leftTotalPressure / totalPressure) * 100
        : 50,
      rightPressureRatio: totalPressure > 0
        ? (rightTotalPressure / totalPressure) * 100
        : 50,
      forefootRatio: 0,
      copMetrics: bilateralCOP,
      copTrajectory: [],
      leftCopTrajectory: [],
      rightCopTrajectory: [],
    },
  };
}
