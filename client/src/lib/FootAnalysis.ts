/**
 * 足底压力分析算法库
 * 基于 OneStep SDK 实现的前端版本
 * 包含：足弓分析、压力分布、COP分析等核心功能
 */

// 常量定义
const PITCH_MM = 7.0; // 传感器间距 7mm (64x64矩阵)
const GRID_SIZE = 64;
const NOISE_THRESHOLD = 2; // 噪声阈值（连通域检测用）
const DENOISE_THRESHOLD = 4; // 去噪阈值（<=4的压力值置0，与Python apply_denoise一致）
const MIN_COMPONENT_SIZE = 3; // 最小连通域大小
const MULTI_COMPONENT_MIN_SIZE = 10; // 多连通域模式最小面积（与Python Comprehensive_Indicators一致）

// ==================== 数据类型定义 ====================

export interface FootData {
  matrix: number[][]; // 64x64 压力矩阵
  coords: [number, number][]; // 有效点坐标
  pressure: number; // 总压力
  area: number; // 接触面积 (cm²)
  cop: { x: number; y: number } | null; // 压力中心
}

export interface ArchAnalysis {
  archIndex: number; // 足弓指数 (数值，非百分数)
  archType: string; // 足弓类型
}

export interface RegionPressure {
  forefoot: { area: number; pressure: number; percent: number }; // 前足
  midfoot: { area: number; pressure: number; percent: number }; // 中足
  hindfoot: { area: number; pressure: number; percent: number }; // 后足
}

export interface COPMetrics {
  pathLength: number; // 压力中心轨迹长度 (mm)
  contactArea: number; // 压力中心活动总面积 - 凸包面积 (mm²)
  majorAxis: number; // 压力中心最大摆幅 (cm) — 与Python *0.7一致
  minorAxis: number; // 压力中心稳定摆幅 (cm)
  lsRatio: number; // 摆动幅度系数 (长轴/短轴)
  eccentricity: number; // 摆动均匀系数
  deltaX: number; // 前后摆动幅度 (mm)
  deltaY: number; // 左右摆动幅度 (mm)
  maxDisplacement: number; // 最大离心 (cm) — 与Python *0.7一致
  minDisplacement: number; // 最小离心 (cm)
  avgVelocity: number; // 偏移平均速度 (mm/s)
  rmsDisplacement: number; // 摆动强度 (cm)
  stdX: number; // 前后方向标准差 (mm)
  stdY: number; // 左右方向标准差 (mm)
}

export interface FootReport {
  left: {
    footData: FootData;
    archAnalysis: ArchAnalysis;
    regionPressure: RegionPressure;
    length: number; // 足长 (cm)
    width: number; // 足宽 (cm)
  };
  right: {
    footData: FootData;
    archAnalysis: ArchAnalysis;
    regionPressure: RegionPressure;
    length: number;
    width: number;
  };
  bilateral: {
    leftPressureRatio: number; // 左脚压力占比
    rightPressureRatio: number; // 右脚压力占比
    forefootRatio: number; // 前后脚压力比
    copMetrics: COPMetrics | null;
    copTrajectory: { x: number; y: number }[];
    leftCopTrajectory: { x: number; y: number }[]; // 左脚COP轨迹
    rightCopTrajectory: { x: number; y: number }[]; // 右脚COP轨迹
  };
}

// ==================== 工具函数 ====================

/**
 * 矩阵逆时针旋转90度
 */
function rot90(matrix: number[][]): number[][] {
  const n = matrix.length;
  const result: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[n - 1 - j][i] = matrix[i][j];
    }
  }
  return result;
}

/**
 * 矩阵水平镜像（左右翻转）
 */
function flipLR(matrix: number[][]): number[][] {
  return matrix.map(row => [...row].reverse());
}

/**
 * 矩阵垂直镜像（上下翻转）
 */
function flipUD(matrix: number[][]): number[][] {
  return [...matrix].reverse();
}

/**
 * 连通域标记算法
 * @param connectivity 4 = 上下左右; 8 = 含对角线
 * 返回标记矩阵和连通域数量
 */
function labelConnectedComponents(mask: boolean[][], connectivity: 4 | 8 = 4): { labels: number[][]; numLabels: number } {
  const rows = mask.length;
  const cols = mask[0].length;
  const labels: number[][] = Array(rows).fill(null).map(() => Array(cols).fill(0));
  let currentLabel = 0;

  const neighbors4: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const neighbors8: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  const dirs = connectivity === 8 ? neighbors8 : neighbors4;

  function dfs(r: number, c: number, label: number): void {
    const stack: [number, number][] = [[r, c]];
    while (stack.length > 0) {
      const [cr, cc] = stack.pop()!;
      if (cr < 0 || cr >= rows || cc < 0 || cc >= cols) continue;
      if (!mask[cr][cc] || labels[cr][cc] !== 0) continue;

      labels[cr][cc] = label;
      for (const [dr, dc] of dirs) {
        stack.push([cr + dr, cc + dc]);
      }
    }
  }

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (mask[i][j] && labels[i][j] === 0) {
        currentLabel++;
        dfs(i, j, currentLabel);
      }
    }
  }

  return { labels, numLabels: currentLabel };
}

