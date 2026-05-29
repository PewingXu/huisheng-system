/**
 * 产品原型主应用
 * 整合侧边栏导航和所有功能页面
 */

import { useState } from 'react';
import { useApp } from '@/contexts/AppContext';
import Sidebar from '@/components/Sidebar';
import HomePage from './HomePage';
import CreateUserPage from './CreateUserPage';
import RealtimePage from './RealtimePage';
import CollectionPage from './CollectionPage';
import ReportPage from './ReportPage';
import SolutionPage from './SolutionPage';
import { AnimatePresence, motion } from 'framer-motion';

export default function PrototypeApp() {
  const { state, setCurrentStep } = useApp();
  const [currentPage, setCurrentPage] = useState(0);

  const handleStepChange = (step: number) => {
    setCurrentPage(step);
    setCurrentStep(step);
  };

  const handleNext = () => {
    const nextStep = currentPage + 1;
    setCurrentPage(nextStep);
    setCurrentStep(nextStep);
  };

  const handleFinish = () => {
    setCurrentPage(0);
    setCurrentStep(0);
  };

  // 首页不显示侧边栏
  if (currentPage === 0) {
    return (
      <HomePage onStart={() => handleStepChange(1)} />
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      {/* 侧边栏 */}
      <Sidebar currentStep={currentPage} onStepChange={handleStepChange} />

      {/* 主内容区 */}
      <main className="flex-1 ml-64">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentPage}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3 }}
          >
            {currentPage === 1 && (
              <CreateUserPage onNext={handleNext} />
            )}
            {currentPage === 2 && (
              <RealtimePage onNext={handleNext} />
            )}
            {currentPage === 3 && (
              <CollectionPage onNext={handleNext} />
            )}
            {currentPage === 4 && (
              <ReportPage onNext={handleNext} />
            )}
            {currentPage === 5 && (
              <SolutionPage onFinish={handleFinish} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
