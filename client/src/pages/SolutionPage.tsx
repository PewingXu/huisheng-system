/**
 * 解决方案页面 v4
 * - 根据足底压力测量参数自动设计鞋垫
 * - 支持左右脚独立调节
 * - 足弓高度符合人体工学7级分级（PPT逻辑）
 * - 根据左右脚压力占比自动调整基础厚度使受力对等
 * - 分区支撑补偿显示
 */

import { useState, useMemo, useEffect, memo, useCallback } from 'react';
import { useApp } from '@/contexts/AppContext';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import {
  Download,
  RotateCcw,
  Home,
  Play,
  Pause,
  RotateCw,
  Palette,
  Ruler,
  ArrowUpDown,
  MoveHorizontal,
  Activity,
  CircleAlert,
  Info,
  Lightbulb,
  Footprints,
  ChevronDown,
  ChevronUp,
  Scale,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  LatticeInsoleViewer,
  getArchLevelFromAI,
  getArchLevelColor,
  getArchDesignLogic,
  getZoneSupportCompensation,
  calculatePressureAdaptiveThickness,
  type InsoleParams,
} from '@/components/LatticeInsole3D';
import {
  exportInsoleSTL,
  exportInsoleGLTF,
} from '@/lib/insoleExporter';
import {
  lookupInsoleSize,
  INSOLE_CATEGORY_LABELS,
  type InsoleCategory,
} from '@/lib/insoleSize';

interface SolutionPageProps {
  onFinish: () => void;
}

const colorOptions = [
  { name: '银灰', value: '#B0B0B0' },
  { name: '医疗蓝', value: '#4A90D9' },
  { name: '经典灰', value: '#6B7280' },
  { name: '活力橙', value: '#F97316' },
  { name: '自然绿', value: '#22C55E' },
];

const PARAMETER_EXPLANATIONS = {
  archCorrection: '依据舟骨下降理论，结合舒适度修正系数，并参考用户足弓高度计算得到，用于在支撑效果与穿着舒适度之间取得平衡。',
  baseThickness: '基础厚度依据传感器材料特性与穿着舒适度设定，是鞋垫整体支撑和缓冲的基础参数。',
  heelThickness: '足跟厚度以 10mm 为基础值，参考足跟脂肪垫平均压缩量设定。当天然足跟垫萎缩、减震行程缩短时，鞋垫需要进行补偿。足型越偏离正常，通常会给予更多后跟缓冲，以更好平衡减震、支撑与矫正。',
} as const;

