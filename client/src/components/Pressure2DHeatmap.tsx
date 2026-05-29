/**
 * 2D 压力热力图组件
 * - 左右脚分两个面板，每格显示 ADC 数值
 * - Hover tooltip 显示精确信息
 * - 鼠标滚轮缩放 + 拖动平移 + 工具栏按钮控制
 */

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Move } from 'lucide-react';
import { computeMliLine } from '@/lib/mli';

interface Props {
  realtimeData: number[][] | null;
  /** 是否在每个非零格内显示 ADC 数值（默认 true） */
  showValues?: boolean;
}

interface TooltipInfo {
  x: number;
  y: number;
  row: number;
  col: number;
  side: 'left' | 'right';
  value: number;
}

const ROWS = 64;
const COLS_PER_FOOT = 32;
const TOTAL_COLS = 64;

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

/** 把原始 ADC 值映射到 [0,1] 归一化区间，可指定 vmin/vmax（matplotlib 风格） */
function normalize(v: number, vmin: number, vmax: number): number {
  if (vmax <= vmin) return v <= vmin ? 0 : 1;
  return Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
}

/** matplotlib 经典 jet 色图：深蓝(0,0,127)→蓝→青→黄→红→深红(127,0,0) */
function jetRGB(t: number): [number, number, number] {
  if (t <= 0) return [0, 0, 127];
  if (t >= 1) return [127, 0, 0];
  if (t < 0.125) {
    const s = t / 0.125;
    return [0, 0, Math.round(127 + s * 128)];
  }
  if (t < 0.375) {
    const s = (t - 0.125) / 0.25;
    return [0, Math.round(s * 255), 255];
  }
  if (t < 0.625) {
    const s = (t - 0.375) / 0.25;
    return [Math.round(s * 255), 255, Math.round(255 - s * 255)];
  }
  if (t < 0.875) {
    const s = (t - 0.625) / 0.25;
    return [255, Math.round(255 - s * 255), 0];
  }
  const s = (t - 0.875) / 0.125;
  return [Math.round(255 - s * 128), 0, 0];
}

/** jet 色图填色：所有 cell（包括 0）都得到 jet 颜色（0 → 深蓝） */
function heatColor(v: number, vmin: number, vmax: number): string {
  const t = normalize(v, vmin, vmax);
  const [r, g, b] = jetRGB(t);
  return `rgb(${r},${g},${b})`;
}

/** 根据归一化值判断文字颜色：jet 中段（青/绿/黄）背景亮，用深色字 */
function textColorFor(v: number, vmin: number, vmax: number): string {
  const t = normalize(v, vmin, vmax);
  return t > 0.3 && t < 0.75 ? '#000' : '#fff';
}

