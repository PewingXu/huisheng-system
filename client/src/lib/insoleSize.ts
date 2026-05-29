/**
 * 中国码鞋码 / 足宽换算表
 * 数据来源：insole_size.md（原始 .md 已并入此模块）
 *
 * 用法：
 *   lookupInsoleSize(footLengthCm, 'adult_female')
 *   → { shoeSize: 40, footWidthCm: 10.0 }
 *
 * 换算公式（表外足长的回退）：
 *   中国码  = 足长(cm) × 2 - 10
 *   足宽(青少年) = 足长(mm) × 0.58 / 10     （cm）
 *   足宽(成人)   = 足长(mm) × 0.38 / 10     （cm）
 */

export type InsoleCategory =
  | 'adolescent_male'    // 青少年男
  | 'adolescent_female'  // 青少年女
  | 'adult_male'         // 成人男
  | 'adult_female';      // 成人女

export const INSOLE_CATEGORY_LABELS: Record<InsoleCategory, string> = {
  adolescent_male: '青少年男',
  adolescent_female: '青少年女',
  adult_male: '成人男',
  adult_female: '成人女',
};

export interface InsoleSizeEntry {
  /** 足长 cm */
  footLengthCm: number;
  /** 中国码 */
  shoeSize: number;
  /** 足宽 cm（原表为 mm，已转换） */
  footWidthCm: number;
}

/** 青少年男 */
const ADOLESCENT_MALE: InsoleSizeEntry[] = [
  { footLengthCm: 21.5, shoeSize: 39, footWidthCm: 12.4 },
  { footLengthCm: 22.0, shoeSize: 40, footWidthCm: 12.8 },
  { footLengthCm: 22.5, shoeSize: 41, footWidthCm: 13.1 },
  { footLengthCm: 23.0, shoeSize: 42, footWidthCm: 13.4 },
  { footLengthCm: 23.5, shoeSize: 43, footWidthCm: 13.7 },
];

/** 青少年女 */
const ADOLESCENT_FEMALE: InsoleSizeEntry[] = [
  { footLengthCm: 21.0, shoeSize: 38, footWidthCm: 12.2 },
  { footLengthCm: 21.5, shoeSize: 39, footWidthCm: 12.4 },
  { footLengthCm: 22.0, shoeSize: 40, footWidthCm: 12.8 },
  { footLengthCm: 22.5, shoeSize: 41, footWidthCm: 13.1 },
  { footLengthCm: 23.0, shoeSize: 42, footWidthCm: 13.4 },
];

/** 成人男 */
const ADULT_MALE: InsoleSizeEntry[] = [
  { footLengthCm: 24.0, shoeSize: 38, footWidthCm: 9.1 },
  { footLengthCm: 24.5, shoeSize: 39, footWidthCm: 9.3 },
  { footLengthCm: 25.0, shoeSize: 40, footWidthCm: 9.5 },
  { footLengthCm: 25.5, shoeSize: 41, footWidthCm: 9.7 },
  { footLengthCm: 26.0, shoeSize: 42, footWidthCm: 9.9 },
  { footLengthCm: 26.5, shoeSize: 43, footWidthCm: 10.1 },
  { footLengthCm: 27.0, shoeSize: 44, footWidthCm: 10.3 },
  { footLengthCm: 27.5, shoeSize: 45, footWidthCm: 10.5 },
  { footLengthCm: 28.0, shoeSize: 46, footWidthCm: 10.6 },
  { footLengthCm: 28.5, shoeSize: 47, footWidthCm: 10.8 },
  { footLengthCm: 29.0, shoeSize: 48, footWidthCm: 11.0 },
];

/** 成人女 */
const ADULT_FEMALE: InsoleSizeEntry[] = [
  { footLengthCm: 22.0, shoeSize: 34, footWidthCm: 8.8 },
  { footLengthCm: 22.5, shoeSize: 35, footWidthCm: 9.0 },
  { footLengthCm: 23.0, shoeSize: 36, footWidthCm: 9.2 },
  { footLengthCm: 23.5, shoeSize: 37, footWidthCm: 9.4 },
  { footLengthCm: 24.0, shoeSize: 38, footWidthCm: 9.6 },
  { footLengthCm: 24.5, shoeSize: 39, footWidthCm: 9.8 },
  { footLengthCm: 25.0, shoeSize: 40, footWidthCm: 10.0 },
  { footLengthCm: 25.5, shoeSize: 41, footWidthCm: 10.2 },
  { footLengthCm: 26.0, shoeSize: 42, footWidthCm: 10.4 },
];

const TABLE_MAP: Record<InsoleCategory, InsoleSizeEntry[]> = {
  adolescent_male: ADOLESCENT_MALE,
  adolescent_female: ADOLESCENT_FEMALE,
  adult_male: ADULT_MALE,
  adult_female: ADULT_FEMALE,
};

/** 给定足长 cm + 分类，返回最匹配的鞋码记录。表外用公式回退。 */
export function lookupInsoleSize(footLengthCm: number, category: InsoleCategory): InsoleSizeEntry {
  const table = TABLE_MAP[category];

  // 在表内：取离 footLengthCm 最近的条目
  if (table.length > 0) {
    const minL = table[0].footLengthCm;
    const maxL = table[table.length - 1].footLengthCm;
    if (footLengthCm >= minL && footLengthCm <= maxL) {
      let best = table[0];
      let bestDiff = Math.abs(table[0].footLengthCm - footLengthCm);
      for (let i = 1; i < table.length; i++) {
        const diff = Math.abs(table[i].footLengthCm - footLengthCm);
        if (diff < bestDiff) {
          best = table[i];
          bestDiff = diff;
        }
      }
      return best;
    }
  }

  // 表外：用公式回退
  const shoeSize = Math.round(footLengthCm * 2 - 10);
  const ratio = category.startsWith('adolescent') ? 0.058 : 0.038; // mm系数转cm
  const footWidthCm = Math.round(footLengthCm * 10 * ratio * 10) / 10; // 保留1位小数
  return {
    footLengthCm: Math.round(footLengthCm * 2) / 2, // 0.5 cm 步进
    shoeSize,
    footWidthCm,
  };
}
