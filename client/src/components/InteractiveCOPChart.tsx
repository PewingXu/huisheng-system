import { useRef, useEffect, useState, useCallback } from 'react';
import { computeMliLine } from '@/lib/mli';

interface Props {
  leftCopRaw: number[][];
  rightCopRaw: number[][];
  peakFrameData?: number[];
  leftSectionCoords?: number[][][];
  rightSectionCoords?: number[][][];
}

interface TooltipInfo {
  x: number;
  y: number;
  side: 'left' | 'right';
  frameIndex: number;
  totalFrames: number;
  copX: number;
  copY: number;
}

interface FootBounds {
  minR: number;
  maxR: number;
  minC: number;
  maxC: number;
}

const CANVAS_H = 420;
const PADDING = 24;
const TITLE_H = 28;
const FOOT_PAD = 0;
const ADC_VMIN = 0;
const ADC_VMAX = 150;

function getGridSpan(min: number, max: number): number {
  return Math.max(1, Math.floor(max) - Math.floor(min) + 1);
}

function heatColor(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, t));
  if (v <= 0) return [0, 0, 127];
  if (v >= 1) return [127, 0, 0];
  if (v < 0.125) {
    const s = v / 0.125;
    return [0, 0, Math.round(127 + s * 128)];
  }
  if (v < 0.375) {
    const s = (v - 0.125) / 0.25;
    return [0, Math.round(s * 255), 255];
  }
  if (v < 0.625) {
    const s = (v - 0.375) / 0.25;
    return [Math.round(s * 255), 255, Math.round(255 - s * 255)];
  }
  if (v < 0.875) {
    const s = (v - 0.625) / 0.25;
    return [255, Math.round(255 - s * 255), 0];
  }
  const s = (v - 0.875) / 0.125;
  return [Math.round(255 - s * 128), 0, 0];
}

function normalizePressure(v: number): number {
  if (ADC_VMAX <= ADC_VMIN) return v <= ADC_VMIN ? 0 : 1;
  return Math.max(0, Math.min(1, (v - ADC_VMIN) / (ADC_VMAX - ADC_VMIN)));
}

function trajectoryColor(t: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, t));
  return [255, 255, Math.round(255 * (1 - v))];
}

function smoothPressure(values: number[], rows: number, cols: number): number[] {
  const kernel = [
    [1, 2, 1],
    [2, 4, 2],
    [1, 2, 1],
  ];
  const radius = 1;
  const out = Array(rows * cols).fill(0);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let weight = 0;
      for (let kr = -radius; kr <= radius; kr++) {
        for (let kc = -radius; kc <= radius; kc++) {
          const rr = r + kr;
          const cc = c + kc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const v = values[rr * cols + cc];
          if (v <= 0) continue;
          const w = kernel[kr + radius][kc + radius];
          sum += v * w;
          weight += w;
        }
      }
      out[r * cols + c] = weight > 0 ? sum / weight : 0;
    }
  }

  return out;
}

function computeBounds(
  colStart: number,
  colEnd: number,
  sectionCoords: number[][][] | undefined,
): FootBounds {
  const coords = sectionCoords?.flat() ?? [];
  if (coords.length === 0) {
    return { minR: 0, maxR: 63, minC: colStart, maxC: colEnd - 1 };
  }

  let minR = Infinity;
  let maxR = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (const [r, c] of coords) {
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
  }

  return {
    minR: Math.floor(minR) - FOOT_PAD,
    maxR: Math.ceil(maxR) + FOOT_PAD,
    minC: Math.floor(minC) - FOOT_PAD,
    maxC: Math.ceil(maxC) + FOOT_PAD,
  };
}

function expandBoundsToSpan(bounds: FootBounds, targetRows: number, targetCols: number): FootBounds {
  const rowExtra = Math.max(0, targetRows - getGridSpan(bounds.minR, bounds.maxR));
  const colExtra = Math.max(0, targetCols - getGridSpan(bounds.minC, bounds.maxC));
  const rowBefore = Math.floor(rowExtra / 2);
  const colBefore = Math.floor(colExtra / 2);

  return {
    minR: bounds.minR - rowBefore,
    maxR: bounds.maxR + rowExtra - rowBefore,
    minC: bounds.minC - colBefore,
    maxC: bounds.maxC + colExtra - colBefore,
  };
}

