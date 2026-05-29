/**
 * 足弓内外翻评估 — MLI（Medial-Lateral Index）
 *
 * 原理：直接量化足底"内侧 / 外侧"负荷比，反映静态站立时重心的偏向。
 *
 *     MLI = ΣADC_medial / ΣADC_lateral
 *
 * 内/外侧划分（沿足部纵向中线切半）：
 *   - 左脚：纵向中线右半 = 内侧（朝身体中线），左半 = 外侧
 *   - 右脚：纵向中线左半 = 内侧，右半 = 外侧
 *
 * 阈值（用户确认）：
 *   MLI < 0.9      → 外侧负荷偏高 → 有足内翻风险（高弓足倾向）
 *   0.9 ≤ MLI ≤ 1.1 → 内外侧负荷基本平衡 → 内外侧负荷均衡
 *   MLI > 1.1      → 内侧负荷偏高 → 有足外翻风险（足弓塌陷/扁平足倾向）
 */

export type MliClassification = 'pronation_risk' | 'normal' | 'supination_risk';

export interface MliLineAnchor {
  /** 锚点行号 */
  row: number;
  /** 锚点列号（中心列） */
  col: number;
  /** 该段最左列号（用于画水平线） */
  cMin?: number;
  /** 该段最右列号（用于画水平线） */
  cMax?: number;
  /** 是否为中足段（5-8）— 此类段不参与 MLI 计算和折线连接 */
  isMidfoot?: boolean;
}

export interface MliResult {
  /** 内外侧负荷比 */
  mli: number;
  /** 内侧 ADC 累加值 */
  medialSum: number;
  /** 外侧 ADC 累加值 */
  lateralSum: number;
  /** 沿足部纵向均分 10 段，每段的中心点 (row, col)。空段被跳过。 */
  midlinePoints: MliLineAnchor[];
  /** 有效像素数 */
  pixelCount: number;
  /** 分类 */
  classification: MliClassification;
  /** 中文标签 */
  label: string;
  /** 描述文字 */
  description: string;
}

const NUM_BANDS = 10;

/** 每段内外侧切分比例：内侧占 53%，外侧占 47%（医学惯例倾向）。
 *  这个比例只影响 midCol 在段内的位置，不影响段的横向范围。 */
const MEDIAL_RATIO = 0.53;
const LATERAL_RATIO = 0.47;

/**
 * 给定 cMin、cMax 和脚向，返回该段的"内/外切分列号"。
 * - LEFT 脚：lateral 在左半 47%（小列号），medial 在右半 53%（大列号）
 *           split = cMin + 0.47 * width
 * - RIGHT 脚：medial 在左半 53%（小列号），lateral 在右半 47%（大列号）
 *            split = cMin + 0.53 * width
 */
function splitColAt(cMin: number, cMax: number, side: 'left' | 'right'): number {
  const w = cMax - cMin;
  return side === 'left'
    ? cMin + w * LATERAL_RATIO     // 0.45
    : cMin + w * MEDIAL_RATIO;     // 0.55
}


const LOWER_THRESHOLD = 0.9;
const UPPER_THRESHOLD = 1.1;

/**
 * 计算 MLI
 *
 * @param pixels  该脚所有有效像素的 [row, col] 列表（同一只脚，64×64 全局坐标）
 * @param getAdc  给定 (row, col) 返回 ADC 值的访问器
 * @param side    'left' 或 'right'，用于决定哪半边是内侧
 */
