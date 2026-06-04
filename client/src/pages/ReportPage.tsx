/**
 * 分析报告页面
 * 设计风格：医疗科技极简主义
 * 集成OneStep SDK算法：
 * - 足弓分析（AI指数）
 * - 压力分布（前/中/后足面积和压力占比）
 * - COP分析（轨迹、置信椭圆、摇摆特征）
 */

import {
  useApp,
  type FootAnalysisResult,
  type ReportData,
  type FootData as AppFootData,
  type PressureData,
} from '@/contexts/AppContext';
import { Button } from '@/components/ui/button';
import { parseCSVData } from '@/lib/collectionData';
import { ArrowRight, Upload, User, Ruler, BarChart3, Activity, Target, Info } from 'lucide-react';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts';
import {
  FootReport,
  generateFootReport,
  parseFrameData,
  calculateCOP,
} from '@/lib/FootAnalysis';
import {
  checkPythonBackend,
  analyzePython,
  convertPythonResult,
  type PythonImages,
  type PythonArchFeatures,
} from '@/lib/pythonApi';
import InteractiveArchChart from '@/components/InteractiveArchChart';
import InteractiveCOPChart from '@/components/InteractiveCOPChart';
import { calculateMLI, type MliResult } from '@/lib/mli';

interface ReportPageProps {
  onNext: () => void;
}

// 颜色常量
const COLORS = {
  primary: '#1e6bb8',
  secondary: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  chart1: '#60a5fa',
  chart2: '#34d399',
  chart3: '#fbbf24',
  chart4: '#a78bfa',
};

// 生成模拟采集数据（用于演示）- 增加COP变化以模拟真实站立摇摆
function generateMockFrames(frameCount = 100): number[][] {
  const frames: number[][] = [];
  
  for (let f = 0; f < frameCount; f++) {
    const frame: number[] = new Array(4096).fill(0);
    
    // 模拟站立时的前后左右摇摆
    const swayX = Math.sin(f * 0.15) * 3 + Math.sin(f * 0.07) * 2; // 前后摇摆
    const swayY = Math.cos(f * 0.12) * 2 + Math.cos(f * 0.05) * 1.5; // 左右摇摆
    
    // 压力重心偏移（模拟重心转移）
    const pressureShiftX = Math.sin(f * 0.08) * 0.3; // 前后压力转移
    const pressureShiftY = Math.cos(f * 0.1) * 0.2; // 左右压力转移
    
    // 左脚区域 (大约在 y: 8-28)
    const leftCenterX = 32 + swayX;
    const leftCenterY = 18 + swayY;
    for (let x = 10; x < 54; x++) {
      for (let y = 8; y < 28; y++) {
        const distFromCenter = Math.sqrt(Math.pow(x - leftCenterX, 2) + Math.pow(y - leftCenterY, 2));
        if (distFromCenter < 20) {
          // 足弓区域压力较低
          const isArchArea = x > 25 && x < 40 && y > 12 && y < 24;
          const basePressure = isArchArea ? 20 : 80;
          // 根据位置和摇摆调整压力
          const positionFactor = 1 + (x - 32) * pressureShiftX * 0.02 + (y - 18) * pressureShiftY * 0.02;
          const variation = Math.sin(f * 0.1) * 10 + Math.random() * 15;
          frame[x * 64 + y] = Math.max(0, (basePressure + variation) * positionFactor);
        }
      }
    }
    
    // 右脚区域 (大约在 y: 36-56)
    const rightCenterX = 32 + swayX;
    const rightCenterY = 46 - swayY; // 右脚摇摆方向相反
    for (let x = 10; x < 54; x++) {
      for (let y = 36; y < 56; y++) {
        const distFromCenter = Math.sqrt(Math.pow(x - rightCenterX, 2) + Math.pow(y - rightCenterY, 2));
        if (distFromCenter < 20) {
          const isArchArea = x > 25 && x < 40 && y > 40 && y < 52;
          const basePressure = isArchArea ? 25 : 85;
          const positionFactor = 1 + (x - 32) * pressureShiftX * 0.02 - (y - 46) * pressureShiftY * 0.02;
          const variation = Math.cos(f * 0.1) * 10 + Math.random() * 15;
          frame[x * 64 + y] = Math.max(0, (basePressure + variation) * positionFactor);
        }
      }
    }
    
    frames.push(frame);
  }
  
  return frames;
}