/**
 * 移除小连通域（去噪）
 * 与Python代码 _remove_small_components 一致
 */
function removeSmallComponents(matrix: number[][], minSize: number = MIN_COMPONENT_SIZE): number[][] {
  const rows = matrix.length;
  const cols = matrix[0].length;
  
  // 创建二值掩码 (阈值 > 2)
  const mask: boolean[][] = matrix.map(row => row.map(val => val > NOISE_THRESHOLD));
  
  // 标记连通域
  const { labels, numLabels } = labelConnectedComponents(mask);
  
  if (numLabels === 0) return matrix;
  
  // 统计每个连通域的大小
  const counts: number[] = Array(numLabels + 1).fill(0);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (labels[i][j] > 0) {
        counts[labels[i][j]]++;
      }
    }
  }
  
  // 标记要保留的连通域
  const keep: boolean[] = Array(numLabels + 1).fill(false);
  for (let label = 1; label <= numLabels; label++) {
    if (counts[label] >= minSize) {
      keep[label] = true;
    }
  }
  
  // 创建去噪后的矩阵
  const result: number[][] = matrix.map((row, i) => 
    row.map((val, j) => keep[labels[i][j]] ? val : 0)
  );
  
  return result;
}

/**
 * 获取前N大连通域的合并边界框
 * 与Python代码 largest_bboxes_multi 一致
 */
function getLargestComponentsBBox(
  mask: boolean[][],
  topN: number = 3,
  minSize: number = MULTI_COMPONENT_MIN_SIZE
): { top: number; bottom: number; left: number; right: number } | null {
  const { labels, numLabels } = labelConnectedComponents(mask, 8);

  if (numLabels === 0) return null;

  // 统计每个连通域的大小
  const counts: number[] = Array(numLabels + 1).fill(0);
  for (let i = 0; i < mask.length; i++) {
    for (let j = 0; j < mask[0].length; j++) {
      if (labels[i][j] > 0) {
        counts[labels[i][j]]++;
      }
    }
  }

  // 找出面积>=minSize的连通域，按大小排序
  const validLabels: { label: number; count: number }[] = [];
  for (let label = 1; label <= numLabels; label++) {
    if (counts[label] >= minSize) {
      validLabels.push({ label, count: counts[label] });
    }
  }
  if (validLabels.length === 0) return null;
  
  // 按大小降序排序，取前topN个
  validLabels.sort((a, b) => b.count - a.count);
  const topLabels = validLabels.slice(0, topN).map(v => v.label);
  
  // 计算合并边界框
  let top = mask.length, bottom = 0, left = mask[0].length, right = 0;
  for (let i = 0; i < mask.length; i++) {
    for (let j = 0; j < mask[0].length; j++) {
      if (topLabels.includes(labels[i][j])) {
        top = Math.min(top, i);
        bottom = Math.max(bottom, i);
        left = Math.min(left, j);
        right = Math.max(right, j);
      }
    }
  }
  
  if (top > bottom || left > right) return null;
  
  return { top, bottom, left, right };
}

/**
 * 高级去噪：对左右脚分别保留主要连通域区域
 * 与Python代码的multi_component_mode一致
 */
function advancedDenoise(matrix: number[][]): number[][] {
  const result = matrix.map(row => [...row]);
  
  // 分离左右脚
  const leftHalf: number[][] = matrix.map(row => row.slice(0, 32));
  const rightHalf: number[][] = matrix.map(row => row.slice(32));
  
  // 对左脚进行连通域过滤（与Python一致：mask条件为 > 0）
  const leftMask: boolean[][] = leftHalf.map(row => row.map(val => val > 0));
  const leftBBox = getLargestComponentsBBox(leftMask, 3, MULTI_COMPONENT_MIN_SIZE);
  if (leftBBox) {
    // 只保留边界框内的数据
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 32; j++) {
        if (i < leftBBox.top || i > leftBBox.bottom || j < leftBBox.left || j > leftBBox.right) {
          result[i][j] = 0;
        }
      }
    }
  }
  
  // 对右脚进行连通域过滤（与Python一致：mask条件为 > 0）
  const rightMask: boolean[][] = rightHalf.map(row => row.map(val => val > 0));
  const rightBBox = getLargestComponentsBBox(rightMask, 3, MULTI_COMPONENT_MIN_SIZE);
  if (rightBBox) {
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 32; j++) {
        if (i < rightBBox.top || i > rightBBox.bottom || j < rightBBox.left || j > rightBBox.right) {
          result[i][j + 32] = 0;
        }
      }
    }
  }
  
  return result;
}