export default function Pressure2DHeatmap({ realtimeData, showValues = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // 缩放和平移状态
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // 颜色映射范围：开发者侧固定，不暴露给用户
  // vmin=0：低于阈值的底噪在 SerialService 已过滤
  // vmax=150：让中等压力即可呈现红色，避免大部分足底是绿色
  const VMIN = 0;
  const VMAX = 150;

  // 数据预处理：
  //   1) 逆时针旋转 90°：new[r][c] = old[c][N-1-r]，让左右脚分布到 cols 0-31 / 32-63
  //   2) 垂直翻转：再做一次 row 反转，让脚尖朝上（行 0 = 脚尖，行 63 = 脚跟）
  // 合并后的等价公式：new[r][c] = old[c][r]
  const displayData = useMemo(() => {
    if (!realtimeData) return null;
    const N = TOTAL_COLS;
    const result: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        result[r][c] = realtimeData[c]?.[r] ?? 0;
      }
    }
    return result;
  }, [realtimeData]);

  // 统计信息
  const stats = useMemo(() => {
    if (!displayData) return { max: 0, min: 0, activeCells: 0, totalPressure: 0, leftPressure: 0, rightPressure: 0 };
    let max = 0;
    let min = Infinity;
    let activeCells = 0;
    let totalPressure = 0;
    let leftPressure = 0;
    let rightPressure = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < TOTAL_COLS; c++) {
        const v = displayData[r]?.[c] ?? 0;
        if (v > 0) {
          activeCells++;
          totalPressure += v;
          if (v > max) max = v;
          if (v < min) min = v;
          if (c < COLS_PER_FOOT) leftPressure += v;
          else rightPressure += v;
        }
      }
    }
    return {
      max,
      min: min === Infinity ? 0 : min,
      activeCells,
      totalPressure,
      leftPressure,
      rightPressure,
    };
  }, [realtimeData]);

  /** 基础单格像素大小（缩放前） */
  const baseCellSize = useMemo(() => {
    if (containerSize.width <= 0) return 8;
    const gap = 16;
    const padding = 32;
    const usableW = containerSize.width - gap - padding;
    return Math.max(4, Math.floor(usableW / TOTAL_COLS));
  }, [containerSize.width]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const gap = 16;
    const padding = 16;
    const cellSize = baseCellSize;
    const totalW = COLS_PER_FOOT * cellSize * 2 + gap + padding * 2;
    const totalH = ROWS * cellSize + padding * 2;

    canvas.width = totalW * dpr;
    canvas.height = totalH * dpr;
    canvas.style.width = `${totalW}px`;
    canvas.style.height = `${totalH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, totalW, totalH);

    // 背景
    ctx.fillStyle = '#0f0f1e';
    ctx.fillRect(0, 0, totalW, totalH);

    if (!displayData) {
      ctx.fillStyle = '#666';
      ctx.font = '14px "Noto Sans SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('等待数据...', totalW / 2, totalH / 2);
      return;
    }

    // 颜色映射范围（开发者固定）
    const effectiveVmax = VMAX;
    const effectiveVmin = VMIN;
    // 文字尺寸：基础 cellSize × 当前 scale 决定可读性
    const effectiveCell = cellSize * scale;
    const fontSize = Math.max(5, Math.min(cellSize * 0.55, 11));
    const showText = showValues && effectiveCell >= 10;

    for (let panel = 0; panel < 2; panel++) {
      const colStart = panel === 0 ? 0 : COLS_PER_FOOT;
      const offsetX = padding + (panel === 0 ? 0 : COLS_PER_FOOT * cellSize + gap);

      // 面板边框
      ctx.strokeStyle = panel === 0 ? '#3b82f6' : '#22c55e';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        offsetX - 1,
        padding - 1,
        COLS_PER_FOOT * cellSize + 2,
        ROWS * cellSize + 2,
      );

      // 面板标题
      ctx.fillStyle = panel === 0 ? '#60a5fa' : '#4ade80';
      ctx.font = 'bold 11px "Noto Sans SC", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(panel === 0 ? '左脚 L' : '右脚 R', offsetX + 2, padding - 14);

      // M/L 累加值（提前算好，等会儿要画在标题旁）
      const sideForInfo: 'left' | 'right' = panel === 0 ? 'left' : 'right';
      const titleLine = computeMliLine(displayData, colStart, colStart + COLS_PER_FOOT, sideForInfo);
      if (titleLine && titleLine.lateralSum > 0) {
        const mliVal = titleLine.medialSum / titleLine.lateralSum;
        ctx.fillStyle = '#fde047';
        ctx.font = '10px monospace';
        ctx.fillText(
          `内 ${Math.round(titleLine.medialSum)} : 外 ${Math.round(titleLine.lateralSum)}  MLI=${mliVal.toFixed(2)}`,
          offsetX + 50,
          padding - 14,
        );
      }

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS_PER_FOOT; c++) {
          const realCol = colStart + c;
          const v = displayData[r]?.[realCol] ?? 0;
          const px = offsetX + c * cellSize;
          const py = padding + r * cellSize;

          ctx.fillStyle = heatColor(v, effectiveVmin, effectiveVmax);
          ctx.fillRect(px, py, cellSize, cellSize);

          // 每个 cell 都显示 ADC 值（包括 0）
          if (showText) {
            ctx.fillStyle = textColorFor(v, effectiveVmin, effectiveVmax);
            ctx.font = `${fontSize}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(
              String(Math.round(v)),
              px + cellSize / 2,
              py + cellSize / 2,
            );
          }
        }
      }

      // ===== MLI 内/外侧分界线可视化（与 mli.ts 同算法：10 段中心点折线）=====
      const side: 'left' | 'right' = panel === 0 ? 'left' : 'right';
      const line = computeMliLine(displayData, colStart, colStart + COLS_PER_FOOT, side);

      const topY = padding;
      const botY = padding + ROWS * cellSize;

      ctx.save();

      if (line && line.points.length >= 2) {
        const toXY = (row: number, col: number) => ({
          x: offsetX + (col - colStart + 0.5) * cellSize,
          y: padding + (row + 0.5) * cellSize,
        });

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 1) 10 条水平虚线（每个区域一条）— 半透明青色，呈现各段范围
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

        // 2) 加粗黄色虚折线连接所有 10 段中心点
        const xy = line.points.map(p => toXY(p.row, p.col));
        ctx.strokeStyle = 'rgba(255,235,59,0.9)';
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 5]);
        ctx.beginPath();
        ctx.moveTo(xy[0].x, xy[0].y);
        for (let i = 1; i < xy.length; i++) ctx.lineTo(xy[i].x, xy[i].y);
        ctx.stroke();
        ctx.setLineDash([]);

        // 3) 每个中心点画黄圆
        ctx.fillStyle = 'rgba(255,235,59,1)';
        for (const p of xy) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        // 无数据 → 画 panel 几何中心的竖虚线作为参考
        const lineX = offsetX + (COLS_PER_FOOT / 2) * cellSize;
        ctx.strokeStyle = 'rgba(255,235,59,0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(lineX, topY);
        ctx.lineTo(lineX, botY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 标签：左脚 → 左半外侧 / 右半内侧；右脚 → 左半内侧 / 右半外侧
      const leftLabel = panel === 0 ? '外侧 L' : '内侧 M';
      const rightLabel = panel === 0 ? '内侧 M' : '外侧 L';
      const leftLabelColor = panel === 0 ? '#3b82f6' : '#ef4444';
      const rightLabelColor = panel === 0 ? '#ef4444' : '#3b82f6';

      const labelY = topY + 14;
      const quarter = (COLS_PER_FOOT / 4) * cellSize;
      const leftHalfCenter = offsetX + quarter;
      const rightHalfCenter = offsetX + COLS_PER_FOOT * cellSize - quarter;

      ctx.font = 'bold 13px "Noto Sans SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const drawLabelChip = (text: string, x: number, color: string) => {
        const padX = 6;
        const w = ctx.measureText(text).width + padX * 2;
        const h = 18;
        ctx.fillStyle = 'rgba(15,15,30,0.85)';
        ctx.fillRect(x - w / 2, labelY - h / 2, w, h);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - w / 2, labelY - h / 2, w, h);
        ctx.fillStyle = color;
        ctx.fillText(text, x, labelY);
      };
      drawLabelChip(leftLabel, leftHalfCenter, leftLabelColor);
      drawLabelChip(rightLabel, rightHalfCenter, rightLabelColor);

      ctx.restore();
    }
  }, [baseCellSize, displayData, showValues, scale]);

  // 监听容器尺寸变化
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    draw();
  }, [draw]);

  /** 工具栏控制：缩放和重置 */
  /** 滚轮缩放（以鼠标位置为中心） */
  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      // 鼠标在 viewport 内的位置
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      if (newScale === scale) return;

      // 保持鼠标指向的点不动：调整偏移量
      const ratio = newScale / scale;
      setOffset((prev) => ({
        x: mx - (mx - prev.x) * ratio,
        y: my - (my - prev.y) * ratio,
      }));
      setScale(+newScale.toFixed(3));
    },
    [scale],
  );

  /** 鼠标按下开始拖动 */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // 仅左键拖动
      e.preventDefault();
      dragStateRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: offset.x,
        baseY: offset.y,
      };
      setIsDragging(true);
      setTooltip(null);
    },
    [offset],
  );

  const handleMouseUp = useCallback(() => {
    dragStateRef.current = null;
    setIsDragging(false);
  }, []);

  /** 鼠标移动：拖动 or 检测悬停位置 */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 拖动模式
      if (dragStateRef.current) {
        const ds = dragStateRef.current;
        setOffset({
          x: ds.baseX + (e.clientX - ds.startX),
          y: ds.baseY + (e.clientY - ds.startY),
        });
        return;
      }

      // 悬停查询
      if (!displayData) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // canvas.getBoundingClientRect 已经包含了 transform 后的位置
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / scale;
      const my = (e.clientY - rect.top) / scale;

      const padding = 16;
      const gap = 16;
      const cellSize = baseCellSize;

      const leftPanelStart = padding;
      const leftPanelEnd = padding + COLS_PER_FOOT * cellSize;
      const rightPanelStart = leftPanelEnd + gap;
      const rightPanelEnd = rightPanelStart + COLS_PER_FOOT * cellSize;

      let side: 'left' | 'right' | null = null;
      let panelOffsetX = 0;
      if (mx >= leftPanelStart && mx <= leftPanelEnd) {
        side = 'left';
        panelOffsetX = leftPanelStart;
      } else if (mx >= rightPanelStart && mx <= rightPanelEnd) {
        side = 'right';
        panelOffsetX = rightPanelStart;
      }

      if (!side || my < padding || my > padding + ROWS * cellSize) {
        setTooltip(null);
        return;
      }

      const c = Math.floor((mx - panelOffsetX) / cellSize);
      const r = Math.floor((my - padding) / cellSize);
      if (c < 0 || c >= COLS_PER_FOOT || r < 0 || r >= ROWS) {
        setTooltip(null);
        return;
      }
      const realCol = side === 'left' ? c : c + COLS_PER_FOOT;
      const v = displayData[r]?.[realCol] ?? 0;
      const viewportRect = viewportRef.current?.getBoundingClientRect();
      setTooltip({
        x: e.clientX - (viewportRect?.left ?? 0),
        y: e.clientY - (viewportRect?.top ?? 0),
        row: r,
        col: realCol,
        side,
        value: v,
      });
    },
    [displayData, scale, baseCellSize],
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
    handleMouseUp();
  }, [handleMouseUp]);

  return (
    <div className="w-full h-full flex flex-col bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 rounded-xl overflow-hidden">
      {/* 顶部统计信息 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur shrink-0">
        <div className="flex items-center gap-4 text-xs">
          <div>
            <span className="text-slate-500">最大ADC </span>
            <span className="font-mono font-semibold text-rose-600">{stats.max}</span>
          </div>
          <div>
            <span className="text-slate-500">活动点 </span>
            <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">{stats.activeCells}</span>
          </div>
          <div>
            <span className="text-slate-500">总压 </span>
            <span className="font-mono font-semibold text-slate-700 dark:text-slate-200">{stats.totalPressure}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-slate-500">L</span>
            <span className="font-mono">{stats.leftPressure}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-slate-500">R</span>
            <span className="font-mono">{stats.rightPressure}</span>
          </div>
        </div>
      </div>

      {/* 热力图主区域（viewport：固定大小，内部 canvas 可缩放/平移） */}
      <div
        ref={containerRef}
        className="flex-1 relative min-h-0"
      >
        <div
          ref={viewportRef}
          className={`absolute inset-0 overflow-hidden ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <canvas
            ref={canvasRef}
            className="rounded-md shadow-inner select-none"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transformOrigin: '0 0',
              transition: isDragging ? 'none' : 'transform 0.08s ease-out',
            }}
          />
        </div>

        {/* Tooltip */}
        {tooltip && !isDragging && (
          <div
            className="absolute pointer-events-none z-20 bg-slate-900/95 text-white border border-slate-700 rounded-md shadow-xl px-2.5 py-1.5 text-xs"
            style={{
              left: Math.min(
                tooltip.x + 14,
                (containerRef.current?.clientWidth ?? 400) - 140,
              ),
              top: Math.max(0, tooltip.y - 60),
            }}
          >
            <div className="font-semibold mb-0.5">
              <span className={tooltip.side === 'left' ? 'text-blue-400' : 'text-green-400'}>
                {tooltip.side === 'left' ? '左脚' : '右脚'}
              </span>
              <span className="text-slate-400 ml-2">[{tooltip.row}, {tooltip.col}]</span>
            </div>
            <div className="font-mono text-rose-300">ADC: {tooltip.value}</div>
          </div>
        )}

        {/* 缩放比例 + 操作提示：左下角 */}
        <div className="absolute bottom-3 left-3 flex flex-col gap-1.5 z-10 pointer-events-none">
          <div className="flex items-center gap-1.5 bg-white/90 dark:bg-slate-800/90 backdrop-blur px-2 py-1 rounded-md shadow-sm border border-slate-200 dark:border-slate-700 text-xs font-mono">
            <span className="text-slate-500">缩放</span>
            <span className="text-slate-700 dark:text-slate-200 font-semibold">{Math.round(scale * 100)}%</span>
          </div>
          <div className="flex items-center gap-1 bg-white/70 dark:bg-slate-800/70 backdrop-blur px-2 py-0.5 rounded text-[10px] text-slate-500">
            <Move className="w-3 h-3" />
            <span>拖动平移 · 滚轮缩放</span>
          </div>
        </div>
      </div>

      {/* 底部图例（仅显示 jet 渐变 + 范围，不可调） */}
      <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-white/60 dark:bg-slate-900/60 backdrop-blur shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-mono w-8 text-right">{VMIN}</span>
          <div
            className="flex-1 h-2.5 rounded"
            style={{
              background:
                'linear-gradient(to right, rgb(0,0,127), rgb(0,0,255), rgb(0,255,255), rgb(255,255,0), rgb(255,0,0), rgb(127,0,0))',
            }}
          />
          <span className="text-xs text-slate-500 font-mono w-8">{VMAX}+</span>
        </div>
      </div>
    </div>
  );
}