// 压力热力图组件 - 优化版，使用高斯模糊实现连续美观的渐变效果
function PressureHeatmap({ matrix, title }: { matrix: number[][]; title: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // 找最大值
    let maxVal = 0;
    for (const row of matrix) {
      for (const val of row) {
        if (val > maxVal) maxVal = val;
      }
    }
    if (maxVal === 0) maxVal = 1;
    
    // 放大倍数和布局
    const scale = 4;
    const size = 64 * scale;
    canvas.width = size;
    canvas.height = size;
    
    // 先在临时canvas上绘制原始数据
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 64;
    tempCanvas.height = 64;
    const tempCtx = tempCanvas.getContext('2d')!;
    const imageData = tempCtx.createImageData(64, 64);
    
    // 颜色映射函数：蓝-青-绿-黄-橙-红（参考OneStep报告配色）
    const getColor = (val: number): [number, number, number] => {
      if (val <= 0) return [0, 0, 0];
      
      // 更平滑的颜色过渡
      if (val < 0.2) {
        // 蓝色到青色
        const t = val / 0.2;
        return [0, Math.round(100 + t * 155), Math.round(255 - t * 55)];
      } else if (val < 0.4) {
        // 青色到绿色
        const t = (val - 0.2) / 0.2;
        return [0, 255, Math.round(200 - t * 200)];
      } else if (val < 0.6) {
        // 绿色到黄色
        const t = (val - 0.4) / 0.2;
        return [Math.round(t * 255), 255, 0];
      } else if (val < 0.8) {
        // 黄色到橙色
        const t = (val - 0.6) / 0.2;
        return [255, Math.round(255 - t * 100), 0];
      } else {
        // 橙色到红色
        const t = (val - 0.8) / 0.2;
        return [255, Math.round(155 - t * 155), 0];
      }
    };
    
    // 填充原始数据（与Python origin='upper' 一致，行0在上方）
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const val = matrix[i][j] / maxVal;
        const [r, g, b] = getColor(val);
        const idx = (i * 64 + j) * 4;
        imageData.data[idx] = r;
        imageData.data[idx + 1] = g;
        imageData.data[idx + 2] = b;
        imageData.data[idx + 3] = matrix[i][j] > 0 ? 255 : 0;
      }
    }
    tempCtx.putImageData(imageData, 0, 0);
    
    // 应用高斯模糊实现平滑效果
    ctx.filter = 'blur(3px)';
    ctx.drawImage(tempCanvas, 0, 0, size, size);
    ctx.filter = 'none';
    
    // 再次绘制以增强颜色
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'blur(1px)';
    ctx.drawImage(tempCanvas, 0, 0, size, size);
    ctx.filter = 'none';
    
  }, [matrix]);
  
  return (
    <div className="flex flex-col items-center">
      <canvas 
        ref={canvasRef} 
        className="rounded-lg shadow-md bg-gray-50"
        style={{ imageRendering: 'auto' }}
      />
      <span className="mt-2 text-sm font-medium text-muted-foreground">{title}</span>
      {/* 颜色图例 */}
      <div className="flex items-center gap-1 mt-2">
        <span className="text-xs text-muted-foreground">低压</span>
        <div className="flex h-2 rounded overflow-hidden">
          <div className="w-4 bg-blue-500" />
          <div className="w-4 bg-cyan-400" />
          <div className="w-4 bg-green-500" />
          <div className="w-4 bg-yellow-400" />
          <div className="w-4 bg-orange-500" />
          <div className="w-4 bg-red-500" />
        </div>
        <span className="text-xs text-muted-foreground">高压</span>
      </div>
    </div>
  );
}

// 单脚COP轨迹图组件 - 参考Python代码的draw_cop_content函数
function SingleFootCOPChart({ 
  trajectory, 
  title 
}: { 
  trajectory: { x: number; y: number }[]; 
  title: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || trajectory.length < 2) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const width = 280;
    const height = 280;
    canvas.width = width;
    canvas.height = height;
    
    // 清空画布
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    
    // 计算数据范围
    const xValues = trajectory.map(p => p.x * 7); // 转换为mm
    const yValues = trajectory.map(p => p.y * 7);
    const centerX = xValues.reduce((a, b) => a + b, 0) / xValues.length;
    const centerY = yValues.reduce((a, b) => a + b, 0) / yValues.length;
    
    const rangeX = Math.max(...xValues) - Math.min(...xValues);
    const rangeY = Math.max(...yValues) - Math.min(...yValues);
    const maxRange = Math.max(rangeX, rangeY, 10) * 1.3;
    const halfRange = maxRange / 2 + 2; // 边距
    
    const margin = { top: 35, right: 20, bottom: 40, left: 50 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    
    // 坐标转换函数
    const toCanvasX = (x: number) => margin.left + ((x - centerX + halfRange) / (2 * halfRange)) * plotWidth;
    const toCanvasY = (y: number) => margin.top + ((halfRange - (y - centerY)) / (2 * halfRange)) * plotHeight;
    
    // 绘制网格 - 主网格
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    const gridCount = 5;
    for (let i = 0; i <= gridCount; i++) {
      const x = margin.left + plotWidth * i / gridCount;
      const y = margin.top + plotHeight * i / gridCount;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, height - margin.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(width - margin.right, y);
      ctx.stroke();
    }
    
    // 绘制轨迹线
    ctx.beginPath();
    ctx.moveTo(toCanvasX(xValues[0]), toCanvasY(yValues[0]));
    for (let i = 1; i < trajectory.length; i++) {
      ctx.lineTo(toCanvasX(xValues[i]), toCanvasY(yValues[i]));
    }
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // 绘制轨迹点（颜色渐变表示时间 - viridis配色）
    for (let i = 0; i < trajectory.length; i++) {
      const t = i / Math.max(trajectory.length - 1, 1);
      // viridis配色方案
      const r = Math.round(68 + t * (253 - 68));
      const g = Math.round(1 + t * (231 - 1));
      const b = Math.round(84 + t * (37 - 84));
      
      ctx.beginPath();
      ctx.arc(toCanvasX(xValues[i]), toCanvasY(yValues[i]), 4, 0, 2 * Math.PI);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fill();
    }
    
    // 绘制标题
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(title, width / 2, 20);
    
    // 绘制坐标轴标签
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('前后', width / 2, height - 8);
    
    ctx.save();
    ctx.translate(12, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('左右', 0, 0);
    ctx.restore();
    
    // 绘制刻度值
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#9ca3af';
    
    // X轴刻度
    ctx.textAlign = 'center';
    for (let i = 0; i <= gridCount; i++) {
      const val = centerX - halfRange + (2 * halfRange) * i / gridCount;
      const x = margin.left + plotWidth * i / gridCount;
      ctx.fillText(val.toFixed(1), x, height - margin.bottom + 15);
    }
    
    // Y轴刻度
    ctx.textAlign = 'right';
    for (let i = 0; i <= gridCount; i++) {
      const val = centerY + halfRange - (2 * halfRange) * i / gridCount;
      const y = margin.top + plotHeight * i / gridCount;
      ctx.fillText(val.toFixed(1), margin.left - 5, y + 3);
    }
    
  }, [trajectory, title]);
  
  if (trajectory.length < 2) {
    return (
      <div className="flex flex-col items-center">
        <div className="text-sm font-medium mb-2">{title}</div>
        <div className="w-[280px] h-[280px] bg-gray-50 rounded-lg border flex items-center justify-center">
          <span className="text-muted-foreground text-sm">数据不足</span>
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col items-center">
      <canvas 
        ref={canvasRef} 
        className="rounded-lg border bg-white"
        style={{ width: '280px', height: '280px' }}
      />
    </div>
  );
}

// 双脚COP轨迹图组件 - 左右脚并排显示
function DualFootCOPChart({ 
  leftTrajectory, 
  rightTrajectory 
}: { 
  leftTrajectory: { x: number; y: number }[]; 
  rightTrajectory: { x: number; y: number }[];
}) {
  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center justify-center gap-6">
        <SingleFootCOPChart trajectory={leftTrajectory} title="左脚 COP 轨迹" />
        <SingleFootCOPChart trajectory={rightTrajectory} title="右脚 COP 轨迹" />
      </div>
      {/* 颜色图例 */}
      <div className="flex items-center justify-center gap-2 mt-4">
        <span className="text-xs text-muted-foreground">时间序列:</span>
        <div className="w-24 h-3 rounded" style={{
          background: 'linear-gradient(to right, rgb(68, 1, 84), rgb(59, 82, 139), rgb(33, 145, 140), rgb(94, 201, 98), rgb(253, 231, 37))'
        }} />
        <span className="text-xs text-muted-foreground">开始 → 结束</span>
      </div>
    </div>
  );
}