export function calculateMLI(
  pixels: number[][] | undefined,
  getAdc: (row: number, col: number) => number,
  side: 'left' | 'right',
): MliResult | null {
  if (!pixels || pixels.length === 0) {
    if (typeof console !== 'undefined') {
      console.warn(`[MLI] ${side} foot: pixels 列表为空（section_coords 没识别到该脚）`);
    }
    return null;
  }

  // 1) 第一遍扫：收集所有"有有效压力"的像素 (r, c, v)
  //    midCol 仅用这些有效像素的列号中位数 — 这样不会被 section_coords 里
  //    那些只在峰值帧亮一下、平均后≈0 的边缘"幽灵像素"污染。
  const active: { r: number; c: number; v: number }[] = [];
  for (const p of pixels) {
    if (!p || p.length < 2) continue;
    const r = p[0], c = p[1];
    if (!Number.isFinite(r) || !Number.isFinite(c)) continue;
    const v = getAdc(r, c);
    if (!v || v <= 0) continue;
    active.push({ r, c, v });
  }
  if (active.length === 0) {
    if (typeof console !== 'undefined') {
      console.warn(`[MLI] ${side} foot: 平均帧上没有有效压力像素`, { pixelLen: pixels.length });
    }
    return null;
  }

  // 2) 把脚沿行方向均分成 10 段，每段取「外接矩形中心」作为该段中心点：
  //      midCol = (cMin + cMax) / 2
  //    截断：先求 vmax，把 v < vmax × 5% 的像素当噪声丢掉，不参与 cMin/cMax。
  //    这样远处单个噪声像素不会把矩形边界拽偏。
  let rMin = Infinity, rMax = -Infinity;
  let vmax = 0;
  for (const { r, v } of active) {
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (v > vmax) vmax = v;
  }
  const footH = rMax - rMin;
  const bandH = footH / NUM_BANDS;
  const noiseFloor = vmax * 0.05;   // 5% 截断阈值

  const midlinePoints: MliLineAnchor[] = [];
  for (let i = 0; i < NUM_BANDS; i++) {
    const bandStart = rMin + i * bandH;
    const bandEnd = i === NUM_BANDS - 1 ? rMax + 1e-6 : rMin + (i + 1) * bandH;
    let cMin = Infinity, cMax = -Infinity;
    let rowSum = 0, count = 0;
    for (const { r, c, v } of active) {
      if (r >= bandStart && r < bandEnd) {
        if (v < noiseFloor) continue;   // 截断噪声
        if (c < cMin) cMin = c;
        if (c > cMax) cMax = c;
        rowSum += r;
        count++;
      }
    }
    if (count > 0) {
      midlinePoints.push({
        row: rowSum / count,
        col: splitColAt(cMin, cMax, side),   // 4.5:5.5 切分点
        cMin,
        cMax,
      });
    }
  }
  // 确保至少有 2 个点，否则退化到去重中位数 + 垂直线
  if (midlinePoints.length < 2) {
    const uniqueCols = Array.from(new Set(active.map(p => p.c))).sort((a, b) => a - b);
    const fallbackCol = uniqueCols[Math.floor(uniqueCols.length / 2)];
    midlinePoints.length = 0;
    midlinePoints.push({ row: rMin, col: fallbackCol });
    midlinePoints.push({ row: rMax, col: fallbackCol });
    if (typeof console !== 'undefined') {
      console.warn(`[MLI] ${side} foot: 有效段不足 2，退化为垂直中线 c=${fallbackCol}`);
    }
  }
  // 按 row 升序确保是单调折线
  midlinePoints.sort((a, b) => a.row - b.row);

  // 3) 用 10 段折线切分内外侧。所有段都参与（不再跳过中足）。
  //    每个像素 (r, c)，找到包含 r 的相邻两个中线点 (P_i, P_{i+1})，
  //    在两点间线性插值得到该行的 lineCol。
  const lineColAt = (r: number): number => {
    if (r <= midlinePoints[0].row) return midlinePoints[0].col;
    if (r >= midlinePoints[midlinePoints.length - 1].row) {
      return midlinePoints[midlinePoints.length - 1].col;
    }
    for (let i = 0; i < midlinePoints.length - 1; i++) {
      const p1 = midlinePoints[i];
      const p2 = midlinePoints[i + 1];
      if (r >= p1.row && r <= p2.row) {
        const t = (r - p1.row) / (p2.row - p1.row);
        return p1.col + t * (p2.col - p1.col);
      }
    }
    return midlinePoints[midlinePoints.length - 1].col;
  };

  let medialSum = 0;
  let lateralSum = 0;
  const pixelCount = active.length;
  for (const { r, c, v } of active) {
    const lineCol = lineColAt(r);
    const isMedial = side === 'left' ? c > lineCol : c < lineCol;
    if (isMedial) medialSum += v;
    else lateralSum += v;
  }

  if (lateralSum <= 0 || medialSum <= 0) {
    if (typeof console !== 'undefined') {
      console.warn(`[MLI] ${side} foot: 单侧 ADC 为 0`, {
        pixelCount, midlinePoints, medialSum, lateralSum,
      });
    }
    return null;
  }
  const mli = medialSum / lateralSum;

  // 3) 分类
  let classification: MliClassification;
  let label: string;
  let description: string;
  if (mli < LOWER_THRESHOLD) {
    classification = 'supination_risk';
    label = '有足内翻风险';
    description = `外侧负荷高于内侧（MLI = ${mli.toFixed(2)} < ${LOWER_THRESHOLD}），存在高弓足倾向。`;
  } else if (mli <= UPPER_THRESHOLD) {
    classification = 'normal';
    label = '内外侧负荷均衡';
    description = `内外侧负荷基本平衡（MLI = ${mli.toFixed(2)}，均衡区间 ${LOWER_THRESHOLD}–${UPPER_THRESHOLD}）。`;
  } else {
    classification = 'pronation_risk';
    label = '有足外翻风险';
    description = `内侧负荷高于外侧（MLI = ${mli.toFixed(2)} > ${UPPER_THRESHOLD}），存在足弓塌陷/扁平足倾向。`;
  }

  return {
    mli,
    medialSum,
    lateralSum,
    midlinePoints,
    pixelCount,
    classification,
    label,
    description,
  };
}