function equalizeBounds(leftBounds: FootBounds, rightBounds: FootBounds): [FootBounds, FootBounds] {
  const targetRows = Math.max(
    getGridSpan(leftBounds.minR, leftBounds.maxR),
    getGridSpan(rightBounds.minR, rightBounds.maxR),
  );
  const targetCols = Math.max(
    getGridSpan(leftBounds.minC, leftBounds.maxC),
    getGridSpan(rightBounds.minC, rightBounds.maxC),
  );

  return [
    expandBoundsToSpan(leftBounds, targetRows, targetCols),
    expandBoundsToSpan(rightBounds, targetRows, targetCols),
  ];
}

function createFootMask(
  bounds: FootBounds,
  sectionCoords: number[][][] | undefined,
  rows: number,
  cols: number,
): boolean[] {
  const mask = Array(rows * cols).fill(false);
  const coords = sectionCoords?.flat() ?? [];
  if (coords.length === 0) {
    mask.fill(true);
    return mask;
  }

  for (const [r, c] of coords) {
    const rr = Math.floor(r - bounds.minR);
    const cc = Math.floor(c - bounds.minC);
    if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
      mask[rr * cols + cc] = true;
    }
  }
  return mask;
}

function normalizeCopPoints(
  copPts: number[][],
  colStart: number,
  colEnd: number,
  bounds: FootBounds,
): number[][] {
  const validPts = (copPts || []).filter((pt) => (
    Array.isArray(pt) && pt.length >= 2 && !Number.isNaN(pt[0]) && !Number.isNaN(pt[1])
  ));
  if (validPts.length === 0) return [];

  const inBoundsCount = (pts: number[][]) => pts.filter((pt) => (
    pt[0] >= bounds.minR && pt[0] <= bounds.maxR &&
    pt[1] >= bounds.minC && pt[1] <= bounds.maxC
  )).length;
  const originalInside = inBoundsCount(validPts);

  const halfWidth = colEnd - colStart;
  const cols = validPts.map((pt) => pt[1]);
  const minCol = Math.min(...cols);
  const maxCol = Math.max(...cols);

  if (colStart > 0 && maxCol < halfWidth) {
    const promoted = validPts.map((pt) => [pt[0], pt[1] + colStart]);
    if (inBoundsCount(promoted) >= originalInside) return promoted;
  }

  if (colStart === 0 && minCol >= halfWidth) {
    const demoted = validPts.map((pt) => [pt[0], pt[1] - halfWidth]);
    if (inBoundsCount(demoted) >= originalInside) return demoted;
  }

  return validPts;
}

function getPanelGeometry(
  panelOffsetX: number,
  panelWidth: number,
  bounds: FootBounds,
  scale: number,
) {
  const drawW = panelWidth - PADDING * 2;
  const drawH = CANVAS_H - PADDING * 2 - TITLE_H;
  const rows = getGridSpan(bounds.minR, bounds.maxR);
  const cols = getGridSpan(bounds.minC, bounds.maxC);
  const footW = cols * scale;
  const footH = rows * scale;
  return {
    rows,
    cols,
    footW,
    footH,
    footX: panelOffsetX + PADDING + (drawW - footW) / 2,
    footY: TITLE_H + PADDING + (drawH - footH) / 2,
  };
}

function computeUnifiedScale(
  panelWidth: number,
  leftBounds: FootBounds,
  rightBounds: FootBounds,
): number {
  const drawW = panelWidth - PADDING * 2;
  const drawH = CANVAS_H - PADDING * 2 - TITLE_H;
  const scaleFor = (bounds: FootBounds) => Math.min(
    drawW / getGridSpan(bounds.minC, bounds.maxC),
    drawH / getGridSpan(bounds.minR, bounds.maxR),
  );
  return Math.min(scaleFor(leftBounds), scaleFor(rightBounds));
}