/**
 * 完整预处理流程（与Python代码一致）
 * 处理顺序：旋转 → 水平镜像 → 垂直镜像 → 去噪(<=4置0) → 小连通域去噪 → 多连通域过滤
 */
export function parseFrameData(data: number[]): number[][] {
  if (data.length !== 4096) {
    console.warn('数据长度不为4096');
    return Array(64).fill(null).map(() => Array(64).fill(0));
  }

  // 重构为64x64矩阵
  const matrix: number[][] = [];
  for (let i = 0; i < 64; i++) {
    matrix.push(data.slice(i * 64, (i + 1) * 64));
  }

  // 1) 逆时针旋转90度
  const rotated = rot90(matrix);

  // 2) 水平镜像
  const mirrored = flipLR(rotated);

  // 3) 垂直镜像（与Python mirrored_vertical=True 一致）
  const flipped = flipUD(mirrored);

  // 4) 去噪：压力值<=4的置0（与Python apply_denoise: mat[mat <= 4] = 0 一致）
  for (let i = 0; i < flipped.length; i++) {
    for (let j = 0; j < flipped[i].length; j++) {
      if (flipped[i][j] <= DENOISE_THRESHOLD) {
        flipped[i][j] = 0;
      }
    }
  }

  // 5) 去噪：移除小连通域（面积<3的）
  const denoised = removeSmallComponents(flipped, MIN_COMPONENT_SIZE);

  // 6) 进一步去噪：对左右脚分别保留主要连通域区域
  const fullyDenoised = advancedDenoise(denoised);

  return fullyDenoised;
}

/**
 * 分离左右脚数据
 */
export function splitLeftRight(matrix: number[][]): { left: number[][]; right: number[][] } {
  const left: number[][] = matrix.map(row => row.slice(0, 32).concat(Array(32).fill(0)));
  const right: number[][] = matrix.map(row => Array(32).fill(0).concat(row.slice(32)));
  return { left, right };
}

/**
 * 计算压力中心 (COP)
 */
export function calculateCOP(matrix: number[][], offsetY = 0): { x: number; y: number } | null {
  let totalPressure = 0;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      const p = matrix[i][j];
      if (p > 0) {
        totalPressure += p;
        sumX += i * p;
        sumY += (j + offsetY) * p;
      }
    }
  }

  if (totalPressure <= 0) return null;

  return {
    x: sumX / totalPressure,
    y: sumY / totalPressure
  };
}

/**
 * 获取有效坐标点（压力>阈值的点）
 */
export function getValidCoords(matrix: number[][]): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (matrix[i][j] > NOISE_THRESHOLD) {
        coords.push([i, j]);
      }
    }
  }
  return coords;
}

/**
 * 多连通域版本：返回前N大连通域的合并坐标列表
 * 与Python代码 largest_component_points_multi 一致
 * 用于足弓分析的有效点提取
 */
export function getLargestComponentPointsMulti(
  halfMatrix: number[][],
  thr: number = 2.0,
  topN: number = 3,
  minSize: number = MULTI_COMPONENT_MIN_SIZE
): [number, number][] {
  const mask: boolean[][] = halfMatrix.map(row => row.map(val => val > thr));
  const { labels, numLabels } = labelConnectedComponents(mask, 8);

  if (numLabels === 0) return [];

  // 统计每个连通域的大小
  const counts: number[] = Array(numLabels + 1).fill(0);
  for (let i = 0; i < halfMatrix.length; i++) {
    for (let j = 0; j < halfMatrix[0].length; j++) {
      if (labels[i][j] > 0) {
        counts[labels[i][j]]++;
      }
    }
  }

  // 找面积 >= minSize 的连通域
  const validLabels: { label: number; count: number }[] = [];
  for (let label = 1; label <= numLabels; label++) {
    if (counts[label] >= minSize) {
      validLabels.push({ label, count: counts[label] });
    }
  }

  // 如果没有满足条件的，降级到最大连通域
  if (validLabels.length === 0) {
    let maxLabel = 1;
    let maxCount = 0;
    for (let label = 1; label <= numLabels; label++) {
      if (counts[label] > maxCount) {
        maxCount = counts[label];
        maxLabel = label;
      }
    }
    const points: [number, number][] = [];
    for (let i = 0; i < halfMatrix.length; i++) {
      for (let j = 0; j < halfMatrix[0].length; j++) {
        if (labels[i][j] === maxLabel) {
          points.push([i, j]);
        }
      }
    }
    return points;
  }

  // 按面积排序，取前N个
  validLabels.sort((a, b) => b.count - a.count);
  const topLabels = validLabels.slice(0, topN).map(v => v.label);

  // 合并所有连通域的坐标
  const allPoints: [number, number][] = [];
  for (let i = 0; i < halfMatrix.length; i++) {
    for (let j = 0; j < halfMatrix[0].length; j++) {
      if (topLabels.includes(labels[i][j])) {
        allPoints.push([i, j]);
      }
    }
  }

  return allPoints;
}