// 足弓类型指示器 - 修改为显示数值而非百分数
function ArchTypeIndicator({ type, value }: { type: string; value: number }) {
  const getColor = () => {
    if (type.includes('正常')) return COLORS.secondary;
    if (type.includes('高') || type.includes('扁平')) return COLORS.warning;
    return COLORS.primary;
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className="w-3 h-3 rounded-full"
        style={{ backgroundColor: getColor() }}
      />
      <span className="text-sm font-medium">{type}</span>
    </div>
  );
}

/** MLI 足弓内外翻指示器 */
function MliIndicator({ label, result }: { label: string; result: MliResult | null }) {
  if (!result) {
    return (
      <div>
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-3 h-3 rounded-full bg-gray-300" />
          <span className="text-sm text-muted-foreground">数据不足</span>
        </div>
      </div>
    );
  }
  const color =
    result.classification === 'normal' ? COLORS.secondary :
    result.classification === 'pronation_risk' ? COLORS.danger : COLORS.warning;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          MLI {result.mli.toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm font-medium">{result.label}</span>
      </div>
    </div>
  );
}

function getArchHeight(archType: string): AppFootData['archHeight'] {
  if (archType.includes('扁')) return 'low';
  if (archType.includes('高')) return 'high';
  return 'normal';
}

function createSharedReportData(report: FootReport, currentUser: ReportData['user']): ReportData {
  const buildFoot = (length: number, width: number, archType: string): AppFootData => ({
    footLength: length,
    footWidth: width,
    pronation: 'normal',
    archHeight: getArchHeight(archType),
  });

  const buildPressure = (
    totalPressure: number,
    area: number,
    leftRatio: number,
    forefootRatio: number,
  ): PressureData => ({
    peakPressure: totalPressure,
    avgPressure: totalPressure,
    totalPressure,
    peakArea: area,
    avgArea: area,
    leftRightRatio: leftRatio,
    frontBackRatio: forefootRatio,
  });

  return {
    user: currentUser,
    leftFoot: buildFoot(report.left.length, report.left.width, report.left.archAnalysis.archType),
    rightFoot: buildFoot(report.right.length, report.right.width, report.right.archAnalysis.archType),
    leftPressure: buildPressure(
      report.left.footData.pressure,
      report.left.footData.area,
      report.bilateral.leftPressureRatio,
      report.bilateral.forefootRatio,
    ),
    rightPressure: buildPressure(
      report.right.footData.pressure,
      report.right.footData.area,
      report.bilateral.rightPressureRatio,
      report.bilateral.forefootRatio,
    ),
    timestamp: new Date(),
  };
}

