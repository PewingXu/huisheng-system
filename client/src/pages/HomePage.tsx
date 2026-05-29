/**
 * 首页/启动页
 * 设计风格：医疗科技极简主义
 * - 显示客户Logo
 * - 产品介绍
 * - 开始按钮
 */

import { Button } from '@/components/ui/button';
import { ArrowRight, Activity, Shield, Zap } from 'lucide-react';
import { motion } from 'framer-motion';

interface HomePageProps {
  onStart: () => void;
}

const features = [
  {
    icon: Activity,
    title: '精准采集',
    description: '高精度传感器实时采集足底压力分布数据',
  },
  {
    icon: Shield,
    title: '专业分析',
    description: '基于医学标准的足部健康评估体系',
  },
  {
    icon: Zap,
    title: '智能方案',
    description: '自动生成个性化矫正鞋垫3D打印文件',
  },
];

export default function HomePage({ onStart }: HomePageProps) {
  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* 背景图 */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30"
        style={{
          backgroundImage: `url('/images/medical-hero-bg.webp')`,
        }}
      />

      {/* 主内容 */}
      <div className="relative z-10 min-h-screen flex">
        {/* 左侧内容 */}
        <div className="flex-1 flex flex-col justify-center px-12 lg:px-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            {/* Logo */}
            <div className="flex items-center gap-4 mb-8">
              <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center shadow-lg">
                <span className="text-primary-foreground font-bold text-3xl">汇</span>
              </div>
              <div>
                <h1 className="text-4xl font-bold text-foreground">汇盛</h1>
                <p className="text-muted-foreground">HUISHENG</p>
              </div>
            </div>

            {/* 标题 */}
            <h2 className="text-3xl lg:text-4xl font-bold text-foreground mb-4 leading-tight">
              足底压力采集系统
            </h2>
            <p className="text-lg text-muted-foreground mb-8 max-w-lg">
              专业的足部健康评估与个性化矫正方案生成平台，
              帮助您精准分析足底压力分布，定制专属鞋垫。
            </p>

            {/* 开始按钮 */}
            <Button
              size="lg"
              onClick={onStart}
              className="group text-lg px-8 py-6 rounded-xl shadow-lg hover:shadow-xl transition-all"
            >
              开始采集
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Button>
          </motion.div>

          {/* 特性介绍 */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mt-16 grid grid-cols-3 gap-6"
          >
            {features.map((feature, index) => {
              const Icon = feature.icon;
              return (
                <div key={index} className="group">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-3 group-hover:bg-primary/20 transition-colors">
                    <Icon className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="font-semibold text-foreground mb-1">
                    {feature.title}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {feature.description}
                  </p>
                </div>
              );
            })}
          </motion.div>
        </div>

        {/* 右侧图片展示 */}
        <motion.div
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="hidden lg:flex flex-1 items-center justify-center p-12"
        >
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent rounded-3xl blur-3xl" />
            <img
              src="/images/foot-pressure-realtime.webp"
              alt="足底压力监测"
              className="relative rounded-2xl shadow-2xl max-w-md"
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}