/**
 * 计算总压力
 */
export function calculateTotalPressure(matrix: number[][]): number {
  let total = 0;
  for (const row of matrix) {
    for (const val of row) {
      if (val > 0) total += val;
    }
  }
  return total;
}

/**
 * 计算接触面积 (cm²)
 */
export function calculateContactArea(matrix: number[][]): number {
  let count = 0;
  for (const row of matrix) {
    for (const val of row) {
      if (val > NOISE_THRESHOLD) count++;
    }
  }
  return count * (PITCH_MM * PITCH_MM) / 100; // cm²
}

// ==================== 足弓分析 ====================

/**
 * 按X方向（前后）将足底分为4个区域
 * 与Python代码 divide_x_regions 一致
 * 比例 3:4:4:4（脚趾:前足:中足:后足）
 */
export function divideXRegions(coords: [number, number][]): [number, number][][] {
  if (coords.length === 0) return [[], [], [], []];

  const xValues = coords.map(c => c[0]);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const totalHeight = xMax - xMin;

  // 比例 3:4:4:4
  const ratios = [3, 4, 4, 4];
  const totalRatio = ratios.reduce((a, b) => a + b, 0);
  
  const boundaries: number[] = [xMin];
  let cumulative = 0;
  for (let i = 0; i < ratios.length - 1; i++) {
    cumulative += ratios[i];
    boundaries.push(xMin + (cumulative / totalRatio) * totalHeight);
  }
  boundaries.push(xMax + 1);

  // 分配点到各区域
  const sections: [number, number][][] = [[], [], [], []];
  for (const coord of coords) {
    const x = coord[0];
    for (let i = 0; i < 4; i++) {
      if (x >= boundaries[i] && x < boundaries[i + 1]) {
        sections[i].push(coord);
        break;
      }
    }
  }

  return sections;
}

/**
 * 计算足弓指数
 * 与Python代码一致：AI = 中足面积 / (前足 + 中足 + 后足面积)
 * 注意：不包含脚趾区域(R1)
 */
export function calculateArchIndex(sections: [number, number][][]): { index: number; type: string } {
  // sections[0] = R1 (脚趾区域) - 不参与计算
  // sections[1] = R2 (前足)
  // sections[2] = R3 (中足)
  // sections[3] = R4 (后足)
  
  const forefootCount = sections[1].length;  // 前足
  const midfootCount = sections[2].length;   // 中足
  const hindfootCount = sections[3].length;  // 后足
  
  const totalArea = forefootCount + midfootCount + hindfootCount;
  
  if (totalArea === 0) {
    return { index: 0, type: '无数据' };
  }

  const archIndex = midfootCount / totalArea;

  // 足弓类型判断（与Python Comprehensive_Indicators代码一致，五档阈值）
  let archType: string;
  if (archIndex < 0.20) {
    archType = '高足弓';
  } else if (archIndex < 0.21) {
    archType = '正常偏高';
  } else if (archIndex <= 0.26) {
    archType = '正常足弓';
  } else if (archIndex <= 0.27) {
    archType = '正常偏扁';
  } else {
    archType = '扁平足';
  }

  return { index: archIndex, type: archType };
}

// ==================== 压力分布分析 ====================

/**
 * 计算区域压力分布
 * 与Python代码一致：前足=R1+R2, 中足=R3, 后足=R4
 */
