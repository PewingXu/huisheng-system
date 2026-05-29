/**
 * 侧边栏导航组件
 * 设计风格：医疗科技极简主义
 * - 固定左侧导航
 * - 清晰的步骤指示
 * - 医疗蓝主色调
 */

import { useApp } from '@/contexts/AppContext';
import { cn } from '@/lib/utils';
import {
  User,
  Activity,
  Radio,
  FileText,
  Lightbulb,
  Home,
  ChevronRight,
} from 'lucide-react';

const steps = [
  { id: 0, label: '首页', icon: Home, path: '/' },
  { id: 1, label: '创建用户', icon: User, path: '/create-user' },
  { id: 2, label: '实时展示', icon: Activity, path: '/realtime' },
  { id: 3, label: '数据采集', icon: Radio, path: '/collection' },
  { id: 4, label: '分析报告', icon: FileText, path: '/report' },
  { id: 5, label: '解决方案', icon: Lightbulb, path: '/solution' },
];

interface SidebarProps {
  currentStep: number;
  onStepChange: (step: number) => void;
}

export default function Sidebar({ currentStep, onStepChange }: SidebarProps) {
  const { state } = useApp();

  return (
    <aside className="w-64 h-screen bg-card border-r border-border flex flex-col fixed left-0 top-0 z-40">
      {/* Logo区域 */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-lg">汇</span>
          </div>
          <div>
            <h1 className="font-semibold text-lg text-foreground">汇盛</h1>
            <p className="text-xs text-muted-foreground">足底压力采集系统</p>
          </div>
        </div>
      </div>

      {/* 导航菜单 */}
      <nav className="flex-1 p-4 overflow-y-auto">
        <div className="space-y-1">
          {steps.map((step, index) => {
            const Icon = step.icon;
            const isActive = currentStep === step.id;
            const isCompleted = currentStep > step.id;
            const isDisabled = step.id > 1 && !state.currentUser && step.id !== 0;

            return (
              <button
                key={step.id}
                onClick={() => !isDisabled && onStepChange(step.id)}
                disabled={isDisabled}
                className={cn(
                  'nav-item w-full text-left group',
                  isActive && 'active',
                  isCompleted && 'text-[var(--health-green)]',
                  isDisabled && 'opacity-40 cursor-not-allowed'
                )}
              >
                <div
                  className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
                    isActive && 'bg-primary text-primary-foreground',
                    isCompleted && !isActive && 'bg-[var(--health-green-light)] text-[var(--health-green)]',
                    !isActive && !isCompleted && 'bg-muted'
                  )}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <span className="flex-1">{step.label}</span>
                {isActive && (
                  <ChevronRight className="w-4 h-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>
            );
          })}
        </div>
      </nav>

      {/* 用户信息 */}
      {state.currentUser && (
        <div className="p-4 border-t border-border">
          <div className="bg-secondary/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">当前用户</p>
            <p className="font-medium text-foreground truncate">
              {state.currentUser.name}
            </p>
          </div>
        </div>
      )}

      {/* 版本信息 */}
      <div className="p-4 border-t border-border">
        <p className="text-xs text-muted-foreground text-center">
          产品原型 v1.0
        </p>
      </div>
    </aside>
  );
}
