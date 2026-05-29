/**
 * 实时展示页面
 * 设计风格：医疗科技极简主义
 * - 真实3D足底压力图 (Three.js)
 * - 串口连接传感器
 * - 压力/面积数据卡片
 * - 实时波形图
 */

import { useState, useEffect, useMemo } from 'react';
import { useApp } from '@/contexts/AppContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Plug,
  PlugZap,
  ArrowRight,
  Activity,
  FlipVertical,
  MoveVertical,
  Scissors,
  Box,
  Grid3x3,
  ChevronsUpDown,
} from 'lucide-react';
import { motion } from 'framer-motion';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { Scene } from '@/components/Scene';
import Pressure2DHeatmap from '@/components/Pressure2DHeatmap';
import { DebugPanel } from '@/components/DebugPanel';
import { serialService, type BaudRate } from '@/lib/SerialService';

interface RealtimePageProps {
  onNext: () => void;
}

// 生成波形数据
const generateWaveformData = (length: number) => {
  return Array.from({ length }, (_, i) => ({
    time: i,
    pressure: 40 + Math.sin(i * 0.3) * 20 + Math.random() * 10,
  }));
};

export default function RealtimePage({ onNext }: RealtimePageProps) {
  const { state } = useApp();
  
  // 视图模式：3D vs 2D
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('2d');
  // 可视化区域高度（可垂直拖动调整）
  const [vizHeight, setVizHeight] = useState(500);
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

  // 3D 视图控制状态
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [enableClipping, setEnableClipping] = useState(false);
  const [clipLevel, setClipLevel] = useState(0.5);
  const [depthScale, setDepthScale] = useState(0.25);
  const [smoothness, setSmoothness] = useState(0.5);

  // 串口连接状态
  const [isConnected, setIsConnected] = useState(false);
  const [realtimeData, setRealtimeData] = useState<number[][] | null>(null);
  const [enableMirroring, setEnableMirroring] = useState(true);
  const [filterThreshold, setFilterThreshold] = useState(25); // 滤波阈值，默认25：过滤初始底噪
  const [baudRate, setBaudRate] = useState<BaudRate>(3000000); // 波特率，默认3M
  
  // 压力数据
  const [pressureStats, setPressureStats] = useState({
    peakPressure: 0,
    avgPressure: 0,
    totalPressure: 0,
    peakArea: 0,
    avgArea: 0,
  });
  
  // 波形数据
  const [waveformData, setWaveformData] = useState(generateWaveformData(50));

  // 初始化串口服务
  useEffect(() => {
    serialService.setOnData((data) => {
      setRealtimeData(data);
      
      // 计算压力统计数据
      let max = 0;
      let sum = 0;
      let count = 0;
      let nonZeroCount = 0;
      
      for (let r = 0; r < data.length; r++) {
        for (let c = 0; c < data[r].length; c++) {
          const val = data[r][c];
          if (val > max) max = val;
          sum += val;
          count++;
          if (val > 5) nonZeroCount++;
        }
      }
      
      const avg = count > 0 ? sum / count : 0;
      
      setPressureStats({
        peakPressure: Math.round(max * 0.39), // 转换为kPa
        avgPressure: Math.round(avg * 0.39),
        totalPressure: Math.round(sum * 0.01),
        peakArea: Math.round(nonZeroCount * 0.25),
        avgArea: Math.round(nonZeroCount * 0.15),
      });
      
      // 更新波形数据
      setWaveformData((prev) => {
        const newPoint = {
          time: prev.length,
          pressure: max * 0.39,
        };
        return [...prev.slice(-49), newPoint];
      });
    });
    
    serialService.setMirroring(enableMirroring);
    
    return () => {
      // 不在这里断开连接，保持连接状态跨页面
    };
  }, []);

  // 更新镜像设置
  useEffect(() => {
    serialService.setMirroring(enableMirroring);
  }, [enableMirroring]);

  // 更新滤波阈值
  useEffect(() => {
    serialService.setFilterThreshold(filterThreshold);
  }, [filterThreshold]);

  // 处理连接/断开
  const handleConnect = async () => {
    if (isConnected) {
      await serialService.disconnect();
      setIsConnected(false);
      setRealtimeData(null);
      setPressureStats({
        peakPressure: 0,
        avgPressure: 0,
        totalPressure: 0,
        peakArea: 0,
        avgArea: 0,
      });
    } else {
      const success = await serialService.connect();
      if (success) {
        setIsConnected(true);
      }
    }
  };

  return (
    <div className="min-h-screen p-6">
      {/* 页面标题 */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6"
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">实时展示</h1>
            <p className="text-muted-foreground">
              当前用户：{state.currentUser?.name || '未知'}
            </p>
          </div>
          <Button onClick={onNext} className="group">
            开始采集
            <ArrowRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </div>
      </motion.div>

      <div className="grid grid-cols-12 gap-6 items-start">
        {/* 左侧：3D足底压力图 */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="col-span-9"
        >
          <div className="medical-card">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="font-semibold text-lg">足底实时压力图</h2>
                {/* 视图模式切换 */}
                <div className="inline-flex bg-secondary/40 rounded-full p-0.5">
                  <button
                    onClick={() => setViewMode('3d')}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      viewMode === '3d'
                        ? 'bg-white shadow-sm text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Box className="w-3 h-3" />
                    3D
                  </button>
                  <button
                    onClick={() => setViewMode('2d')}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                      viewMode === '2d'
                        ? 'bg-white shadow-sm text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Grid3x3 className="w-3 h-3" />
                    2D
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {/* 波特率选择 */}
                {!isConnected && (
                  <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2 py-1">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">波特率</span>
                    <button
                      onClick={() => { setBaudRate(3000000); serialService.setBaudRate(3000000); }}
                      className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                        baudRate === 3000000 
                          ? 'bg-primary text-primary-foreground shadow-sm' 
                          : 'text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      3M
                    </button>
                    <button
                      onClick={() => { setBaudRate(6000000); serialService.setBaudRate(6000000); }}
                      className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                        baudRate === 6000000 
                          ? 'bg-primary text-primary-foreground shadow-sm' 
                          : 'text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      6M
                    </button>
                  </div>
                )}
                {isConnected && (
                  <span className="text-xs text-muted-foreground font-mono bg-secondary/50 px-2 py-1 rounded">
                    {baudRate / 1000000}M baud
                  </span>
                )}
                {/* 设备连接按钮 */}
                <Button 
                  variant={isConnected ? "destructive" : "default"} 
                  size="sm"
                  onClick={handleConnect}
                  className="gap-2"
                >
                  {isConnected ? (
                    <>
                      <PlugZap className="w-4 h-4" />
                      断开设备
                    </>
                  ) : (
                    <>
                      <Plug className="w-4 h-4" />
                      连接设备
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* 实时压力可视化区域（高度可拖动调整） */}
            <div className="relative rounded-xl overflow-hidden" style={{ height: `${vizHeight}px` }}>
              {viewMode === '3d' ? (
                <div className="absolute inset-0 bg-gradient-to-b from-gray-50 to-gray-200 dark:from-gray-900 dark:to-gray-800">
                  <Scene
                    showHeatmap={showHeatmap}
                    enableClipping={enableClipping}
                    clipLevel={clipLevel}
                    depthScale={depthScale}
                    smoothness={smoothness}
                    realtimeData={realtimeData}
                  />
                </div>
              ) : (
                <Pressure2DHeatmap realtimeData={realtimeData} />
              )}

              {/* 实时指示器 */}
              <div className="absolute top-3 right-3 flex items-center gap-2 bg-white/90 dark:bg-slate-800/90 backdrop-blur px-3 py-1.5 rounded-full z-10 shadow-sm">
                <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                <span className="text-sm font-medium">{isConnected ? '实时数据' : '演示数据'}</span>
              </div>

              {/* 调试面板 */}
              <DebugPanel />

              {/* 拖动时的覆盖层（避免触发内部交互） */}
              {isResizingViz && (
                <div className="absolute inset-0 bg-primary/5 z-30 pointer-events-none" />
              )}
            </div>

            {/* 垂直拖动把手 */}
            <div
              role="separator"
              aria-orientation="horizontal"
              onMouseDown={startVizResize}
              onDoubleClick={() => setVizHeight(500)}
              className={`group relative h-3 mt-1 cursor-ns-resize select-none flex items-center justify-center rounded-md transition-colors ${
                isResizingViz ? 'bg-primary/15' : 'hover:bg-secondary/60'
              }`}
              title="拖动调整高度（双击恢复默认）"
            >
              <ChevronsUpDown className={`w-4 h-4 transition-colors ${isResizingViz ? 'text-primary' : 'text-muted-foreground/60 group-hover:text-muted-foreground'}`} />
              <span className={`absolute right-2 text-[10px] font-mono transition-colors ${isResizingViz ? 'text-primary' : 'text-muted-foreground/50 group-hover:text-muted-foreground'}`}>
                {vizHeight}px
              </span>
            </div>

            {/* 视图控制 */}
            <div className="mt-4 space-y-4">
              {/* 3D 专属：热力图开关 */}
              {viewMode === '3d' && (
                <div className="flex items-center justify-between">
                  <Label className="font-medium">压力热力图覆盖</Label>
                  <Switch checked={showHeatmap} onCheckedChange={setShowHeatmap} />
                </div>
              )}

              {/* 传感器线序修正（两种模式都适用） */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FlipVertical className="w-4 h-4 text-muted-foreground" />
                  <Label className="font-medium">传感器线序修正</Label>
                </div>
                <Switch checked={enableMirroring} onCheckedChange={setEnableMirroring} />
              </div>

              {/* 3D 专属：深度强度 + 平滑度 */}
              {viewMode === '3d' && (
                <>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <MoveVertical className="w-3 h-3" /> 深度强度
                      </span>
                      <span className="font-mono">{(depthScale * 100).toFixed(0)}%</span>
                    </div>
                    <Slider
                      value={[depthScale]}
                      min={0.05}
                      max={0.5}
                      step={0.01}
                      onValueChange={(vals) => setDepthScale(vals[0])}
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground flex items-center gap-1">
                        <Activity className="w-3 h-3" /> 平滑度
                      </span>
                      <span className="font-mono">{(smoothness * 100).toFixed(0)}%</span>
                    </div>
                    <Slider
                      value={[smoothness]}
                      min={0}
                      max={1}
                      step={0.01}
                      onValueChange={(vals) => setSmoothness(vals[0])}
                    />
                  </div>
                </>
              )}

              {/* 滤波阈值 */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Scissors className="w-3 h-3" /> 滤波阈值
                  </span>
                  <span className="font-mono">{filterThreshold}</span>
                </div>
                <Slider 
                  value={[filterThreshold]} 
                  min={0} 
                  max={50} 
                  step={1} 
                  onValueChange={(vals) => setFilterThreshold(vals[0])} 
                />
                <p className="text-xs text-muted-foreground">小于等于此值的数据将被置零（默认 25 用于过滤初始底噪）</p>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 右侧：数据面板 */}
        <div className="col-span-3 space-y-4">
          {/* 压力数据 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="medical-card !p-3"
          >
            <h2 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-primary" />
              压力数据
            </h2>
            <div className="grid grid-cols-3 gap-1.5">
              <div className="text-center p-1.5 bg-secondary/30 rounded-md">
                <p className="text-[10px] text-muted-foreground">峰值</p>
                <p className="text-base font-semibold text-primary leading-tight">{pressureStats.peakPressure || '--'}</p>
                <p className="text-[10px] text-muted-foreground">kPa</p>
              </div>
              <div className="text-center p-1.5 bg-secondary/30 rounded-md">
                <p className="text-[10px] text-muted-foreground">平均</p>
                <p className="text-base font-semibold text-[var(--health-green)] leading-tight">{pressureStats.avgPressure || '--'}</p>
                <p className="text-[10px] text-muted-foreground">kPa</p>
              </div>
              <div className="text-center p-1.5 bg-secondary/30 rounded-md">
                <p className="text-[10px] text-muted-foreground">总值</p>
                <p className="text-base font-semibold text-[var(--alert-orange)] leading-tight">{pressureStats.totalPressure || '--'}</p>
                <p className="text-[10px] text-muted-foreground">kPa</p>
              </div>
            </div>
          </motion.div>

          {/* 面积数据 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
            className="medical-card !p-3"
          >
            <h2 className="font-semibold text-sm mb-2">面积数据</h2>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="text-center p-1.5 bg-secondary/30 rounded-md">
                <p className="text-[10px] text-muted-foreground">峰值</p>
                <p className="text-base font-semibold text-primary leading-tight">{pressureStats.peakArea || '--'}</p>
                <p className="text-[10px] text-muted-foreground">cm²</p>
              </div>
              <div className="text-center p-1.5 bg-secondary/30 rounded-md">
                <p className="text-[10px] text-muted-foreground">平均</p>
                <p className="text-base font-semibold text-[var(--health-green)] leading-tight">{pressureStats.avgArea || '--'}</p>
                <p className="text-[10px] text-muted-foreground">cm²</p>
              </div>
            </div>
          </motion.div>

          {/* 实时波形 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.4 }}
            className="medical-card !p-3"
          >
            <h2 className="font-semibold text-sm mb-2">实时压力波形</h2>
            <div className="h-24">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={waveformData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="time" hide />
                  <YAxis hide domain={[0, 'auto']} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                    }}
                    formatter={(value: number) => [`${value.toFixed(1)} kPa`, '压力']}
                  />
                  <Line
                    type="monotone"
                    dataKey="pressure"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