export function calculateRegionPressure(matrix: number[][], sections: [number, number][][]): RegionPressure {
  const areaPerPoint = (PITCH_MM * PITCH_MM) / 100; // cm²

  // 区域映射与Python代码一致：
  // sections[0] = R1 (脚趾区域)
  // sections[1] = R2 (前足)
  // sections[2] = R3 (中足)
  // sections[3] = R4 (后足)
  const forefootCount = sections[0].length + sections[1].length; // 前足 = R1 + R2
  const midfootCount = sections[2].length;
  const hindfootCount = sections[3].length;

  // 计算各区域压力
  let forefootPressure = 0;
  let midfootPressure = 0;
  let hindfootPressure = 0;

  // 前足压力（R1 + R2）
  for (const coord of sections[0]) {
    forefootPressure += matrix[coord[0]][coord[1]];
  }
  for (const coord of sections[1]) {
    forefootPressure += matrix[coord[0]][coord[1]];
  }
  for (const coord of sections[2]) {
    midfootPressure += matrix[coord[0]][coord[1]];
  }
  for (const coord of sections[3]) {
    hindfootPressure += matrix[coord[0]][coord[1]];
  }

  const totalPressure = forefootPressure + midfootPressure + hindfootPressure;

  return {
    forefoot: {
      area: forefootCount * areaPerPoint,
      pressure: forefootPressure,
      percent: totalPressure > 0 ? (forefootPressure / totalPressure) * 100 : 0
    },
    midfoot: {
      area: midfootCount * areaPerPoint,
      pressure: midfootPressure,
      percent: totalPressure > 0 ? (midfootPressure / totalPressure) * 100 : 0
    },
    hindfoot: {
      area: hindfootCount * areaPerPoint,
      pressure: hindfootPressure,
      percent: totalPressure > 0 ? (hindfootPressure / totalPressure) * 100 : 0
    }
  };
}

/**
 * 计算足长和足宽 (cm)
 * 与Python代码一致：(range+1) * 0.7 + 1.5
 */
export function calculateFootDimensions(coords: [number, number][]): { length: number; width: number } {
  if (coords.length === 0) return { length: 0, width: 0 };

  const xValues = coords.map(c => c[0]);
  const yValues = coords.map(c => c[1]);

  const length = (Math.max(...xValues) - Math.min(...xValues) + 1) * 0.7 + 1.5; // cm
  const width = (Math.max(...yValues) - Math.min(...yValues) + 1) * 0.7 + 1.5; // cm

  return { length, width };
}

// ==================== COP分析 ====================

/**
 * 找压力峰值区间（与Python find_pressure_peak_interval 一致）
 * 从峰值向左右扩展，找到压力 >= threshold 的区间
 */
function findPressurePeakInterval(pressureCurve: number[], thresholdRatio = 0.8): [number, number] {
  const peakValue = Math.max(...pressureCurve);
  const peakIndex = pressureCurve.indexOf(peakValue);
  const threshold = peakValue * thresholdRatio;

  let leftIndex = peakIndex;
  while (leftIndex > 0 && pressureCurve[leftIndex] >= threshold) {
    leftIndex--;
  }
  let rightIndex = peakIndex;
  while (rightIndex < pressureCurve.length - 1 && pressureCurve[rightIndex] >= threshold) {
    rightIndex++;
  }
  if (leftIndex > 0) leftIndex++;
  if (rightIndex < pressureCurve.length - 1) rightIndex--;

  return [leftIndex, rightIndex];
}

/**
 * 计算凸包面积（Shoelace公式）
 * 与Python scipy.spatial.ConvexHull 一致
 */
function convexHullArea(points: [number, number][]): number {
  if (points.length < 3) return 0;

  // Graham scan 求凸包
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  function cross(O: [number, number], A: [number, number], B: [number, number]): number {
    return (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  }

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // 去掉首尾重复点
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);

  if (hull.length < 3) return 0;

  // Shoelace公式计算面积
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    area += hull[i][0] * hull[j][1];
    area -= hull[j][0] * hull[i][1];
  }
  return Math.abs(area) / 2;
}

/**
 * 计算COP轨迹指标（与Python calculate_cop_time_series 完全一致）
 * 输入：COP轨迹（格单位坐标），dt时间间隔
 * 输出：所有指标（mm单位）
 */