function ParameterHelp({ title, description }: { title: string; description: string }) {
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
          onClick={(event) => event.preventDefault()}
          aria-label={`${title}说明`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-72 p-3">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** 单脚参数面板（React.memo 优化：参数不变时不重渲染，避免左右脚互相拖累） */
const FootParamPanel = memo(function FootParamPanel({
  label,
  params,
  onChange,
  isActive,
  insoleCategory,
}: {
  label: string;
  params: InsoleParams;
  onChange: (p: Partial<InsoleParams>) => void;
  isActive: boolean;
  insoleCategory: InsoleCategory;
}) {
  // 查表得到当前足长对应的鞋码（用于在足长滑块下展示）
  const sized = lookupInsoleSize(params.footLength, insoleCategory);
  const [expanded, setExpanded] = useState(true);
  const levelColor = getArchLevelColor(params.archLevel);
  const designLogic = getArchDesignLogic(params.archLevel);

  return (
    <div className={`rounded-xl border transition-all ${isActive ? 'border-primary/40 bg-white shadow-sm' : 'border-gray-200 bg-gray-50/50'}`}>
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
            style={{ backgroundColor: levelColor }}>
            L{params.archLevel}
          </div>
          <div className="text-left">
            <p className="font-semibold text-sm">{label}</p>
            <p className="text-xs text-muted-foreground">{params.archType}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground bg-gray-100 px-2 py-1 rounded inline-flex items-center gap-1.5">
            矫正 +{params.archCorrection}mm
            <ParameterHelp title="足弓矫正厚度" description={PARAMETER_EXPLANATIONS.archCorrection} />
          </span>
          <span className="text-xs text-muted-foreground bg-blue-50 px-2 py-1 rounded inline-flex items-center gap-1.5">
            基厚 {(params.baseThickness * 10).toFixed(1)}mm
            <ParameterHelp title="基础厚度" description={PARAMETER_EXPLANATIONS.baseThickness} />
          </span>
          <span className="px-2 py-0.5 bg-amber-50 text-amber-700 rounded-full text-xs font-medium inline-flex items-center gap-1.5">
            足跟 {params.heelThickness}mm
            <ParameterHelp title="足跟缓冲厚度" description={PARAMETER_EXPLANATIONS.heelThickness} />
          </span>
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4">
              {/* 设计逻辑提示 */}
              <div className="flex items-start gap-2 p-2.5 rounded-lg text-xs" style={{ backgroundColor: `${levelColor}10`, borderLeft: `3px solid ${levelColor}` }}>
                <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: levelColor }} />
                <span className="text-gray-600 leading-relaxed">{designLogic}</span>
              </div>

              {/* 压力占比 */}
              <div className="flex items-center gap-2 p-2 rounded-lg bg-indigo-50">
                <Scale className="w-3.5 h-3.5 text-indigo-500" />
                <span className="text-xs text-indigo-700">
                  压力占比: <strong>{(params.pressureRatio * 100).toFixed(1)}%</strong>
                  {params.pressureRatio > 0.52 && <span className="text-red-500 ml-1">（偏高，已加厚缓冲）</span>}
                  {params.pressureRatio < 0.48 && <span className="text-green-500 ml-1">（偏低，已适当减薄）</span>}
                  {params.pressureRatio >= 0.48 && params.pressureRatio <= 0.52 && <span className="text-green-600 ml-1">（均衡）</span>}
                </span>
              </div>

              {/* 足长 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <ArrowUpDown className="w-3.5 h-3.5 text-blue-500" />
                    <span className="text-xs font-medium">足长</span>
                  </div>
                  <span className="text-sm font-mono font-bold text-blue-600">{Number(params.footLength.toFixed(1))} cm</span>
                </div>
                <Slider
                  value={[params.footLength]}
                  onValueChange={([v]) => {
                    const sized = lookupInsoleSize(v, insoleCategory);
                    onChange({
                      footLength: v,
                      footWidth: Math.round(sized.footWidthCm * 2) / 2,
                    });
                  }}
                  min={20} max={32} step={0.5}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>20cm</span><span>32cm</span>
                </div>
                {/* 鞋码（由 足长 + 分类 查表） */}
                <div className="flex items-center justify-between text-[11px] bg-blue-50/60 border border-blue-100 rounded-md px-2 py-1">
                  <span className="text-blue-700">匹配鞋码（{INSOLE_CATEGORY_LABELS[insoleCategory]}）</span>
                  <span className="font-mono font-bold text-blue-700">中国 {sized.shoeSize} 码</span>
                </div>
              </div>

              {/* 足宽 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <MoveHorizontal className="w-3.5 h-3.5 text-green-500" />
                    <span className="text-xs font-medium">足宽</span>
                  </div>
                  <span className="text-sm font-mono font-bold text-green-600">{Number(params.footWidth.toFixed(1))} cm</span>
                </div>
                <Slider
                  value={[params.footWidth]}
                  onValueChange={([v]) => onChange({ footWidth: v })}
                  min={7} max={13} step={0.5}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>7cm</span><span>13cm</span>
                </div>
              </div>

              {/* 足弓矫正厚度 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Activity className="w-3.5 h-3.5" style={{ color: levelColor }} />
                    <span className="text-xs font-medium">足弓矫正厚度 (ΔHS)</span>
                    <ParameterHelp title="足弓矫正厚度" description={PARAMETER_EXPLANATIONS.archCorrection} />
                  </div>
                  <span className="text-sm font-mono font-bold" style={{ color: levelColor }}>+{params.archCorrection} mm</span>
                </div>
                <Slider
                  value={[params.archCorrection]}
                  onValueChange={([v]) => {
                    let newLevel = 4;
                    let newType = '正常足';
                    if (v >= 10) { newLevel = 1; newType = '重度高弓足'; }
                    else if (v >= 8) { newLevel = 2; newType = '中度高弓足'; }
                    else if (v >= 6.5 && v < 8) {
                      if (params.archLevel <= 3) { newLevel = 3; newType = '轻度高弓足'; }
                      else { newLevel = 6; newType = '中度扁平足'; }
                    }
                    else if (v >= 5) { newLevel = 6; newType = '中度扁平足'; }
                    else if (v >= 3.5) { newLevel = 5; newType = '轻度扁平足'; }
                    else if (v >= 2) { newLevel = 4; newType = '正常足'; }
                    else { newLevel = 4; newType = '正常足'; }
                    const nextCompensation = getZoneSupportCompensation(newLevel, params.baseThickness, params.heelThickness, params.pressureRatio);
                    onChange({
                      archCorrection: v,
                      archLevel: newLevel,
                      archType: newType,
                      forefootCompensation: nextCompensation.forefoot,
                      archCompensation: nextCompensation.arch,
                      heelCompensation: nextCompensation.heel,
                    });
                  }}
                  min={1} max={12} step={0.5}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>+1mm (维持)</span><span>+12mm (最大矫正)</span>
                </div>
              </div>

              {/* 基础厚度（压力自适应） */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Scale className="w-3.5 h-3.5 text-indigo-500" />
                    <span className="text-xs font-medium">基础厚度（压力自适应）</span>
                    <ParameterHelp title="基础厚度" description={PARAMETER_EXPLANATIONS.baseThickness} />
                  </div>
                  <span className="text-sm font-mono font-bold text-indigo-600">{(params.baseThickness * 10).toFixed(1)} mm</span>
                </div>
                <Slider
                  value={[params.baseThickness * 10]}
                  onValueChange={([v]) => {
                    const nextBaseThickness = v / 10;
                    const nextCompensation = getZoneSupportCompensation(params.archLevel, nextBaseThickness, params.heelThickness, params.pressureRatio);
                    onChange({
                      baseThickness: nextBaseThickness,
                      forefootCompensation: nextCompensation.forefoot,
                      archCompensation: nextCompensation.arch,
                      heelCompensation: nextCompensation.heel,
                    });
                  }}
                  min={1.5} max={6} step={0.1}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>1.5mm</span><span>6.0mm</span>
                </div>
              </div>

              {/* 足跟缓冲厚度 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <ArrowUpDown className="w-3.5 h-3.5 text-amber-500" />
                    <span className="text-xs font-medium">足跟缓冲厚度</span>
                    <ParameterHelp title="足跟缓冲厚度" description={PARAMETER_EXPLANATIONS.heelThickness} />
                  </div>
                  <span className="text-sm font-mono font-bold text-amber-600">{params.heelThickness} mm</span>
                </div>
                <Slider
                  value={[params.heelThickness]}
                  onValueChange={([v]) => {
                    const nextCompensation = getZoneSupportCompensation(params.archLevel, params.baseThickness, v, params.pressureRatio);
                    onChange({
                      heelThickness: v,
                      forefootCompensation: nextCompensation.forefoot,
                      archCompensation: nextCompensation.arch,
                      heelCompensation: nextCompensation.heel,
                    });
                  }}
                  min={0} max={30} step={1}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>0mm (无缓冲)</span><span>30mm (最大缓冲)</span>
                </div>
              </div>


              {/* 分区支撑补偿 */}
              <div className="space-y-3">
                <p className="text-xs font-medium text-gray-500">分区支撑补偿调节 (mm)</p>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-blue-600">前掌区</span>
                    <span className="text-sm font-mono font-bold text-blue-700">
                      {params.forefootCompensation >= 0 ? '+' : ''}{params.forefootCompensation.toFixed(1)} mm
                    </span>
                  </div>
                  <Slider
                    value={[params.forefootCompensation]}
                    onValueChange={([v]) => onChange({ forefootCompensation: Number(v.toFixed(1)) })}
                    min={-1.5} max={1.5} step={0.1}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>-1.5mm 减压</span><span>+1.5mm 支撑</span>
                  </div>
                  <p className="text-[10px] text-blue-500">正值增强支撑 / 负值局部让位</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium" style={{ color: levelColor }}>足弓区</span>
                    <span className="text-sm font-mono font-bold" style={{ color: levelColor }}>
                      {params.archCompensation >= 0 ? '+' : ''}{params.archCompensation.toFixed(1)} mm
                    </span>
                  </div>
                  <Slider
                    value={[params.archCompensation]}
                    onValueChange={([v]) => onChange({ archCompensation: Number(v.toFixed(1)) })}
                    min={-1.5} max={1.5} step={0.1}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>-1.5mm 减压</span><span>+1.5mm 支撑</span>
                  </div>
                  <p className="text-[10px]" style={{ color: levelColor }}>正值抬高支撑 / 负值减压让位</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-amber-600">后跟区</span>
                    <span className="text-sm font-mono font-bold text-amber-700">
                      {params.heelCompensation >= 0 ? '+' : ''}{params.heelCompensation.toFixed(1)} mm
                    </span>
                  </div>
                  <Slider
                    value={[params.heelCompensation]}
                    onValueChange={([v]) => onChange({ heelCompensation: Number(v.toFixed(1)) })}
                    min={-1.5} max={1.5} step={0.1}
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>-1.5mm 减压</span><span>+1.5mm 承托</span>
                  </div>
                  <p className="text-[10px] text-amber-500">正值增强承托 / 负值缓冲减压</p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

export default function SolutionPage({ onFinish }: SolutionPageProps) {
  const { state, resetApp } = useApp();
  const isAnalysisPending = state.analysisStatus === 'pending';
  const hasAnalysisResult = Boolean(state.footAnalysis || state.reportData);
  const [activeTab, setActiveTab] = useState<'left' | 'right' | 'both'>('both');
  const [autoRotate, setAutoRotate] = useState(false);
  const [showCompensationRegions, setShowCompensationRegions] = useState(true);
  const [selectedColor, setSelectedColor] = useState(colorOptions[0].value);
  // 鞋码体系（决定足宽查表）
  const [insoleCategory, setInsoleCategory] = useState<InsoleCategory>('adult_male');

  // 从分析报告中获取参数
  const reportData = state.reportData;
  const footAnalysis = state.footAnalysis; // 精确分析结果

  // 计算左右脚压力占比（优先使用footAnalysis精确值）
  const pressureInfo = useMemo(() => {
    // 优先使用footAnalysis中的精确压力比
    if (footAnalysis) {
      let lr = footAnalysis.bilateral.leftPressureRatio;
      let rr = footAnalysis.bilateral.rightPressureRatio;
      // 如果值>1说明是百分比形式（如51.6），需要除以100转为0-1范围
      if (lr > 1 || rr > 1) {
        const total = lr + rr;
        lr = total > 0 ? lr / total : 0.5;
        rr = total > 0 ? rr / total : 0.5;
      }
      return {
        leftRatio: Math.max(0, Math.min(1, lr)),
        rightRatio: Math.max(0, Math.min(1, rr)),
      };
    }
    
    const leftP = reportData?.leftPressure;
    const rightP = reportData?.rightPressure;
    
    if (leftP && rightP) {
      const totalPressure = leftP.totalPressure + rightP.totalPressure;
      const leftRatio = totalPressure > 0 ? leftP.totalPressure / totalPressure : 0.5;
      const rightRatio = totalPressure > 0 ? rightP.totalPressure / totalPressure : 0.5;
      return { leftRatio, rightRatio };
    }
    
    if (leftP?.leftRightRatio !== undefined) {
      const ratio = leftP.leftRightRatio;
      const leftRatio = ratio / (1 + ratio);
      const rightRatio = 1 / (1 + ratio);
      return { leftRatio, rightRatio };
    }
    
    return { leftRatio: 0.5, rightRatio: 0.5 };
  }, [reportData, footAnalysis]);

  // 调试：确保pressureInfo始终在合理范围
  if (pressureInfo.leftRatio > 1 || pressureInfo.rightRatio > 1) {
    console.warn('[SolutionPage] pressureInfo异常:', pressureInfo);
  }

  // 根据压力占比计算自适应厚度
  const adaptiveThickness = useMemo(() => {
    return calculatePressureAdaptiveThickness(
      pressureInfo.leftRatio,
      pressureInfo.rightRatio,
      0.3 // 基准厚度 0.3cm = 3mm
    );
  }, [pressureInfo]);

  // 初始化左右脚参数（优先使用footAnalysis精确数据，否则回退到reportData）
  const getInitialParams = (foot: 'left' | 'right'): InsoleParams => {
    const ratio = foot === 'left' ? pressureInfo.leftRatio : pressureInfo.rightRatio;
    const thickness = foot === 'left' ? adaptiveThickness.leftThickness : adaptiveThickness.rightThickness;

    let footLength = 26;
    let ai = 0.24;

    // 优先使用footAnalysis中的精确数据（足长用传感器值，足宽用查表）
    const analysis = foot === 'left' ? footAnalysis?.left : footAnalysis?.right;
    if (analysis) {
      footLength = Math.round((analysis.footLength || 26) * 2) / 2;
      ai = analysis.archIndex;
    } else {
      const footData = foot === 'left' ? reportData?.leftFoot : reportData?.rightFoot;
      if (footData) {
        footLength = Math.round((footData.footLength || 26) * 2) / 2;
        if (footData.archHeight === 'low') ai = 0.33;
        else if (footData.archHeight === 'high') ai = 0.12;
        else ai = 0.24;
      }
    }

    // 足宽：从 insole 表查（按当前分类 + 足长），不再用传感器测得的宽度
    const sized = lookupInsoleSize(footLength, insoleCategory);
    const footWidth = Math.round(sized.footWidthCm * 2) / 2;   // 对齐到 0.5cm 步长

    const archInfo = getArchLevelFromAI(ai);
    // 足跟缓冲厚度默认值（根据足弓等级自动设置）
    // L4正常足=10mm, L5/L3=15mm, L6/L2=20mm, L7/L1=25mm
    const heelDefaults: Record<number, number> = {
      1: 25, 2: 20, 3: 15, 4: 10, 5: 15, 6: 20, 7: 25
    };
    const heelThickness = heelDefaults[archInfo.level] ?? 10;
    const compensation = getZoneSupportCompensation(archInfo.level, thickness, heelThickness, ratio);
    return {
      footLength,
      footWidth,
      archCorrection: archInfo.correction,
      archLevel: archInfo.level,
      archType: archInfo.type,
      baseThickness: thickness,
      pressureRatio: ratio,
      heelThickness,
      latticeDensity: 3, // 默认标准密度
      forefootCompensation: compensation.forefoot,
      archCompensation: compensation.arch,
      heelCompensation: compensation.heel,
    };
  };

  const [leftParams, setLeftParams] = useState<InsoleParams>(() => getInitialParams('left'));
  const [rightParams, setRightParams] = useState<InsoleParams>(() => getInitialParams('right'));

  // 防抖：3D 鞋垫网格生成开销大，拖动滑块时让 3D 视图 250ms 后才跟进。
  // 滑块自身用 leftParams/rightParams 保持响应，3D 视图用 deferred 版本。
  const [deferredLeftParams, setDeferredLeftParams] = useState<InsoleParams>(leftParams);
  const [deferredRightParams, setDeferredRightParams] = useState<InsoleParams>(rightParams);
  useEffect(() => {
    const t = setTimeout(() => setDeferredLeftParams(leftParams), 250);
    return () => clearTimeout(t);
  }, [leftParams]);
  useEffect(() => {
    const t = setTimeout(() => setDeferredRightParams(rightParams), 250);
    return () => clearTimeout(t);
  }, [rightParams]);

  // 当分析结果变化时，重新同步默认鞋垫参数
  useEffect(() => {
    if (!hasAnalysisResult || isAnalysisPending) return;
    setLeftParams(getInitialParams('left'));
    setRightParams(getInitialParams('right'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [footAnalysis, reportData, adaptiveThickness.leftThickness, adaptiveThickness.rightThickness, insoleCategory, hasAnalysisResult, isAnalysisPending]);

  // 分类变化时，按当前足长重新查表设置足宽
  useEffect(() => {
    setLeftParams(prev => {
      const sized = lookupInsoleSize(prev.footLength, insoleCategory);
      return { ...prev, footWidth: Math.round(sized.footWidthCm * 2) / 2 };
    });
    setRightParams(prev => {
      const sized = lookupInsoleSize(prev.footLength, insoleCategory);
      return { ...prev, footWidth: Math.round(sized.footWidthCm * 2) / 2 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insoleCategory]);

  const updateLeftParams = useCallback((p: Partial<InsoleParams>) => {
    setLeftParams(prev => ({ ...prev, ...p }));
  }, []);
  const updateRightParams = useCallback((p: Partial<InsoleParams>) => {
    setRightParams(prev => ({ ...prev, ...p }));
  }, []);

  const handleDownloadSTL = (foot: 'left' | 'right') => {
    const params = foot === 'left' ? leftParams : rightParams;
    const userName = state.currentUser?.name;
    try {
      exportInsoleSTL(
        foot,
        params.footLength,
        params.footWidth,
        params.archCorrection,
        params.baseThickness,
        params.heelThickness,
        params.latticeDensity,
        params.forefootCompensation,
        params.archCompensation,
        params.heelCompensation,
        selectedColor,
        userName
      );
      toast.success(`${foot === 'left' ? '左脚' : '右脚'}鞋垫STL文件已开始下载`, {
        description: 'STL格式可直接用于3D打印切片软件',
      });
    } catch (err) {
      console.error('STL导出失败:', err);
      toast.error('STL导出失败，请重试');
    }
  };

  const handleDownloadGLTF = async (foot: 'left' | 'right') => {
    const params = foot === 'left' ? leftParams : rightParams;
    const userName = state.currentUser?.name;
    try {
      await exportInsoleGLTF(
        foot,
        params.footLength,
        params.footWidth,
        params.archCorrection,
        params.baseThickness,
        params.heelThickness,
        params.latticeDensity,
        params.forefootCompensation,
        params.archCompensation,
        params.heelCompensation,
        selectedColor,
        userName
      );
      toast.success(`${foot === 'left' ? '左脚' : '右脚'}鞋垫GLB文件已开始下载`, {
        description: 'GLB格式可在Blender中打开并转为FBX',
      });
    } catch (err) {
      console.error('GLTF导出失败:', err);
      toast.error('GLTF导出失败，请重试');
    }
  };

  const handleFinish = () => {
    resetApp();
    onFinish();
  };

  const handleResetParams = () => {
    setLeftParams(getInitialParams('left'));
    setRightParams(getInitialParams('right'));
    toast.info('参数已重置为测量值');
  };

  // 压力不均衡提示
  const pressureImbalance = Math.abs(pressureInfo.leftRatio - pressureInfo.rightRatio);
  const isImbalanced = pressureImbalance > 0.04; // >4%视为不均衡

  if (isAnalysisPending || !hasAnalysisResult) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          {isAnalysisPending ? (
            <>
              <div className="animate-spin w-12 h-12 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-muted-foreground">正在同步最新分析结果到解决方案...</p>
            </>
          ) : (
            <p className="text-muted-foreground">请先完成分析报告生成，再查看解决方案</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-6">
      {/* 页面标题 */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-5"
      >
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">解决方案</h1>
            <p className="text-muted-foreground text-sm">
              基于足底压力测量数据 · 个性化晶格体矫正鞋垫 · 7级人体工学分级
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleResetParams}>
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              重置参数
            </Button>
            <Button onClick={handleFinish} variant="outline" className="group">
              <Home className="w-4 h-4 mr-2" />
              结束采集
            </Button>
          </div>
        </div>
      </motion.div>

      {/* 压力均衡提示 */}
      {isImbalanced && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 rounded-xl border border-amber-200 bg-amber-50 flex items-start gap-3"
        >
          <Scale className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-800">检测到左右脚压力不均衡</p>
            <p className="text-xs text-amber-600 mt-1">
              左脚 {(pressureInfo.leftRatio * 100).toFixed(1)}% : 右脚 {(pressureInfo.rightRatio * 100).toFixed(1)}%
              （偏差 {(pressureImbalance * 100).toFixed(1)}%）。
              系统已自动调整鞋垫基础厚度：
              左脚 {(adaptiveThickness.leftThickness * 10).toFixed(1)}mm，
              右脚 {(adaptiveThickness.rightThickness * 10).toFixed(1)}mm，
              以帮助两脚受力趋于对等。
            </p>
          </div>
        </motion.div>
      )}

      <div className="grid grid-cols-12 gap-5">
        {/* 左侧：3D鞋垫展示 */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="col-span-7"
        >
          <div className="medical-card h-full">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-lg flex items-center gap-2">
                <Footprints className="w-5 h-5 text-primary" />
                晶格体3D鞋垫
              </h2>
              <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'left' | 'right' | 'both')}>
                <TabsList>
                  <TabsTrigger value="both">双脚</TabsTrigger>
                  <TabsTrigger value="left">左脚</TabsTrigger>
                  <TabsTrigger value="right">右脚</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* 3D视图 */}
            <div className="relative bg-gradient-to-b from-slate-50 to-slate-100 rounded-xl overflow-hidden" style={{ height: '440px' }}>
              <LatticeInsoleViewer
                activeFoot={activeTab}
                autoRotate={autoRotate}
                color={selectedColor}
                showCompensationRegions={showCompensationRegions}
                leftParams={deferredLeftParams}
                rightParams={deferredRightParams}
              />

              {autoRotate && (
                <div className="absolute top-4 left-4 bg-primary/90 text-white px-3 py-1.5 rounded-full text-sm flex items-center gap-2">
                  <RotateCw className="w-4 h-4 animate-spin" />
                  自动旋转中
                </div>
              )}

              {/* 参数摘要 - 右脚在左侧，左脚在右侧 */}
              <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-2 rounded-lg text-xs space-y-1.5 shadow-sm">
                {(activeTab === 'right' || activeTab === 'both') && (
                  <div>
                    <p className="font-medium text-gray-700">右脚</p>
                    <p className="text-gray-500">{rightParams.footLength.toFixed(1)}cm × {rightParams.footWidth.toFixed(1)}cm · L{rightParams.archLevel} +{rightParams.archCorrection}mm</p>
                    <p className="text-indigo-500">基厚 {(rightParams.baseThickness * 10).toFixed(1)}mm · 足跟 {rightParams.heelThickness}mm</p>
                    <p className="text-blue-500">前掌补偿 {rightParams.forefootCompensation >= 0 ? '+' : ''}{rightParams.forefootCompensation.toFixed(1)}mm · 后跟补偿 {rightParams.heelCompensation >= 0 ? '+' : ''}{rightParams.heelCompensation.toFixed(1)}mm</p>
                  </div>
                )}
                {(activeTab === 'left' || activeTab === 'both') && (
                  <div>
                    <p className="font-medium text-gray-700">左脚</p>
                    <p className="text-gray-500">{leftParams.footLength.toFixed(1)}cm × {leftParams.footWidth.toFixed(1)}cm · L{leftParams.archLevel} +{leftParams.archCorrection}mm</p>
                    <p className="text-indigo-500">基厚 {(leftParams.baseThickness * 10).toFixed(1)}mm · 足跟 {leftParams.heelThickness}mm</p>
                    <p className="text-blue-500">前掌补偿 {leftParams.forefootCompensation >= 0 ? '+' : ''}{leftParams.forefootCompensation.toFixed(1)}mm · 后跟补偿 {leftParams.heelCompensation >= 0 ? '+' : ''}{leftParams.heelCompensation.toFixed(1)}mm</p>
                  </div>
                )}
              </div>
            </div>

            {/* 控制面板 */}
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => {
                      setAutoRotate(!autoRotate);
                      toast.info(autoRotate ? '已停止自动旋转' : '开始360°自动旋转');
                    }}
                  >
                    {autoRotate ? <Pause className="w-3.5 h-3.5 mr-1.5" /> : <Play className="w-3.5 h-3.5 mr-1.5" />}
                    {autoRotate ? '停止' : '360°预览'}
                  </Button>

                  <Button
                    variant={showCompensationRegions ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setShowCompensationRegions(v => !v)}
                  >
                    {showCompensationRegions ? '隐藏补偿区域' : '显示补偿区域'}
                  </Button>

                  <div className="flex items-center gap-2">
                    <Palette className="w-3.5 h-3.5 text-muted-foreground" />
                    {colorOptions.map((c) => (
                      <button
                        key={c.value}
                        onClick={() => setSelectedColor(c.value)}
                        className={`w-6 h-6 rounded-full border-2 transition-all ${
                          selectedColor === c.value ? 'border-primary scale-110 shadow-md' : 'border-gray-200 hover:scale-105'
                        }`}
                        style={{ backgroundColor: c.value }}
                        title={c.name}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">STL:</span>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleDownloadSTL('left')}>
                      <Download className="w-3 h-3 mr-1" />
                      左
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleDownloadSTL('right')}>
                      <Download className="w-3 h-3 mr-1" />
                      右
                    </Button>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">GLB:</span>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleDownloadGLTF('left')}>
                      <Download className="w-3 h-3 mr-1" />
                      左
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => handleDownloadGLTF('right')}>
                      <Download className="w-3 h-3 mr-1" />
                      右
                    </Button>
                  </div>
                </div>
              </div>

              {showCompensationRegions && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2 space-y-2">
                  <p className="text-xs font-medium text-slate-700">补偿标注</p>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-red-600" />
                      正补偿：抬高 / 增强支撑
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-blue-600" />
                      负补偿：减压 / 让位
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-slate-50 border border-slate-300" />
                      接近 0：变化较弱
                    </span>
                  </div>
                  <div className="rounded-md bg-white/80 px-2.5 py-2 text-[11px] leading-5 text-slate-600 border border-slate-200">
                    <p>颜色表示当前点位补偿的正负和厚度变化：红色表示正补偿（局部抬高、增强支撑），蓝色表示负补偿（局部减压、让位）。</p>
                    <p>颜色越深，表示该位置的补偿绝对值越大、厚度变化越明显；颜色越浅，表示补偿更接近 0。</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* 右侧：参数面板 */}
        <div className="col-span-5 space-y-4">
          {/* 鞋码体系选择（决定足宽查表） */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-xl border border-blue-200 bg-blue-50/50 p-3 flex items-center gap-3"
          >
            <label className="text-xs font-medium text-blue-900 shrink-0 flex items-center gap-1">
              <Ruler className="w-3.5 h-3.5" />
              鞋码体系
            </label>
            <select
              value={insoleCategory}
              onChange={(e) => setInsoleCategory(e.target.value as InsoleCategory)}
              className="flex-1 text-sm bg-white border border-blue-200 rounded-md px-2 py-1.5 outline-none focus:ring-2 focus:ring-blue-300"
            >
              {(Object.keys(INSOLE_CATEGORY_LABELS) as InsoleCategory[]).map((k) => (
                <option key={k} value={k}>{INSOLE_CATEGORY_LABELS[k]}</option>
              ))}
            </select>
            <span className="text-[10px] text-blue-700/70">影响足宽与鞋码</span>
          </motion.div>

          {/* 左脚参数 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 }}
          >
            <FootParamPanel
              label="左脚鞋垫"
              params={leftParams}
              onChange={updateLeftParams}
              isActive={activeTab === 'left' || activeTab === 'both'}
              insoleCategory={insoleCategory}
            />
          </motion.div>

          {/* 右脚参数 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.25 }}
          >
            <FootParamPanel
              label="右脚鞋垫"
              params={rightParams}
              onChange={updateRightParams}
              isActive={activeTab === 'right' || activeTab === 'both'}
              insoleCategory={insoleCategory}
            />
          </motion.div>

          {/* 7级分级参考表 */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.35 }}
            className="rounded-xl border border-gray-200 bg-white p-4"
          >
            <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-primary" />
              解决方案
            </h3>

            <div className="mb-4 space-y-2">
              <div className="rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs leading-5">
                <p className="font-medium text-blue-900">
                  左脚：L{leftParams.archLevel} {leftParams.archType}；足弓矫正厚度 +{Number(leftParams.archCorrection.toFixed(1))}mm
                </p>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs leading-5">
                <p className="font-medium text-emerald-900">
                  右脚：L{rightParams.archLevel} {rightParams.archType}；足弓矫正厚度 +{Number(rightParams.archCorrection.toFixed(1))}mm
                </p>
              </div>
            </div>

            <h4 className="font-medium text-xs text-muted-foreground mb-2">足弓分级参考 (1-7级)</h4>
            <div className="space-y-1.5">
              {[
                { l: 1, t: '重度高弓', ai: '<0.10', c: '+10~12mm' },
                { l: 2, t: '中度高弓', ai: '0.10~0.15', c: '+8~9mm' },
                { l: 3, t: '轻度高弓', ai: '0.16~0.20', c: '+6~7mm' },
                { l: 4, t: '正常足', ai: '0.21~0.26', c: '+2~3mm' },
                { l: 5, t: '轻度扁平', ai: '0.27~0.31', c: '+4mm' },
                { l: 6, t: '中度扁平', ai: '0.32~0.36', c: '+6mm' },
                { l: 7, t: '重度扁平', ai: '>0.36', c: '+8mm' },
              ].map((row) => (
                <div key={row.l} className="flex items-center gap-2 text-xs py-1 px-2 rounded hover:bg-gray-50">
                  <div
                    className="w-5 h-5 rounded text-white flex items-center justify-center font-bold text-[10px]"
                    style={{ backgroundColor: getArchLevelColor(row.l) }}
                  >
                    {row.l}
                  </div>
                  <span className="w-16 font-medium">{row.t}</span>
                  <span className="w-20 text-muted-foreground">AI {row.ai}</span>
                  <span className="font-mono text-muted-foreground">{row.c}</span>
                </div>
              ))}
            </div>

            <p className="mt-3 text-[11px] leading-5 text-muted-foreground flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>足弓指数（AI）是基于静态足印面积计算的经典指标，至今仍是判断高足弓与扁平足的金标准。</span>
            </p>

            <div className="mt-3 pt-3 border-t text-[11px] text-muted-foreground space-y-1">
              <p>• BMI &gt; 28: 足弓厚度增加1-2mm，避免支撑不足或缓冲不够</p>
              <p>• BMI &lt; 18.5: 足弓厚度减少1mm，避免压迫感过强</p>
              <p>• Level 1/7: 建议首副鞋垫采用70%矫正量</p>
              <p>• 左右脚压力偏差 &gt;4%: 自动调整基础厚度使受力对等</p>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
