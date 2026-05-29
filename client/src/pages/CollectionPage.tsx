/**
 * 数据采集页面
 * 设计风格：医疗科技极简主义
 * - 真实3D足底压力可视化
 * - 串口连接传感器
 * - CSV文件导入功能
 * - 采集控制面板
 * - 倒计时显示
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '@/contexts/AppContext';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Play,
  Square,
  RotateCcw,
  Save,
  ArrowRight,
  Footprints,
  Plug,
  PlugZap,
  Upload,
  Box,
  Grid3x3,
  Sparkles,
  Check,
  Settings,
  Activity,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Scene } from '@/components/Scene';
import Pressure2DHeatmap from '@/components/Pressure2DHeatmap';
import PressurePointCloud3D from '@/components/PressurePointCloud3D';
import { DebugPanel } from '@/components/DebugPanel';
import { serialService, type BaudRate } from '@/lib/SerialService';

interface CollectionPageProps {
  onNext: () => void;
}

type CollectionMode = 'static' | 'dynamic';
type CollectionStatus = 'idle' | 'countdown' | 'collecting' | 'completed';

// CSV解析函数 - 与Python代码保持一致
function parseCSVData(csvText: string): number[][] {
  const lines = csvText.trim().split('\n');
  const frames: number[][] = [];
  
  // 查找data列的索引
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const dataIndex = headers.findIndex(h => h === 'data');
  
  if (dataIndex === -1) {
    throw new Error('CSV文件缺少 "data" 列');
  }
  
  for (let i = 1; i < lines.length; i++) {
    try {
      const line = lines[i];
      // 处理CSV中可能包含的引号和方括号
      const match = line.match(/\[([^\]]+)\]/);
      if (match) {
        const values = match[1].split(',').map(v => parseFloat(v.trim()));
        if (values.length === 4096) {
          frames.push(values);
        } else {
          console.warn(`第${i}行数据长度不为4096，跳过`);
        }
      }
    } catch (e) {
      console.warn(`第${i}行解析失败，跳过`);
    }
  }
  
  return frames;
}

// 连通域标记算法 (4连通)
function labelConnectedComponents(mask: boolean[][]): { labels: number[][]; numLabels: number } {
  const rows = mask.length;
  const cols = mask[0].length;
  const labels: number[][] = Array(rows).fill(null).map(() => Array(cols).fill(0));
  let currentLabel = 0;

  function dfs(r: number, c: number, label: number): void {
    const stack: [number, number][] = [[r, c]];
    while (stack.length > 0) {
      const [cr, cc] = stack.pop()!;
      if (cr < 0 || cr >= rows || cc < 0 || cc >= cols) continue;
      if (!mask[cr][cc] || labels[cr][cc] !== 0) continue;
      
      labels[cr][cc] = label;
      stack.push([cr - 1, cc], [cr + 1, cc], [cr, cc - 1], [cr, cc + 1]);
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

// 移除小连通域（去噪）- 与Python代码 _remove_small_components 一致
function removeSmallComponents(matrix: number[][], minSize: number = 3): number[][] {
  const rows = matrix.length;
  const cols = matrix[0].length;
  
  // 创建二值掩码 (阈值 > 2)
  const mask: boolean[][] = matrix.map(row => row.map(val => val > 2));
  
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

// 数据预处理函数 - 与Python Comprehensive_Indicators代码保持一致
function preprocessFrame(data: number[]): number[][] {
  // 重构为64x64矩阵
  const matrix: number[][] = [];
  for (let i = 0; i < 64; i++) {
    matrix.push(data.slice(i * 64, (i + 1) * 64));
  }

  // 1) 逆时针旋转90度
  const rotated: number[][] = Array(64).fill(null).map(() => Array(64).fill(0));
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 64; j++) {
      rotated[63 - j][i] = matrix[i][j];
    }
  }

  // 2) 水平镜像
  const mirrored = rotated.map(row => [...row].reverse());

  // 3) 垂直镜像（与Python mirrored_vertical=True 一致）
  const flipped = mirrored.reverse();

  // 4) 去噪：压力值<=4的置0（与Python apply_denoise: mat[mat <= 4] = 0 一致）
  for (let i = 0; i < flipped.length; i++) {
    for (let j = 0; j < flipped[i].length; j++) {
      if (flipped[i][j] <= 4) {
        flipped[i][j] = 0;
      }
    }
  }

  // 5) 使用连通域分析去噪（与Python代码一致）
  const denoised = removeSmallComponents(flipped, 3);

  return denoised;
}

export default function CollectionPage({ onNext }: CollectionPageProps) {
  const { state, startCollection, stopCollection, setCollectionProgress, addCollectedFrame, clearCollectedData } = useApp();
  const [status, setStatus] = useState<CollectionStatus>('idle');
  const [mode, setMode] = useState<CollectionMode>('static');
  const [duration, setDuration] = useState('10');
  const [countdown, setCountdown] = useState(3);
  const [progress, setProgress] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);
  
  // 视图模式：3D 酷炫视图 / 2D 数值热力图 / 点云视图
  const [viewMode, setViewMode] = useState<'3d' | '2d' | 'pointcloud'>('2d');
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [isVizFullscreen, setIsVizFullscreen] = useState(false);
  // 可视化区域高度（可垂直拖动调整）
  const [vizHeight, setVizHeight] = useState(420);
  const [isResizingViz, setIsResizingViz] = useState(false);

  const startVizResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = vizHeight;
    setIsResizingViz(true);
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(280, Math.min(1200, startHeight + (ev.clientY - startY)));
      setVizHeight(next);
    };
    const onUp = () => {
      setIsResizingViz(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // 串口连接状态
  const [isConnected, setIsConnected] = useState(false);
  const [realtimeData, setRealtimeData] = useState<number[][] | null>(null);
  const [enableMirroring, setEnableMirroring] = useState(true);
  const [baudRate, setBaudRate] = useState<BaudRate>(serialService.getBaudRate());
  
  // 采集的数据帧
  const [collectedFrames, setCollectedFrames] = useState<number[][][]>([]);
  
  // CSV导入相关
  const fileInputRef = useRef<HTMLInputElement>(null);
  const vizStageRef = useRef<HTMLDivElement>(null);
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  
  // 倒计时定时器引用
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const collectingTimerRef = useRef<NodeJS.Timeout | null>(null);

  const totalDuration = parseInt(duration);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsVizFullscreen(document.fullscreenElement === vizStageRef.current);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleVizFullscreen = useCallback(async () => {
    const target = vizStageRef.current;
    if (!target) return;

    if (document.fullscreenElement === target) {
      await document.exitFullscreen();
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
    await target.requestFullscreen();
  }, []);

  // 初始化串口服务
  useEffect(() => {
    serialService.setOnData((data) => {
      setRealtimeData(data);
      
      // 如果正在采集，保存数据帧
      if (status === 'collecting') {
        setCollectedFrames(prev => [...prev, data]);
        // 将数据展平为1D数组并保存到AppContext
        const flatData = data.flat();
        addCollectedFrame(flatData);
      }
    });
    
    serialService.setMirroring(enableMirroring);
    
    return () => {
      // 保持连接
    };
  }, [status, addCollectedFrame, enableMirroring]);

  // 更新镜像设置
  useEffect(() => {
    serialService.setMirroring(enableMirroring);
  }, [enableMirroring]);

  // 处理连接/断开
  const handleConnect = async () => {
    if (isConnected) {
      await serialService.disconnect();
      setIsConnected(false);
      setRealtimeData(null);
    } else {
      const success = await serialService.connect();
      if (success) {
        setIsConnected(true);
      }
    }
  };

  // 倒计时逻辑 - 修复版
  useEffect(() => {
    // 清除之前的定时器
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    
    if (status === 'countdown') {
      if (countdown > 0) {
        console.log(`[Countdown] ${countdown}...`);
        countdownTimerRef.current = setTimeout(() => {
          setCountdown(prev => prev - 1);
        }, 1000);
      } else {
        // 倒计时结束，开始采集
        console.log('[Countdown] 开始采集!');
        setStatus('collecting');
        setCollectedFrames([]);
        setElapsedTime(0);
        setProgress(0);
        startCollection();
      }
    }
    
    return () => {
      if (countdownTimerRef.current) {
        clearTimeout(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }
    };
  }, [status, countdown, startCollection]);

  // 采集进度逻辑 - 修复版
  useEffect(() => {
    // 清除之前的定时器
    if (collectingTimerRef.current) {
      clearInterval(collectingTimerRef.current);
      collectingTimerRef.current = null;
    }
    
    if (status === 'collecting') {
      collectingTimerRef.current = setInterval(() => {
        setElapsedTime((prev) => {
          const newTime = prev + 0.1;
          const newProgress = Math.min((newTime / totalDuration) * 100, 100);
          setProgress(newProgress);
          setCollectionProgress(newProgress);

          if (newTime >= totalDuration) {
            console.log('[Collection] 采集完成!');
            setStatus('completed');
            stopCollection();
            if (collectingTimerRef.current) {
              clearInterval(collectingTimerRef.current);
              collectingTimerRef.current = null;
            }
            return totalDuration;
          }
          return newTime;
        });
      }, 100);
    }

    return () => {
      if (collectingTimerRef.current) {
        clearInterval(collectingTimerRef.current);
        collectingTimerRef.current = null;
      }
    };
  }, [status, totalDuration, setCollectionProgress, stopCollection]);

  const handleStart = useCallback(() => {
    console.log('[Collection] 开始倒计时...');
    clearCollectedData();
    setCollectedFrames([]);
    setProgress(0);
    setElapsedTime(0);
    setCountdown(3);
    // 先设置countdown，再设置status，确保useEffect能正确触发
    setTimeout(() => {
      setStatus('countdown');
    }, 0);
  }, [clearCollectedData]);

  const handleStop = useCallback(() => {
    console.log('[Collection] 停止采集');
    // 清除所有定时器
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (collectingTimerRef.current) {
      clearInterval(collectingTimerRef.current);
      collectingTimerRef.current = null;
    }
    setStatus('idle');
    stopCollection();
    setProgress(0);
    setElapsedTime(0);
  }, [stopCollection]);

  const handleReset = useCallback(() => {
    // 清除所有定时器
    if (countdownTimerRef.current) {
      clearTimeout(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (collectingTimerRef.current) {
      clearInterval(collectingTimerRef.current);
      collectingTimerRef.current = null;
    }
    setStatus('idle');
    setProgress(0);
    setElapsedTime(0);
    setCountdown(3);
    setCollectedFrames([]);
    setImportedFileName(null);
  }, []);

  const handleSaveAndNext = useCallback(() => {
    onNext();
  }, [onNext]);
  
  // CSV文件导入处理
  const handleImportCSV = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  
  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    setIsImporting(true);
    setImportedFileName(file.name);
    
    try {
      const text = await file.text();
      console.log('[CSV Import] 开始解析文件:', file.name);
      
      const frames = parseCSVData(text);
      console.log(`[CSV Import] 成功解析 ${frames.length} 帧数据`);
      
      if (frames.length === 0) {
        throw new Error('未能解析到有效数据');
      }
      
      // 清除之前的数据
      clearCollectedData();
      setCollectedFrames([]);
      
      // 预处理并保存数据
      const processedFrames: number[][][] = [];
      for (const frame of frames) {
        const processed = preprocessFrame(frame);
        processedFrames.push(processed);
        addCollectedFrame(frame); // 保存原始数据到AppContext
      }
      
      setCollectedFrames(processedFrames);
      setStatus('completed');
      
      // 显示最后一帧作为预览
      if (processedFrames.length > 0) {
        setRealtimeData(processedFrames[processedFrames.length - 1]);
      }
      
      console.log(`[CSV Import] 导入完成，共 ${frames.length} 帧`);
      
    } catch (error) {
      console.error('[CSV Import] 导入失败:', error);
      alert(`CSV导入失败: ${error instanceof Error ? error.message : '未知错误'}`);
      setImportedFileName(null);
    } finally {
      setIsImporting(false);
      // 重置文件输入
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [clearCollectedData, addCollectedFrame]);

  // 计算实时数据指标（用于左侧面板显示）
  const liveStats = (() => {
    if (!realtimeData) return { max: 0, active: 0, total: 0 };
    let max = 0; let active = 0; let total = 0;
    for (const row of realtimeData) {
      for (const v of row) {
        if (v > 0) { active++; total += v; if (v > max) max = v; }
      }
    }
    return { max, active, total };
  })();

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const dataSource = isConnected ? '实时' : importedFileName ? 'CSV' : '演示';
  const sourceColor = isConnected ? 'bg-green-500' : importedFileName ? 'bg-blue-500' : 'bg-gray-400';

  return (
    <div className="h-screen flex flex-col p-4 gap-3 overflow-hidden">
      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* 顶部头部：标题 + 全局控件 */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between gap-4 shrink-0"
      >
        <div>
          <h1 className="text-xl font-bold text-foreground">数据采集</h1>
          <p className="text-xs text-muted-foreground">请按照指引完成足底压力数据采集，或导入 CSV 文件进行分析</p>
        </div>
        <div className="flex items-center gap-2">
          {/* CSV 导入 */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleImportCSV}
            disabled={isImporting || status === 'collecting' || status === 'countdown'}
            className="gap-2"
          >
            {isImporting ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                导入中...
              </>
            ) : (
              <>
                <Upload className="w-3.5 h-3.5" />
                导入 CSV
              </>
            )}
          </Button>

          {/* 波特率（断开时） */}
          {!isConnected && (
            <div className="flex items-center gap-1 bg-secondary/50 rounded-md px-1.5 py-1">
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">波特率</span>
              <button
                onClick={() => { setBaudRate(3000000 as BaudRate); serialService.setBaudRate(3000000); }}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  serialService.getBaudRate() === 3000000
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-secondary'
                }`}
              >3M</button>
              <button
                onClick={() => { setBaudRate(6000000 as BaudRate); serialService.setBaudRate(6000000); }}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition-colors ${
                  serialService.getBaudRate() === 6000000
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-secondary'
                }`}
              >6M</button>
            </div>
          )}
          {isConnected && (
            <span className="text-[10px] text-muted-foreground font-mono bg-secondary/50 px-2 py-1 rounded">
              {serialService.getBaudRate() / 1000000}M baud
            </span>
          )}

          {/* 设备连接 */}
          <Button
            variant={isConnected ? 'destructive' : 'default'}
            size="sm"
            onClick={handleConnect}
            className="gap-2"
          >
            {isConnected ? (
              <><PlugZap className="w-3.5 h-3.5" />断开设备</>
            ) : (
              <><Plug className="w-3.5 h-3.5" />连接设备</>
            )}
          </Button>
        </div>
      </motion.div>

      {/* 主体两列布局 */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* 左侧侧边栏 320px */}
        <motion.div
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="w-[320px] shrink-0 flex flex-col gap-3 overflow-y-auto pr-1"
        >
          {/* 状态卡片：仅在 countdown / collecting / completed 时显示 */}
          <AnimatePresence mode="wait">
            {(status === 'countdown' || status === 'collecting') && (
              <motion.div
                key="status-active"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="medical-card !p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${status === 'collecting' ? 'bg-red-500' : 'bg-amber-500'} animate-pulse`} />
                    <span className="text-xs font-semibold">
                      {status === 'collecting' ? '采集中' : '准备中'}
                    </span>
                  </div>
                  <span className="font-mono text-base text-primary">
                    {status === 'collecting' ? formatTime(elapsedTime) : `${countdown}s`}
                  </span>
                </div>
                <Progress value={progress} className="h-1.5" />
                <div className="text-[10px] text-muted-foreground mt-1.5 flex justify-between">
                  <span>已采集 {collectedFrames.length} 帧</span>
                  <span>{progress.toFixed(0)}% / {totalDuration}s</span>
                </div>
              </motion.div>
            )}
            {status === 'completed' && (
              <motion.div
                key="status-done"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="medical-card !p-3"
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="w-5 h-5 rounded-full bg-[var(--health-green-light)] text-[var(--health-green)] flex items-center justify-center">
                    <Check className="w-3.5 h-3.5" />
                  </span>
                  <span className="text-xs font-semibold text-[var(--health-green)]">
                    {importedFileName ? 'CSV 导入完成' : '采集完成'}
                  </span>
                </div>
                <p className="text-lg font-mono font-semibold">{state.collectedData.length} <span className="text-xs text-muted-foreground font-normal">帧</span></p>
                {importedFileName && (
                  <p className="text-[10px] text-blue-500 mt-1 truncate" title={importedFileName}>{importedFileName}</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 实时数据指标 — 单行竖排 */}
          <div className="medical-card !p-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Activity className="w-3 h-3 text-primary" />
              实时数据
            </h3>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between bg-secondary/30 rounded-md px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">最大 ADC</span>
                <span className="text-sm font-mono font-semibold text-rose-600">{liveStats.max || '--'}</span>
              </div>
              <div className="flex items-center justify-between bg-secondary/30 rounded-md px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">活动点</span>
                <span className="text-sm font-mono font-semibold text-primary">{liveStats.active || '--'}</span>
              </div>
              <div className="flex items-center justify-between bg-secondary/30 rounded-md px-2.5 py-1.5">
                <span className="text-xs text-muted-foreground">总压</span>
                <span className="text-sm font-mono font-semibold text-[var(--health-green)]">{liveStats.total || '--'}</span>
              </div>
            </div>
          </div>

          {/* 采集设置 — 单行竖排 */}
          <div className="medical-card !p-3">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Settings className="w-3 h-3 text-primary" />
              采集设置
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground shrink-0">采集方式</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as CollectionMode)}>
                  <SelectTrigger className="h-8 text-xs w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="static">静态采集</SelectItem>
                    <SelectItem value="dynamic">动态采集</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs text-muted-foreground shrink-0">采集时长</Label>
                <Select value={duration} onValueChange={setDuration}>
                  <SelectTrigger className="h-8 text-xs w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 秒</SelectItem>
                    <SelectItem value="10">10 秒</SelectItem>
                    <SelectItem value="15">15 秒</SelectItem>
                    <SelectItem value="30">30 秒</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* 操作步骤 */}
          <div className="medical-card !p-3 flex-1 min-h-0">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
              <Footprints className="w-3 h-3 text-primary" />
              操作步骤
            </h3>
            <ol className="space-y-2 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] flex items-center justify-center flex-shrink-0 font-medium mt-0.5">1</span>
                <span>连接传感器设备或导入 CSV 文件</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] flex items-center justify-center flex-shrink-0 font-medium mt-0.5">2</span>
                <span>用户站立在压力采集垫上</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] flex items-center justify-center flex-shrink-0 font-medium mt-0.5">3</span>
                <span>点击「开始采集」并保持姿势</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="w-4 h-4 rounded-full bg-primary/10 text-primary text-[10px] flex items-center justify-center flex-shrink-0 font-medium mt-0.5">4</span>
                <span>采集完成后保存数据并继续</span>
              </li>
            </ol>
          </div>
        </motion.div>

        {/* 右侧主舞台 */}
        <motion.div
          ref={vizStageRef}
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.15 }}
          className="flex-1 medical-card !p-0 relative overflow-hidden min-w-0 bg-background [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
        >
          {/* 热力图 / 3D 场景 / 点云 填满 */}
          {viewMode === '3d' ? (
            <div className="absolute inset-0 bg-gradient-to-b from-gray-50 to-gray-200 dark:from-gray-900 dark:to-gray-800">
              <Scene
                showHeatmap={showHeatmap}
                enableClipping={false}
                clipLevel={0.5}
                depthScale={0.25}
                smoothness={0.5}
                realtimeData={realtimeData}
              />
            </div>
          ) : viewMode === 'pointcloud' ? (
            <div className="absolute inset-0">
              <PressurePointCloud3D realtimeData={realtimeData} />
            </div>
          ) : (
            <Pressure2DHeatmap realtimeData={realtimeData} />
          )}

          {/* 顶部左浮动：3D / 2D / 点云 切换 */}
          <div
            className="absolute left-3 z-20 inline-flex bg-white/85 dark:bg-slate-900/85 backdrop-blur rounded-full p-0.5 shadow-md border border-white/60"
            style={{ top: viewMode === '2d' ? 48 : 12 }}
          >
            <button
              onClick={() => setViewMode('3d')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === '3d'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Box className="w-3 h-3" />3D
            </button>
            <button
              onClick={() => setViewMode('2d')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === '2d'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Grid3x3 className="w-3 h-3" />2D
            </button>
            <button
              onClick={() => setViewMode('pointcloud')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                viewMode === 'pointcloud'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Sparkles className="w-3 h-3" />点云
            </button>
          </div>

          {/* 顶部右浮动：数据来源徽章 */}
          <div
            className="absolute right-3 z-20 flex items-center gap-1.5 bg-white/85 dark:bg-slate-900/85 backdrop-blur px-3 py-1.5 rounded-full shadow-md border border-white/60"
            style={{ top: viewMode === '2d' ? 48 : 12 }}
          >
            <span className={`w-2 h-2 rounded-full ${sourceColor} ${isConnected ? 'animate-pulse' : ''}`} />
            <span className="text-xs font-medium">{dataSource}</span>
          </div>

          <button
            type="button"
            onClick={toggleVizFullscreen}
            className="absolute bottom-3 right-3 z-30 w-9 h-9 flex items-center justify-center bg-white/90 hover:bg-white dark:bg-slate-800/90 dark:hover:bg-slate-800 backdrop-blur rounded-md shadow-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 transition-colors"
            title={isVizFullscreen ? '退出全屏' : '全屏显示'}
            aria-label={isVizFullscreen ? '退出全屏' : '全屏显示'}
          >
            {isVizFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          {/* 倒计时蒙层 */}
          <AnimatePresence>
            {status === 'countdown' && (
              <motion.div
                key="countdown-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-30 bg-black/50 backdrop-blur-sm flex flex-col items-center justify-center pointer-events-none"
              >
                <motion.div
                  key={`cd-${countdown}`}
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 1.5, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="w-40 h-40 rounded-full bg-white/10 border-4 border-white/30 flex items-center justify-center mb-4"
                >
                  <span className="text-7xl font-bold text-white drop-shadow-lg">{countdown || 'GO'}</span>
                </motion.div>
                <p className="text-white text-base">请保持姿势，即将开始采集</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 采集状态外框（collecting 时） */}
          {status === 'collecting' && (
            <div className="absolute inset-0 pointer-events-none border-4 border-green-500/70 rounded-xl animate-pulse z-10" />
          )}

          {/* 底部居中浮动：操作按钮区 */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20">
            <AnimatePresence mode="wait">
              {status === 'idle' && (
                <motion.div
                  key="idle-btn"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="flex flex-col items-center gap-2"
                >
                  <Button
                    size="lg"
                    onClick={handleStart}
                    disabled={!isConnected && !importedFileName && collectedFrames.length === 0 && !realtimeData}
                    className="rounded-full px-8 h-14 text-base shadow-xl gap-2"
                  >
                    <Play className="w-5 h-5" />
                    开始采集
                  </Button>
                  {!isConnected && !importedFileName && (
                    <span className="text-xs text-white bg-black/60 backdrop-blur px-3 py-1 rounded-full">
                      请先连接设备或导入 CSV
                    </span>
                  )}
                </motion.div>
              )}

              {(status === 'countdown' || status === 'collecting') && (
                <motion.div
                  key="stop-btn"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                >
                  <Button
                    size="lg"
                    variant="destructive"
                    onClick={handleStop}
                    className="rounded-full px-8 h-14 text-base shadow-xl gap-2 pointer-events-auto"
                  >
                    <Square className="w-5 h-5" />
                    停止采集
                  </Button>
                </motion.div>
              )}

              {status === 'completed' && (
                <motion.div
                  key="done-btns"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  className="flex items-center gap-2"
                >
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={handleReset}
                    className="rounded-full px-5 h-12 shadow-lg gap-2 bg-white/95 backdrop-blur"
                  >
                    <RotateCcw className="w-4 h-4" />
                    重新采集
                  </Button>
                  <Button
                    size="lg"
                    onClick={handleSaveAndNext}
                    className="rounded-full px-6 h-12 text-base shadow-xl gap-2 group"
                  >
                    <Save className="w-4 h-4" />
                    {importedFileName ? '分析导入数据' : '保存并生成报告'}
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <DebugPanel />
        </motion.div>
      </div>
    </div>
  );
}