function drawFootCOP(
  ctx: CanvasRenderingContext2D,
  copPts: number[][],
  peakData: number[] | undefined,
  colStart: number,
  colEnd: number,
  offsetX: number,
  width: number,
  hoveredIdx: number | null,
  title: string,
  sectionCoords: number[][][] | undefined,
  scale: number,
  forcedBounds?: FootBounds,
) {
  ctx.fillStyle = '#1f2937';
  ctx.font = 'bold 14px "Noto Sans SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, offsetX + width / 2, PADDING / 2 + 6);

  // 副标题：显示该脚 内/外侧 ADC 累加 + MLI（提前计算，供标题与切分线共用）
  let mliInfo: { medialSum: number; lateralSum: number; mli: number } | null = null;
  if (peakData && peakData.length === 4096) {
    const side: 'left' | 'right' = colStart === 0 ? 'left' : 'right';
    const lineResult = computeMliLine(peakData, colStart, colEnd, side);
    if (lineResult && lineResult.lateralSum > 0) {
      mliInfo = {
        medialSum: lineResult.medialSum,
        lateralSum: lineResult.lateralSum,
        mli: lineResult.medialSum / lineResult.lateralSum,
      };
    }
  }
  if (mliInfo) {
    ctx.font = '11px monospace';
    ctx.fillStyle = '#475569';
    ctx.fillText(
      `内侧 ${Math.round(mliInfo.medialSum)} : 外侧 ${Math.round(mliInfo.lateralSum)}  ·  MLI=${mliInfo.mli.toFixed(2)}`,
      offsetX + width / 2,
      PADDING / 2 + 22,
    );
  }

  const bounds = forcedBounds ?? computeBounds(colStart, colEnd, sectionCoords);
  const normalizedCopPts = normalizeCopPoints(copPts, colStart, colEnd, bounds);
  const geom = getPanelGeometry(offsetX, width, bounds, scale);

  if (peakData && peakData.length === 4096) {
    const mask = createFootMask(bounds, sectionCoords, geom.rows, geom.cols);
    const rawValues = Array(geom.rows * geom.cols).fill(0);
    for (let r = 0; r < geom.rows; r++) {
      for (let c = 0; c < geom.cols; c++) {
        const idx = r * geom.cols + c;
        if (!mask[idx]) continue;
        const realR = r + bounds.minR;
        const realC = c + bounds.minC;
        rawValues[idx] = (
          realR >= 0 && realR < 64 && realC >= colStart && realC < colEnd
            ? peakData[realR * 64 + realC] || 0
            : 0
        );
      }
    }

    const smoothValues = smoothPressure(rawValues, geom.rows, geom.cols);

    const tmp = document.createElement('canvas');
    tmp.width = geom.cols;
    tmp.height = geom.rows;
    const tctx = tmp.getContext('2d');
    if (tctx) {
      const img = tctx.createImageData(geom.cols, geom.rows);
      for (let r = 0; r < geom.rows; r++) {
        for (let c = 0; c < geom.cols; c++) {
          const idx = r * geom.cols + c;
          const raw = rawValues[idx];
          const v = smoothValues[idx];
          const offset = idx * 4;
          if (raw > 0) {
            const t = normalizePressure(v);
            const [rr, gg, bb] = heatColor(t);
            img.data[offset] = rr;
            img.data[offset + 1] = gg;
            img.data[offset + 2] = bb;
            img.data[offset + 3] = 255;
          } else {
            img.data[offset + 3] = 0;
          }
        }
      }
      tctx.putImageData(img, 0, 0);

      const upscale = 4;
      const up = document.createElement('canvas');
      up.width = geom.cols * upscale;
      up.height = geom.rows * upscale;
      const uctx = up.getContext('2d');
      if (uctx) {
        uctx.imageSmoothingEnabled = false;
        uctx.drawImage(tmp, 0, 0, up.width, up.height);
      }

      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      ctx.filter = 'none';
      ctx.drawImage(up, geom.footX, geom.footY, geom.footW, geom.footH);
      ctx.restore();
    }
  }

  // ===== MLI 内/外侧分界线（10 段中心点折线）=====
  if (peakData && peakData.length === 4096) {
    const side: 'left' | 'right' = colStart === 0 ? 'left' : 'right';
    const line = computeMliLine(peakData, colStart, colEnd, side);
    if (line && line.points.length >= 2) {
      const toXY = (row: number, col: number) => ({
        x: geom.footX + (col - bounds.minC + 0.5) * scale,
        y: geom.footY + (row - bounds.minR + 0.5) * scale,
      });

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1) 10 条水平虚线 — 每个区域一条，呈现各段范围
      ctx.strokeStyle = 'rgba(125,211,252,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      for (const p of line.points) {
        if (p.cMin === undefined || p.cMax === undefined) continue;
        const left = toXY(p.row, p.cMin);
        const right = toXY(p.row, p.cMax);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 2) 黄色折线连接所有 10 段中心点
      const xy = line.points.map(p => toXY(p.row, p.col));

      // 黑色 halo
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xy[0].x, xy[0].y);
      for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
      ctx.stroke();

      // 黄色虚折线
      ctx.strokeStyle = 'rgba(255,235,59,0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(xy[0].x, xy[0].y);
      for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 中心点：黄圆 + 黑边
      ctx.fillStyle = 'rgba(255,235,59,1)';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      for (const p of xy) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  if (normalizedCopPts.length === 0) {
    ctx.fillStyle = '#999';
    ctx.font = '12px "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('无轨迹数据', offsetX + width / 2, geom.footY + geom.footH / 2);
    return;
  }

  const toCanvas = (copX: number, copY: number) => ({
    px: geom.footX + (copY - bounds.minC + 0.5) * scale,
    py: geom.footY + (copX - bounds.minR + 0.5) * scale,
  });
  const isInsideBounds = (pt: number[]) => (
    !Number.isNaN(pt[0]) && !Number.isNaN(pt[1]) &&
    pt[0] >= bounds.minR && pt[0] <= bounds.maxR &&
    pt[1] >= bounds.minC && pt[1] <= bounds.maxC
  );

  const n = normalizedCopPts.length;
  if (n >= 2) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 4;
    for (let i = 0; i < n - 1; i++) {
      if (!isInsideBounds(normalizedCopPts[i]) || !isInsideBounds(normalizedCopPts[i + 1])) continue;
      const from = toCanvas(normalizedCopPts[i][0], normalizedCopPts[i][1]);
      const to = toCanvas(normalizedCopPts[i + 1][0], normalizedCopPts[i + 1][1]);
      ctx.beginPath();
      ctx.moveTo(from.px, from.py);
      ctx.lineTo(to.px, to.py);
      ctx.stroke();
    }

    ctx.lineWidth = 2;
    for (let i = 0; i < n - 1; i++) {
      if (!isInsideBounds(normalizedCopPts[i]) || !isInsideBounds(normalizedCopPts[i + 1])) continue;
      const t = i / (n - 1);
      const [r, g, b] = trajectoryColor(t);
      const from = toCanvas(normalizedCopPts[i][0], normalizedCopPts[i][1]);
      const to = toCanvas(normalizedCopPts[i + 1][0], normalizedCopPts[i + 1][1]);
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.moveTo(from.px, from.py);
      ctx.lineTo(to.px, to.py);
      ctx.stroke();
    }
  }

  const firstVisibleIdx = normalizedCopPts.findIndex(isInsideBounds);
  if (firstVisibleIdx >= 0) {
    const start = toCanvas(normalizedCopPts[firstVisibleIdx][0], normalizedCopPts[firstVisibleIdx][1]);
    ctx.beginPath();
    ctx.arc(start.px, start.py, 3.8, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff00';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  if (hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < n && isInsideBounds(normalizedCopPts[hoveredIdx])) {
    const { px, py } = toCanvas(normalizedCopPts[hoveredIdx][0], normalizedCopPts[hoveredIdx][1]);
    const t = n > 1 ? hoveredIdx / (n - 1) : 0;
    const [r, g, b] = trajectoryColor(t);
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export default function InteractiveCOPChart({
  leftCopRaw,
  rightCopRaw,
  peakFrameData,
  leftSectionCoords,
  rightSectionCoords,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{ side: 'left' | 'right'; idx: number } | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  const leftPanelCop = leftCopRaw || [];
  const rightPanelCop = rightCopRaw || [];

  const getLayout = useCallback((rectWidth: number) => {
    const halfW = rectWidth / 2;
    const [leftBounds, rightBounds] = equalizeBounds(
      computeBounds(0, 32, leftSectionCoords),
      computeBounds(32, 64, rightSectionCoords),
    );
    const scale = computeUnifiedScale(halfW, leftBounds, rightBounds);
    return { halfW, leftBounds, rightBounds, scale };
  }, [leftSectionCoords, rightSectionCoords]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = CANVAS_H * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${CANVAS_H}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, CANVAS_H);
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(0, 0, rect.width, CANVAS_H);

    const { halfW, leftBounds, rightBounds, scale } = getLayout(rect.width);

    drawFootCOP(
      ctx,
      leftPanelCop,
      peakFrameData,
      0,
      32,
      0,
      halfW,
      hoveredPoint?.side === 'left' ? hoveredPoint.idx : null,
      '左脚 COP',
      leftSectionCoords,
      scale,
      leftBounds,
    );
    drawFootCOP(
      ctx,
      rightPanelCop,
      peakFrameData,
      32,
      64,
      halfW,
      halfW,
      hoveredPoint?.side === 'right' ? hoveredPoint.idx : null,
      '右脚 COP',
      rightSectionCoords,
      scale,
      rightBounds,
    );

    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(halfW, 14);
    ctx.lineTo(halfW, CANVAS_H - 14);
    ctx.stroke();
  }, [
    getLayout,
    leftPanelCop,
    rightPanelCop,
    hoveredPoint,
    peakFrameData,
    leftSectionCoords,
    rightSectionCoords,
  ]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [draw]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { halfW, leftBounds, rightBounds, scale } = getLayout(rect.width);
    const side: 'left' | 'right' = mx < halfW ? 'left' : 'right';
    const pts = side === 'left' ? leftPanelCop : rightPanelCop;
    if (pts.length === 0) {
      setHoveredPoint(null);
      setTooltip(null);
      return;
    }

    const colStart = side === 'left' ? 0 : 32;
    const colEnd = side === 'left' ? 32 : 64;
    const sections = side === 'left' ? leftSectionCoords : rightSectionCoords;
    const bounds = side === 'left' ? leftBounds : rightBounds;
    const normalizedPts = normalizeCopPoints(pts, colStart, colEnd, bounds);
    if (normalizedPts.length === 0) {
      setHoveredPoint(null);
      setTooltip(null);
      return;
    }

    const geom = getPanelGeometry(side === 'right' ? halfW : 0, halfW, bounds, scale);
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let i = 0; i < normalizedPts.length; i++) {
      const pt = normalizedPts[i];
      if (
        Number.isNaN(pt[0]) || Number.isNaN(pt[1]) ||
        pt[0] < bounds.minR || pt[0] > bounds.maxR ||
        pt[1] < bounds.minC || pt[1] > bounds.maxC
      ) continue;

      const px = geom.footX + (pt[1] - bounds.minC + 0.5) * scale;
      const py = geom.footY + (pt[0] - bounds.minR + 0.5) * scale;
      const d = (mx - px) ** 2 + (my - py) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    if (bestDist > 400 || bestIdx < 0) {
      setHoveredPoint(null);
      setTooltip(null);
      return;
    }

    setHoveredPoint({ side, idx: bestIdx });
    setTooltip({
      x: mx,
      y: my,
      side,
      frameIndex: bestIdx,
      totalFrames: pts.length,
      copX: Math.round(normalizedPts[bestIdx][0] * 7 * 10) / 10,
      copY: Math.round(normalizedPts[bestIdx][1] * 7 * 10) / 10,
    });
  }, [getLayout, leftPanelCop, rightPanelCop, leftSectionCoords, rightSectionCoords]);

  const handleMouseLeave = useCallback(() => {
    setHoveredPoint(null);
    setTooltip(null);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        className="w-full rounded-lg cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none z-10 bg-white/95 border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-sm"
          style={{
            left: Math.min(tooltip.x + 12, (containerRef.current?.clientWidth || 400) - 200),
            top: tooltip.y - 80,
          }}
        >
          <div className="font-semibold text-gray-800">
            {tooltip.side === 'left' ? '左脚' : '右脚'} · 帧 {tooltip.frameIndex + 1}/{tooltip.totalFrames}
          </div>
          <div className="text-gray-600 mt-1">COP X: {tooltip.copX} mm</div>
          <div className="text-gray-600">COP Y: {tooltip.copY} mm</div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-4 text-xs">
        <div className="flex-1 flex items-center gap-2">
          <span className="text-slate-500 w-10 text-right">压力低</span>
          <div
            className="flex-1 h-2.5 rounded"
            style={{
              background: 'linear-gradient(to right, rgb(0,0,127), rgb(0,0,255), rgb(0,255,255), rgb(255,255,0), rgb(255,0,0), rgb(127,0,0))',
            }}
          />
          <span className="text-slate-500 w-10">高</span>
        </div>
        <div className="flex-1 flex items-center gap-2">
          <span className="text-slate-500 w-10 text-right">起点</span>
          <div
            className="flex-1 h-2.5 rounded"
            style={{
              background: 'linear-gradient(to right, rgb(255,255,255), rgb(255,255,0))',
            }}
          />
          <span className="text-slate-500 w-10">终点</span>
        </div>
      </div>
    </div>
  );
}