/**
 * 仅算分割线锚点（用于 2D 热力图可视化），不算 MLI。
 * 输入 64×64 ADC 矩阵 + 该脚的列范围。
 */
export function computeMliLine(
  data: number[][] | number[],
  colStart: number,
  colEnd: number,
  side: 'left' | 'right',
): { points: MliLineAnchor[]; medialSum: number; lateralSum: number } | null {
  const getAt = (r: number, c: number): number => {
    if (Array.isArray(data) && Array.isArray((data as number[][])[0])) {
      return (data as number[][])[r]?.[c] ?? 0;
    }
    return (data as number[])[r * 64 + c] ?? 0;
  };

  const active: { r: number; c: number; v: number }[] = [];
  let vmax = 0;
  for (let r = 0; r < 64; r++) {
    for (let c = colStart; c < colEnd; c++) {
      const v = getAt(r, c);
      if (v > 0) {
        active.push({ r, c, v });
        if (v > vmax) vmax = v;
      }
    }
  }
  if (active.length === 0) return null;

  let rMin = Infinity, rMax = -Infinity;
  for (const { r } of active) {
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  const footH = rMax - rMin;
  if (footH === 0) return null;

  const bandH = footH / NUM_BANDS;
  const noiseFloor = vmax * 0.05;
  const points: MliLineAnchor[] = [];
  for (let i = 0; i < NUM_BANDS; i++) {
    const bandStart = rMin + i * bandH;
    const bandEnd = i === NUM_BANDS - 1 ? rMax + 1e-6 : rMin + (i + 1) * bandH;
    let cMin = Infinity, cMax = -Infinity;
    let rowSum = 0, count = 0;
    for (const { r, c, v } of active) {
      if (r >= bandStart && r < bandEnd) {
        if (v < noiseFloor) continue;
        if (c < cMin) cMin = c;
        if (c > cMax) cMax = c;
        rowSum += r;
        count++;
      }
    }
    if (count > 0) {
      points.push({
        row: rowSum / count,
        col: splitColAt(cMin, cMax, side),
        cMin,
        cMax,
      });
    }
  }
  if (points.length < 2) return null;
  points.sort((a, b) => a.row - b.row);

  // 用同样的折线累加内外侧 ADC（与 calculateMLI 主体逻辑一致）
  const lineColAt = (r: number): number => {
    if (r <= points[0].row) return points[0].col;
    if (r >= points[points.length - 1].row) return points[points.length - 1].col;
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      if (r >= p1.row && r <= p2.row) {
        const t = (r - p1.row) / (p2.row - p1.row);
        return p1.col + t * (p2.col - p1.col);
      }
    }
    return points[points.length - 1].col;
  };

  let medialSum = 0;
  let lateralSum = 0;
  for (const { r, c, v } of active) {
    const lineCol = lineColAt(r);
    const isMedial = side === 'left' ? c > lineCol : c < lineCol;
    if (isMedial) medialSum += v;
    else lateralSum += v;
  }

  return { points, medialSum, lateralSum };
}