function createFootAnalysis(report: FootReport): FootAnalysisResult {
  return {
    left: {
      archIndex: report.left.archAnalysis.archIndex,
      archType: report.left.archAnalysis.archType,
      footLength: report.left.length,
      footWidth: report.left.width,
      totalPressure: report.left.footData.pressure,
    },
    right: {
      archIndex: report.right.archAnalysis.archIndex,
      archType: report.right.archAnalysis.archType,
      footLength: report.right.length,
      footWidth: report.right.width,
      totalPressure: report.right.footData.pressure,
    },
    bilateral: {
      leftPressureRatio: report.bilateral.leftPressureRatio,
      rightPressureRatio: report.bilateral.rightPressureRatio,
    },
  };
}

export default function ReportPage({ onNext }: ReportPageProps) {
  const {
    state,
    clearCollectedData,
    setCollectedData,
    setFootAnalysis,
    setReportData,
    setAnalysisStatus,
  } = useApp();
  const [report, setReport] = useState<FootReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [analysisSource, setAnalysisSource] = useState<'python' | 'js' | null>(null);
  const [pythonImages, setPythonImages] = useState<PythonImages | null>(null);
  const [archFeatures, setArchFeatures] = useState<PythonArchFeatures | null>(null);
  const [copTrajectories, setCopTrajectories] = useState<{ left: number[][]; right: number[][] } | null>(null);
  const [isImportingCsv, setIsImportingCsv] = useState(false);
  const [importedCsvName, setImportedCsvName] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const handleImportCsvClick = useCallback(() => {
    csvInputRef.current?.click();
  }, []);

  const handleCsvFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImportingCsv(true);
    setAnalysisStatus('pending');
    setFootAnalysis(null);
    setReportData(null);

    try {
      const text = await file.text();
      const frames = parseCSVData(text);

      if (frames.length === 0) {
        throw new Error('未能解析到有效数据');
      }

      clearCollectedData();
      setCollectedData(frames);
      setImportedCsvName(file.name);
    } catch (error) {
      console.error('[Report CSV Import] 导入失败:', error);
      setAnalysisStatus('error');
      alert(`CSV 导入失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setIsImportingCsv(false);
      if (csvInputRef.current) {
        csvInputRef.current.value = '';
      }
    }
  }, [clearCollectedData, setAnalysisStatus, setCollectedData, setFootAnalysis, setReportData]);

  // 生成报告数据：优先使用 Python 后端，失败时回退到前端 JS 计算
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setAnalysisStatus('pending');

    const frames = state.collectedData.length > 0
      ? state.collectedData
      : generateMockFrames(100);

    const publishSharedAnalysis = (reportData: FootReport) => {
      const currentUser = state.currentUser ?? {
        id: 'mock-user',
        name: '测试用户',
        createdAt: new Date(),
      };
      setReportData(createSharedReportData(reportData, currentUser));
      setFootAnalysis(createFootAnalysis(reportData));
      setAnalysisStatus('ready');
    };

    async function runAnalysis() {
      // 尝试 Python 后端
      try {
        const available = await checkPythonBackend();
        if (available && !cancelled) {
          const result = await analyzePython(frames);
          if (!cancelled && result.success) {
            const reportData = convertPythonResult(result.data);
            setReport(reportData);
            setAnalysisSource('python');
            if (result.images) setPythonImages(result.images);
            if (result.data.arch_features) setArchFeatures(result.data.arch_features);
            if (result.data.left_cop_trajectory && result.data.right_cop_trajectory) {
              setCopTrajectories({ left: result.data.left_cop_trajectory, right: result.data.right_cop_trajectory });
            }
            publishSharedAnalysis(reportData);
            setIsLoading(false);
            console.log('[Report] 使用 Python 后端分析完成');
            return;
          }
        }
      } catch (err) {
        console.warn('[Report] Python 后端不可用，回退到前端计算:', err);
      }

      // 回退到前端 JS 计算
      if (!cancelled) {
        const reportData = generateFootReport(frames);
        setReport(reportData);
        setAnalysisSource('js');
        setIsLoading(false);
        if (reportData) {
          publishSharedAnalysis(reportData);
        } else {
          setAnalysisStatus('error');
        }
        console.log('[Report] 使用前端 JS 分析完成');
      }
    }

    runAnalysis();
    return () => { cancelled = true; };
  }, [setAnalysisStatus, setFootAnalysis, setReportData, state.collectedData, state.currentUser]);

  // 准备图表数据
  const chartData = useMemo(() => {
    if (!report) return null;

    // 总压力对比数据 — 按 前足/中足/后足 堆叠
    const pressureCompare = [
      {
        name: '左脚',
        forefoot: Math.round(report.left.regionPressure.forefoot.pressure),
        midfoot: Math.round(report.left.regionPressure.midfoot.pressure),
        hindfoot: Math.round(report.left.regionPressure.hindfoot.pressure),
        total: Math.round(report.left.footData.pressure),
      },
      {
        name: '右脚',
        forefoot: Math.round(report.right.regionPressure.forefoot.pressure),
        midfoot: Math.round(report.right.regionPressure.midfoot.pressure),
        hindfoot: Math.round(report.right.regionPressure.hindfoot.pressure),
        total: Math.round(report.right.footData.pressure),
      },
    ];

    // 接触面积对比数据 — 按 前足/中足/后足 堆叠
    const areaCompare = [
      {
        name: '左脚',
        forefoot: Math.round(report.left.regionPressure.forefoot.area * 10) / 10,
        midfoot: Math.round(report.left.regionPressure.midfoot.area * 10) / 10,
        hindfoot: Math.round(report.left.regionPressure.hindfoot.area * 10) / 10,
        total: Math.round(report.left.footData.area * 10) / 10,
      },
      {
        name: '右脚',
        forefoot: Math.round(report.right.regionPressure.forefoot.area * 10) / 10,
        midfoot: Math.round(report.right.regionPressure.midfoot.area * 10) / 10,
        hindfoot: Math.round(report.right.regionPressure.hindfoot.area * 10) / 10,
        total: Math.round(report.right.footData.area * 10) / 10,
      },
    ];

    // 左右脚压力占比
    const leftRightRatio = [
      { name: '左脚', value: Math.round(report.bilateral.leftPressureRatio), color: COLORS.primary },
      { name: '右脚', value: Math.round(report.bilateral.rightPressureRatio), color: COLORS.chart1 },
    ];

    // 区域压力分布（左脚）
    const leftRegionPressure = [
      { name: '前足', value: Math.round(report.left.regionPressure.forefoot.percent), color: COLORS.chart3 },
      { name: '中足', value: Math.round(report.left.regionPressure.midfoot.percent), color: COLORS.chart2 },
      { name: '后足', value: Math.round(report.left.regionPressure.hindfoot.percent), color: COLORS.primary },
    ];

    // 区域压力分布（右脚）
    const rightRegionPressure = [
      { name: '前足', value: Math.round(report.right.regionPressure.forefoot.percent), color: COLORS.chart3 },
      { name: '中足', value: Math.round(report.right.regionPressure.midfoot.percent), color: COLORS.chart2 },
      { name: '后足', value: Math.round(report.right.regionPressure.hindfoot.percent), color: COLORS.primary },
    ];

    return {
      pressureCompare,
      areaCompare,
      leftRightRatio,
      leftRegionPressure,
      rightRegionPressure,
    };
  }, [report]);

  // 全部采集帧的平均 ADC（4096 长度）。MLI 用此而非单帧 peak_frame_data，
  // 让指标反映整段采集的稳态分布，对采集中前后微小移动更稳健。
  const avgFrameData = useMemo<number[] | null>(() => {
    const frames = state.collectedData;
    if (!frames || frames.length === 0) return null;
    const acc = new Array(4096).fill(0);
    let n = 0;
    for (const f of frames) {
      if (!f || f.length !== 4096) continue;
      for (let i = 0; i < 4096; i++) acc[i] += f[i] || 0;
      n++;
    }
    if (n === 0) return null;
    for (let i = 0; i < 4096; i++) acc[i] /= n;
    return acc;
  }, [state.collectedData]);

  // 足弓内外翻评估（MLI）— 用「全部采集帧平均」作为 ADC 来源；
  // section/像素掩码优先 Python archFeatures，否则 JS footData.coords。
  // 若平均帧不可用，再回退到 peak 单帧或 JS matrix。
  const mli = useMemo(() => {
    if (!report) return { left: null as MliResult | null, right: null as MliResult | null };

    // 诊断输出：让你在控制台直接看到 MLI 输入的状态
    const leftSecLen = archFeatures
      ? (Object.values(archFeatures.left_foot.section_coords).flat() as number[][]).length
      : 0;
    const rightSecLen = archFeatures
      ? (Object.values(archFeatures.right_foot.section_coords).flat() as number[][]).length
      : 0;
    // eslint-disable-next-line no-console
    console.info('[MLI debug]', {
      hasArchFeatures: !!archFeatures,
      hasAvgFrame: !!avgFrameData,
      collectedFrames: state.collectedData.length,
      leftSectionPixels: leftSecLen,
      rightSectionPixels: rightSecLen,
      leftJsCoords: report.left.footData.coords.length,
      rightJsCoords: report.right.footData.coords.length,
    });

    const makeGetter = (arr: number[]) => (r: number, c: number) =>
      (r >= 0 && r < 64 && c >= 0 && c < 64) ? (arr[r * 64 + c] || 0) : 0;

    // 最优先：使用 Python 的"平均帧"（archFeatures.peak_frame_data 字段名虽然是 peak，
    // 但在多帧模式下装的是 Python 平均帧，过滤掉了空帧再做平均）+ section_coords。
    // 这两份数据完全同源，不会有"section_coords 包含的像素在 ADC 帧上 = 0"的问题。
    if (archFeatures && archFeatures.peak_frame_data?.length === 4096) {
      const getAdc = makeGetter(archFeatures.peak_frame_data);
      const leftPixels = Object.values(archFeatures.left_foot.section_coords).flat() as number[][];
      const rightPixels = Object.values(archFeatures.right_foot.section_coords).flat() as number[][];
      return {
        left: calculateMLI(leftPixels, getAdc, 'left'),
        right: calculateMLI(rightPixels, getAdc, 'right'),
      };
    }

    // 次选：前端 avgFrame + Python section_coords（Python 没返 peak_frame_data 时）
    if (avgFrameData && archFeatures) {
      const getAdc = makeGetter(avgFrameData);
      const leftPixels = Object.values(archFeatures.left_foot.section_coords).flat() as number[][];
      const rightPixels = Object.values(archFeatures.right_foot.section_coords).flat() as number[][];
      return {
        left: calculateMLI(leftPixels, getAdc, 'left'),
        right: calculateMLI(rightPixels, getAdc, 'right'),
      };
    }

    // 次选：前端 avgFrame + JS coords（Python 后端整体不可用时）
    if (avgFrameData) {
      const getAdc = makeGetter(avgFrameData);
      return {
        left: calculateMLI(report.left.footData.coords, getAdc, 'left'),
        right: calculateMLI(report.right.footData.coords, getAdc, 'right'),
      };
    }

    // 最终回退：JS matrix
    const leftMatrix = report.left.footData.matrix;
    const rightMatrix = report.right.footData.matrix;
    const leftGetAdc = (r: number, c: number) => (leftMatrix[r]?.[c] ?? 0);
    const rightGetAdc = (r: number, c: number) => (rightMatrix[r]?.[c] ?? 0);
    return {
      left: calculateMLI(report.left.footData.coords, leftGetAdc, 'left'),
      right: calculateMLI(report.right.footData.coords, rightGetAdc, 'right'),
    };
  }, [report, archFeatures, avgFrameData]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-muted-foreground">正在生成分析报告...</p>
        </div>
      </div>
    );
  }

  if (!report || !chartData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">无法生成报告，请重新采集数据</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6 overflow-y-auto">
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleCsvFileChange}
        className="hidden"
      />

      {/* 页面标题 */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">分析报告</h1>
            <p className="text-muted-foreground">
              基于OneStep SDK的足底压力数据分析
              {analysisSource === 'python' && (
                <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                  Python
                </span>
              )}
              {analysisSource === 'js' && (
                <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                  JS
                </span>
              )}
              {importedCsvName && (
                <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                  已导入 {importedCsvName}
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleImportCsvClick}
              disabled={isImportingCsv}
              className="gap-2"
            >
              {isImportingCsv ? (
                <>
                  <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  导入中...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  导入 CSV
                </>
              )}
            </Button>
            <Button onClick={onNext} className="group" disabled={isLoading || isImportingCsv || state.analysisStatus === 'pending'}>
              查看解决方案
              <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </Button>
          </div>
        </div>
      </motion.div>

      {/* 用户信息 */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="medical-card mb-6"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <User className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-lg">{state.currentUser?.name || '测试用户'}</h2>
            <p className="text-sm text-muted-foreground">
              采集时间：{new Date().toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">采集帧数</p>
            <p className="text-2xl font-bold text-primary">
              {state.collectedData.length > 0 ? state.collectedData.length : 100}
            </p>
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-12 gap-6">
        {/* 足弓分析 - 移除Clarke角和Staheli指数 */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.2 }}
          className="col-span-6"
        >
          <div className="medical-card h-full">
            <h2 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <Target className="w-5 h-5 text-primary" />
              足弓分析
            </h2>

            <div className="grid grid-cols-2 gap-4">
              {/* 左脚 */}
              <div className="bg-primary/5 rounded-xl p-4">
                <h3 className="font-medium text-primary mb-3 text-center">左脚</h3>
                <div className="space-y-3">
                  <div>
                    <span className="text-xs text-muted-foreground">足弓类型</span>
                    <ArchTypeIndicator
                      type={report.left.archAnalysis.archType}
                      value={report.left.archAnalysis.archIndex}
                    />
                  </div>
                  <MliIndicator label="足弓内外翻" result={mli.left} />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">足弓指数(AI)</span>
                    <span className="font-mono font-medium">
                      {report.left.archAnalysis.archIndex.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">内/外侧负荷比(MLI)</span>
                    <span className="font-mono font-medium">
                      {mli.left ? mli.left.mli.toFixed(2) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">足长</span>
                    <span className="font-mono font-medium">{report.left.length.toFixed(1)} cm</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">足宽</span>
                    <span className="font-mono font-medium">{report.left.width.toFixed(1)} cm</span>
                  </div>
                </div>
              </div>

              {/* 右脚 */}
              <div className="bg-[var(--health-green-light)] rounded-xl p-4">
                <h3 className="font-medium text-[var(--health-green)] mb-3 text-center">右脚</h3>
                <div className="space-y-3">
                  <div>
                    <span className="text-xs text-muted-foreground">足弓类型</span>
                    <ArchTypeIndicator
                      type={report.right.archAnalysis.archType}
                      value={report.right.archAnalysis.archIndex}
                    />
                  </div>
                  <MliIndicator label="足弓内外翻" result={mli.right} />
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">足弓指数(AI)</span>
                    <span className="font-mono font-medium">
                      {report.right.archAnalysis.archIndex.toFixed(3)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">内/外侧负荷比(MLI)</span>
                    <span className="font-mono font-medium">
                      {mli.right ? mli.right.mli.toFixed(2) : '—'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">足长</span>
                    <span className="font-mono font-medium">{report.right.length.toFixed(1)} cm</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">足宽</span>
                    <span className="font-mono font-medium">{report.right.width.toFixed(1)} cm</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 指标说明 */}
            <div className="mt-4 p-3 bg-muted/30 rounded-lg space-y-1.5">
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">足弓指数(AI)</span> = 中足面积 / 总面积。&lt;0.20 为高足弓，0.21-0.26 为正常，&gt;0.27 为扁平足。
                </p>
              </div>
              <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium">足弓内外翻(MLI)</span> = 内侧 ADC 总和 / 外侧 ADC 总和。&lt;0.9 为有足内翻风险（高弓足倾向），0.9-1.1 为内外侧负荷均衡，&gt;1.1 为有足外翻风险（扁平足倾向）。
                </p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 总压力对比 - 单独图表 */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3 }}
          className="col-span-3"
        >
          <div className="medical-card h-full flex flex-col">
            <h2 className="font-semibold text-lg mb-3 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              总压力对比
            </h2>
            <div className="flex-1 min-h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData.pressureCompare} barGap={8} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} iconSize={10} />
                  <Bar dataKey="forefoot" name="前足" stackId="p" fill={COLORS.chart3} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="midfoot" name="中足" stackId="p" fill={COLORS.chart2} />
                  <Bar dataKey="hindfoot" name="后足" stackId="p" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs border-t border-border pt-3">
              <div className="text-center">
                <div className="text-muted-foreground">左脚总压力</div>
                <div className="font-mono font-medium text-sm">{chartData.pressureCompare[0].total}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">右脚总压力</div>
                <div className="font-mono font-medium text-sm">{chartData.pressureCompare[1].total}</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">左右压力比</div>
                <div className="font-mono font-medium text-sm">
                  {Math.round(report.bilateral.leftPressureRatio)}% : {Math.round(report.bilateral.rightPressureRatio)}%
                </div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">左右差异</div>
                <div className="font-mono font-medium text-sm">
                  {Math.abs(Math.round(report.bilateral.leftPressureRatio - report.bilateral.rightPressureRatio))}%
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 接触面积对比 - 单独图表 */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.35 }}
          className="col-span-3"
        >
          <div className="medical-card h-full flex flex-col">
            <h2 className="font-semibold text-lg mb-3 flex items-center gap-2">
              <Ruler className="w-5 h-5 text-primary" />
              接触面积
            </h2>
            <div className="flex-1 min-h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData.areaCompare} barGap={8} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 10 }} unit=" cm²" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                    formatter={(value: number) => [`${value} cm²`, '']}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} iconSize={10} />
                  <Bar dataKey="forefoot" name="前足" stackId="a" fill={COLORS.chart3} />
                  <Bar dataKey="midfoot" name="中足" stackId="a" fill={COLORS.chart2} />
                  <Bar dataKey="hindfoot" name="后足" stackId="a" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs border-t border-border pt-3">
              <div className="text-center">
                <div className="text-muted-foreground">左脚面积</div>
                <div className="font-mono font-medium text-sm">{chartData.areaCompare[0].total} cm²</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">右脚面积</div>
                <div className="font-mono font-medium text-sm">{chartData.areaCompare[1].total} cm²</div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">总面积</div>
                <div className="font-mono font-medium text-sm">
                  {(report.left.footData.area + report.right.footData.area).toFixed(1)} cm²
                </div>
              </div>
              <div className="text-center">
                <div className="text-muted-foreground">左右差异</div>
                <div className="font-mono font-medium text-sm">
                  {Math.abs(report.left.footData.area - report.right.footData.area).toFixed(1)} cm²
                </div>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 区域压力分布 - 左脚 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="col-span-4"
        >
          <div className="medical-card h-full">
            <h2 className="font-semibold text-lg mb-4">左脚区域压力</h2>
            <div className="h-48 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData.leftRegionPressure}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={60}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}%`}
                    labelLine={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                  >
                    {chartData.leftRegionPressure.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div className="text-center">
                <p className="font-medium">{report.left.regionPressure.forefoot.area.toFixed(1)} cm²</p>
                <p className="text-muted-foreground">前足面积</p>
              </div>
              <div className="text-center">
                <p className="font-medium">{report.left.regionPressure.midfoot.area.toFixed(1)} cm²</p>
                <p className="text-muted-foreground">中足面积</p>
              </div>
              <div className="text-center">
                <p className="font-medium">{report.left.regionPressure.hindfoot.area.toFixed(1)} cm²</p>
                <p className="text-muted-foreground">后足面积</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 区域压力分布 - 右脚 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45 }}
          className="col-span-4"
        >
          <div className="medical-card h-full">
            <h2 className="font-semibold text-lg mb-4">右脚区域压力</h2>
            <div className="h-48 flex items-center justify-center">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData.rightRegionPressure}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={60}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}%`}
                    labelLine={{ stroke: 'var(--muted-foreground)', strokeWidth: 1 }}
                  >
                    {chartData.rightRegionPressure.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div className="text-center">
                <p className="font-medium">{report.right.regionPressure.forefoot.area.toFixed(1)} cm²</p>
                <p className="text-muted-foreground">前足面积</p>
              </div>
              <div className="text-center">
                <p className="font-medium">{report.right.regionPressure.midfoot.area.toFixed(1)} cm²</p>
                <p className="text-muted-foreground">中足面积</p>
              </div>
              <div className="text-center">
                <p className="font-medium">{report.right.regionPressure.hindfoot.area.toFixed(1)} cm²</p>
                <p className="text-muted-foreground">后足面积</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* COP指标 - 与左边两个框下边界对齐 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="col-span-4"
        >
          <div className="medical-card h-full flex flex-col">
            <h2 className="font-semibold text-lg mb-4 flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              COP平衡指标
            </h2>
            {report.bilateral.copMetrics ? (
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心轨迹长度</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.pathLength.toFixed(2)} mm
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心活动总面积</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.contactArea.toFixed(2)} mm²
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心最大摆幅</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.majorAxis.toFixed(2)} mm
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心稳定摆幅</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.minorAxis.toFixed(2)} mm
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心最大离心</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.maxDisplacement.toFixed(2)} mm
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心偏移平均速度</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.avgVelocity.toFixed(2)} mm/s
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心前后方向标准差</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.stdX.toFixed(2)} mm
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">压力中心左右方向标准差</span>
                  <span className="font-mono font-medium">
                    {report.bilateral.copMetrics.stdY.toFixed(2)} mm
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">数据不足，无法计算COP指标</p>
            )}
          </div>
        </motion.div>

        {/* 足弓区域分布图 / 压力热力图 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55 }}
          className="col-span-6"
        >
          <div className="medical-card h-full">
            <h2 className="font-semibold text-lg mb-4">
              {archFeatures ? '足弓区域分布图' : pythonImages?.arch_regions ? '足弓区域分布图' : '双足压力热力图'}
            </h2>
            {archFeatures ? (
              <InteractiveArchChart archFeatures={archFeatures} />
            ) : pythonImages?.arch_regions ? (
              <div className="flex items-center justify-center">
                <img
                  src={pythonImages.arch_regions}
                  alt="足弓区域分布图"
                  style={{ width: '100%', objectFit: 'contain' }}
                  className="rounded-lg"
                />
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <div className="flex items-center justify-center gap-8 min-w-[520px]">
                    <PressureHeatmap matrix={report.left.footData.matrix} title="左脚" />
                    <PressureHeatmap matrix={report.right.footData.matrix} title="右脚" />
                  </div>
                </div>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <span className="text-xs text-muted-foreground">低压</span>
                  <div className="w-32 h-3 rounded" style={{
                    background: 'linear-gradient(to right, #00f, #0ff, #0f0, #ff0, #f00)'
                  }} />
                  <span className="text-xs text-muted-foreground">高压</span>
                </div>
              </>
            )}
          </div>
        </motion.div>

        {/* COP轨迹图 - 优先使用 Python 生成的图片 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
          className="col-span-6"
        >
          <div className="medical-card h-full">
            <h2 className="font-semibold text-lg mb-4">COP压力中心轨迹</h2>
            {copTrajectories ? (
              <InteractiveCOPChart
                leftCopRaw={copTrajectories.left}
                rightCopRaw={copTrajectories.right}
                peakFrameData={archFeatures?.peak_frame_data}
                leftSectionCoords={archFeatures ? Object.values(archFeatures.left_foot.section_coords) : undefined}
                rightSectionCoords={archFeatures ? Object.values(archFeatures.right_foot.section_coords) : undefined}
              />
            ) : pythonImages?.cop_trajectory ? (
              <div className="flex items-center justify-center">
                <img
                  src={pythonImages.cop_trajectory}
                  alt="COP压力中心轨迹"
                  style={{ width: '100%', objectFit: 'contain' }}
                  className="rounded-lg"
                />
              </div>
            ) : (report.bilateral.leftCopTrajectory?.length > 0 || report.bilateral.rightCopTrajectory?.length > 0) ? (
              <div className="overflow-x-auto">
                <div className="min-w-[600px]">
                  <DualFootCOPChart
                    leftTrajectory={report.bilateral.leftCopTrajectory || []}
                    rightTrajectory={report.bilateral.rightCopTrajectory || []}
                  />
                </div>
              </div>
            ) : (
              <div className="h-64 flex items-center justify-center">
                <p className="text-muted-foreground">无轨迹数据</p>
              </div>
            )}
          </div>
        </motion.div>

        {/* 分析总结 */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.65 }}
          className="col-span-12"
        >
          <div className="medical-card bg-gradient-to-r from-primary/5 to-transparent">
            <h2 className="font-semibold text-lg mb-4">分析总结</h2>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <h3 className="font-medium text-primary mb-2">足弓评估</h3>
                <p className="text-sm text-muted-foreground">
                  左脚：{report.left.archAnalysis.archType}
                  （AI={report.left.archAnalysis.archIndex.toFixed(3)}）
                </p>
                <p className="text-sm text-muted-foreground">
                  右脚：{report.right.archAnalysis.archType}
                  （AI={report.right.archAnalysis.archIndex.toFixed(3)}）
                </p>
              </div>
              <div>
                <h3 className="font-medium text-primary mb-2">压力分布</h3>
                <p className="text-sm text-muted-foreground">
                  左右脚压力比：{Math.round(report.bilateral.leftPressureRatio)}% : {Math.round(report.bilateral.rightPressureRatio)}%
                </p>
                <p className="text-sm text-muted-foreground">
                  {Math.abs(report.bilateral.leftPressureRatio - 50) < 10 
                    ? '压力分布较为均衡' 
                    : `${report.bilateral.leftPressureRatio > 50 ? '左脚' : '右脚'}承重偏多`}
                </p>
              </div>
              <div>
                <h3 className="font-medium text-primary mb-2">平衡稳定性</h3>
                {report.bilateral.copMetrics ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      COP轨迹长度：{report.bilateral.copMetrics.pathLength.toFixed(1)} mm
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {report.bilateral.copMetrics.pathLength < 500 
                        ? '平衡控制良好' 
                        : report.bilateral.copMetrics.pathLength < 1000 
                          ? '平衡控制一般' 
                          : '建议加强平衡训练'}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">数据不足</p>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