export function calculateCOPMetrics(copTrajectory: [number, number][], dt = 0.024): COPMetrics | null {
  if (!copTrajectory || copTrajectory.length < 3) return null;

  const n = copTrajectory.length;
  const x = copTrajectory.map(p => p[0]);
  const y = copTrajectory.map(p => p[1]);

  // 中心点（格单位）
  const centerX = x.reduce((a, b) => a + b, 0) / n;
  const centerY = y.reduce((a, b) => a + b, 0) / n;

  // 速度序列（mm/s）— Python: velocity_series = sqrt(vx^2+vy^2) * 7, 首帧补0
  const velocitySeries: number[] = [0]; // 首帧速度为0，与Python一致
  if (n > 1) {
    for (let i = 1; i < n; i++) {
      const vx = (x[i] - x[i - 1]) / dt;
      const vy = (y[i] - y[i - 1]) / dt;
      velocitySeries.push(Math.sqrt(vx * vx + vy * vy) * PITCH_MM);
    }
  }

  // 轨迹长度（mm）— Python: path_length *= 7
  let pathLength = 0;
  if (n > 1) {
    for (let i = 1; i < n; i++) {
      pathLength += Math.sqrt(Math.pow(x[i] - x[i - 1], 2) + Math.pow(y[i] - y[i - 1], 2));
    }
  }
  pathLength *= PITCH_MM;

  // 活动总面积（mm²）— Python: ConvexHull.volume * (7^2)
  let contactArea = 0;
  if (n >= 3) {
    const hullArea = convexHullArea(copTrajectory);
    contactArea = hullArea * (PITCH_MM * PITCH_MM);
  }

  // 范围（mm）— Python: delta_x = np.ptp(x) * 7, delta_y = np.ptp(y) * 7
  const deltaX = (Math.max(...x) - Math.min(...x)) * PITCH_MM;
  const deltaY = (Math.max(...y) - Math.min(...y)) * PITCH_MM;

  // 椭圆轴（mm）— Python: 2*sqrt(eigenvalue)*0.7 (cm), 这里用mm所以 *7
  let majorAxis = deltaX;
  let minorAxis = deltaY;
  try {
    const centeredData = copTrajectory.map(p => [p[0] - centerX, p[1] - centerY]);
    // 协方差矩阵（与Python np.cov(centered_data.T) 一致）
    const covXX = centeredData.reduce((sum, p) => sum + p[0] * p[0], 0) / (n - 1);
    const covYY = centeredData.reduce((sum, p) => sum + p[1] * p[1], 0) / (n - 1);
    const covXY = centeredData.reduce((sum, p) => sum + p[0] * p[1], 0) / (n - 1);

    // 特征值
    const trace = covXX + covYY;
    const det = covXX * covYY - covXY * covXY;
    const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
    const eigenvalues = [trace / 2 + disc, trace / 2 - disc].sort((a, b) => b - a);

    // Python: major_axis = 2 * sqrt(eigenvalues[0]) * 0.7 (cm)
    // 与Python完全一致，输出cm
    majorAxis = 2 * Math.sqrt(Math.max(eigenvalues[0], 0)) * 0.7;
    minorAxis = 2 * Math.sqrt(Math.max(eigenvalues[1], 0)) * 0.7;
  } catch {
    // 保持默认值
  }

  // 离心距离（cm）— Python: displacement = sqrt(...) * 0.7 (cm)
  const displacements: number[] = [];
  for (let i = 0; i < n; i++) {
    displacements.push(Math.sqrt(Math.pow(x[i] - centerX, 2) + Math.pow(y[i] - centerY, 2)) * 0.7);
  }
  const maxDisplacement = Math.max(...displacements);
  const minDisplacement = Math.min(...displacements);

  // 平均速度（mm/s）— Python: np.mean(velocity_series)（含首帧0）
  const avgVelocity = velocitySeries.reduce((a, b) => a + b, 0) / velocitySeries.length;

  // 摆动强度（mm）— Python: rms_displacement = sqrt(mean(displacement^2))
  const rmsDisplacement = Math.sqrt(displacements.reduce((sum, d) => sum + d * d, 0) / n);

  // 标准差（mm）— Python: np.std(x) * 7
  const stdX = Math.sqrt(x.reduce((sum, xi) => sum + Math.pow(xi - centerX, 2), 0) / n) * PITCH_MM;
  const stdY = Math.sqrt(y.reduce((sum, yi) => sum + Math.pow(yi - centerY, 2), 0) / n) * PITCH_MM;

  // 摆动幅度系数 — Python: ls_ratio = major_axis / minor_axis
  const lsRatio = minorAxis > 0 ? majorAxis / minorAxis : 0;

  // 摆动均匀系数 — Python: eccentricity = sqrt(1 - (minor/major)^2)
  const eccentricity = majorAxis > 0 ? Math.sqrt(1 - Math.pow(minorAxis / majorAxis, 2)) : 0;

  return {
    pathLength,
    contactArea,
    majorAxis,
    minorAxis,
    lsRatio,
    eccentricity,
    deltaX,
    deltaY,
    maxDisplacement,
    minDisplacement,
    avgVelocity,
    rmsDisplacement,
    stdX,
    stdY
  };
}

// ==================== 完整报告生成 ====================

/**
 * 从多帧数据生成完整分析报告
 * COP计算逻辑与Python OneStep_report.py 完全一致：
 * 1. 压力曲线和COP轨迹用"轻量预处理"数据（只旋转+镜像，与Python preprocess_data_array一致）
 * 2. 静态分析（足弓等）用"完整预处理"数据（旋转+镜像+去噪，与Python preprocess_origin_data一致）
 * 3. 分脚找峰值区间（threshold_ratio=0.8）
 * 4. 选择较长的COP轨迹计算指标
 */
export function generateFootReport(frames: number[][]): FootReport | null {
  if (frames.length === 0) return null;

  // ===== 两套预处理 =====
  // A. 完整预处理（用于静态分析：足弓、压力分布等）
  const processedFrames: number[][][] = [];
  for (let i = 0; i < frames.length; i++) {
    processedFrames.push(parseFrameData(frames[i]));
  }

  // B. 轻量预处理（只旋转+镜像，用于COP轨迹和压力曲线，与Python preprocess_data_array一致）
  const lightFrames: number[][][] = [];
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].length !== 4096) {
      lightFrames.push(Array(64).fill(null).map(() => Array(64).fill(0)));
      continue;
    }
    const matrix: number[][] = [];
    for (let r = 0; r < 64; r++) {
      matrix.push(frames[i].slice(r * 64, (r + 1) * 64));
    }
    // 1) 逆时针旋转90度
    const rotated = rot90(matrix);
    // 2) 水平镜像
    const mirrored = flipLR(rotated);
    // 3) 垂直镜像（与Python mirrored_vertical=True 一致）
    const flipped = flipUD(mirrored);
    // 不做去噪！与Python preprocess_data_array 一致
    lightFrames.push(flipped);
  }

  // ===== 1. 压力曲线用轻量预处理数据（与Python extract_pressure_curves(data_array) 一致）=====
  // Python: arr = np.where(arr > thr, arr, 0); left = (arr[:,:,:32] != 0).sum(...)
  const leftCurve: number[] = [];
  const rightCurve: number[] = [];
  for (const matrix of lightFrames) {
    let leftCount = 0, rightCount = 0;
    for (let r = 0; r < 64; r++) {
      for (let c = 0; c < 32; c++) {
        if (matrix[r][c] > NOISE_THRESHOLD) leftCount++;
      }
      for (let c = 32; c < 64; c++) {
        if (matrix[r][c] > NOISE_THRESHOLD) rightCount++;
      }
    }
    leftCurve.push(leftCount);
    rightCurve.push(rightCount);
  }

  // ===== 2. 找总压力峰值帧（用于静态分析）=====
  const totalCurve = leftCurve.map((l, i) => l + rightCurve[i]);
  const peakValue = Math.max(...totalCurve);
  const maxPressureFrame = totalCurve.indexOf(peakValue);

  console.log(`[FootAnalysis] 使用峰值帧 #${maxPressureFrame} 进行分析，总压力: ${peakValue}`);

  // ===== 3. 分脚COP轨迹用轻量预处理数据（与Python calculate_cop_trajectories(df,...) 一致）=====
  // 左脚：找左脚压力曲线的峰值区间
  const [leftStart, leftEnd] = findPressurePeakInterval(leftCurve, 0.8);
  const leftCopTrajectoryRaw: [number, number][] = [];
  const leftCopTrajectoryXY: { x: number; y: number }[] = [];
  for (let i = leftStart; i <= leftEnd; i++) {
    const matrix = lightFrames[i]; // 用轻量预处理数据
    const leftHalf: number[][] = matrix.map(row => row.slice(0, 32));
    let totalP = 0, wx = 0, wy = 0;
    for (let r = 0; r < leftHalf.length; r++) {
      for (let c = 0; c < leftHalf[r].length; c++) {
        const p = leftHalf[r][c];
        totalP += p;
        wx += p * r;
        wy += p * c;
      }
    }
    if (totalP > 0) {
      const copX = wx / totalP;
      const copY = wy / totalP;
      leftCopTrajectoryRaw.push([copX, copY]);
      leftCopTrajectoryXY.push({ x: copX, y: copY });
    }
  }

  // 右脚：找右脚压力曲线的峰值区间
  const [rightStart, rightEnd] = findPressurePeakInterval(rightCurve, 0.8);
  const rightCopTrajectoryRaw: [number, number][] = [];
  const rightCopTrajectoryXY: { x: number; y: number }[] = [];
  for (let i = rightStart; i <= rightEnd; i++) {
    const matrix = lightFrames[i]; // 用轻量预处理数据
    const rightHalf: number[][] = matrix.map(row => row.slice(32));
    let totalP = 0, wx = 0, wy = 0;
    for (let r = 0; r < rightHalf.length; r++) {
      for (let c = 0; c < rightHalf[r].length; c++) {
        const p = rightHalf[r][c];
        totalP += p;
        wx += p * r;
        wy += p * (c + 32);
      }
    }
    if (totalP > 0) {
      const copX = wx / totalP;
      const copY = wy / totalP;
      rightCopTrajectoryRaw.push([copX, copY]);
      rightCopTrajectoryXY.push({ x: copX, y: copY });
    }
  }

  console.log(`[FootAnalysis] 左脚COP轨迹: ${leftCopTrajectoryRaw.length}帧 (区间${leftStart}-${leftEnd})`);
  console.log(`[FootAnalysis] 右脚COP轨迹: ${rightCopTrajectoryRaw.length}帧 (区间${rightStart}-${rightEnd})`);

  // ===== 4. COP指标（与Python calculate_cop_time_series 一致：选较长的轨迹）=====
  const copTrajectoryForMetrics = leftCopTrajectoryRaw.length >= rightCopTrajectoryRaw.length
    ? leftCopTrajectoryRaw : rightCopTrajectoryRaw;
  const copMetrics = calculateCOPMetrics(copTrajectoryForMetrics);

  // ===== 5. 静态分析（使用峰值帧）=====
  const mainMatrix = processedFrames[maxPressureFrame];
  const { left: leftMatrix, right: rightMatrix } = splitLeftRight(mainMatrix);

  // 左脚分析
  const leftHalfOnly: number[][] = mainMatrix.map(row => row.slice(0, 32));
  const leftCoords = getLargestComponentPointsMulti(leftHalfOnly, 2.0, 3, MULTI_COMPONENT_MIN_SIZE);
  const leftSections = divideXRegions(leftCoords);
  const leftArchResult = calculateArchIndex(leftSections);
  const leftRegionPressure = calculateRegionPressure(mainMatrix, leftSections);
  const leftDimensions = calculateFootDimensions(leftCoords);

  console.log(`[FootAnalysis] 左脚: 总点数=${leftCoords.length}, 区域分布=[${leftSections.map(s => s.length).join(',')}], AI=${leftArchResult.index.toFixed(4)}`);

  // 右脚分析
  const rightHalfOnly: number[][] = mainMatrix.map(row => row.slice(32));
  const rightCoordsLocal = getLargestComponentPointsMulti(rightHalfOnly, 2.0, 3, MULTI_COMPONENT_MIN_SIZE);
  const rightCoords: [number, number][] = rightCoordsLocal.map(([r, c]) => [r, c + 32]);
  const rightSections = divideXRegions(rightCoords);
  const rightArchResult = calculateArchIndex(rightSections);
  const rightRegionPressure = calculateRegionPressure(mainMatrix, rightSections);
  const rightDimensions = calculateFootDimensions(rightCoords);

  console.log(`[FootAnalysis] 右脚: 总点数=${rightCoords.length}, 区域分布=[${rightSections.map(s => s.length).join(',')}], AI=${rightArchResult.index.toFixed(4)}`);

  // 双脚分析
  const leftPressure = calculateTotalPressure(leftMatrix);
  const rightPressure = calculateTotalPressure(rightMatrix);
  const totalPressure = leftPressure + rightPressure;

  const forefootTotal = leftRegionPressure.forefoot.pressure + rightRegionPressure.forefoot.pressure;
  const hindfootTotal = leftRegionPressure.hindfoot.pressure + rightRegionPressure.hindfoot.pressure;

  return {
    left: {
      footData: {
        matrix: leftMatrix,
        coords: leftCoords,
        pressure: leftPressure,
        area: calculateContactArea(leftMatrix),
        cop: calculateCOP(leftMatrix)
      },
      archAnalysis: {
        archIndex: leftArchResult.index,
        archType: leftArchResult.type
      },
      regionPressure: leftRegionPressure,
      length: leftDimensions.length,
      width: leftDimensions.width
    },
    right: {
      footData: {
        matrix: rightMatrix,
        coords: rightCoords,
        pressure: rightPressure,
        area: calculateContactArea(rightMatrix),
        cop: calculateCOP(rightMatrix)
      },
      archAnalysis: {
        archIndex: rightArchResult.index,
        archType: rightArchResult.type
      },
      regionPressure: rightRegionPressure,
      length: rightDimensions.length,
      width: rightDimensions.width
    },
    bilateral: {
      leftPressureRatio: totalPressure > 0 ? (leftPressure / totalPressure) * 100 : 50,
      rightPressureRatio: totalPressure > 0 ? (rightPressure / totalPressure) * 100 : 50,
      forefootRatio: hindfootTotal > 0 ? forefootTotal / hindfootTotal : 1,
      copMetrics,
      copTrajectory: copTrajectoryForMetrics.map(p => ({ x: p[0], y: p[1] })),
      leftCopTrajectory: leftCopTrajectoryXY,
      rightCopTrajectory: rightCopTrajectoryXY
    }
  };
}
