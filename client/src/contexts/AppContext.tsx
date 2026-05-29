import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

// 用户数据类型
export interface UserData {
  id: string;
  name: string;
  createdAt: Date;
}

// 足部数据类型
export interface FootData {
  footLength: number;
  footWidth: number;
  pronation: 'normal' | 'over' | 'under';
  archHeight: 'low' | 'normal' | 'high';
}

// 压力数据类型
export interface PressureData {
  peakPressure: number;
  avgPressure: number;
  totalPressure: number;
  peakArea: number;
  avgArea: number;
  leftRightRatio: number;
  frontBackRatio: number;
}

// 报告数据类型
export interface ReportData {
  user: UserData;
  leftFoot: FootData;
  rightFoot: FootData;
  leftPressure: PressureData;
  rightPressure: PressureData;
  timestamp: Date;
}

// 足底分析报告数据（精确值，用于解决方案联动）
export interface FootAnalysisResult {
  left: {
    archIndex: number;       // 足弓指数 AI
    archType: string;        // 足弓类型描述
    footLength: number;      // 足长 cm
    footWidth: number;       // 足宽 cm
    totalPressure: number;   // 总压力
  };
  right: {
    archIndex: number;
    archType: string;
    footLength: number;
    footWidth: number;
    totalPressure: number;
  };
  bilateral: {
    leftPressureRatio: number;
    rightPressureRatio: number;
  };
}

// 应用状态类型
interface AppState {
  currentStep: number;
  currentUser: UserData | null;
  isCollecting: boolean;
  collectionProgress: number;
  reportData: ReportData | null;
  footAnalysis: FootAnalysisResult | null; // 精确的足底分析结果
  collectedData: number[][]; // 采集的帧数据 (每帧4096个数据点)
}

// Context类型
interface AppContextType {
  state: AppState;
  setCurrentStep: (step: number) => void;
  setCurrentUser: (user: UserData | null) => void;
  startCollection: () => void;
  stopCollection: () => void;
  setCollectionProgress: (progress: number) => void;
  setReportData: (data: ReportData | null) => void;
  setFootAnalysis: (data: FootAnalysisResult | null) => void;
  addCollectedFrame: (frame: number[]) => void;
  setCollectedData: (data: number[][]) => void;
  clearCollectedData: () => void;
  resetApp: () => void;
}

const initialState: AppState = {
  currentStep: 0,
  currentUser: null,
  isCollecting: false,
  collectionProgress: 0,
  reportData: null,
  footAnalysis: null,
  collectedData: [],
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);

  const setCurrentStep = useCallback((step: number) => {
    setState(prev => ({ ...prev, currentStep: step }));
  }, []);

  const setCurrentUser = useCallback((user: UserData | null) => {
    setState(prev => ({ ...prev, currentUser: user }));
  }, []);

  const startCollection = useCallback(() => {
    setState(prev => ({ ...prev, isCollecting: true, collectionProgress: 0, collectedData: [] }));
  }, []);

  const stopCollection = useCallback(() => {
    setState(prev => ({ ...prev, isCollecting: false }));
  }, []);

  const setCollectionProgress = useCallback((progress: number) => {
    setState(prev => ({ ...prev, collectionProgress: progress }));
  }, []);

  const setReportData = useCallback((data: ReportData | null) => {
    setState(prev => ({ ...prev, reportData: data }));
  }, []);

  const setFootAnalysis = useCallback((data: FootAnalysisResult | null) => {
    setState(prev => ({ ...prev, footAnalysis: data }));
  }, []);

  const addCollectedFrame = useCallback((frame: number[]) => {
    setState(prev => ({
      ...prev,
      collectedData: [...prev.collectedData, frame],
    }));
  }, []);

  const setCollectedData = useCallback((data: number[][]) => {
    setState(prev => ({ ...prev, collectedData: data }));
  }, []);

  const clearCollectedData = useCallback(() => {
    setState(prev => ({ ...prev, collectedData: [] }));
  }, []);

  const resetApp = useCallback(() => {
    setState(initialState);
  }, []);

  return (
    <AppContext.Provider
      value={{
        state,
        setCurrentStep,
        setCurrentUser,
        startCollection,
        stopCollection,
        setCollectionProgress,
        setReportData,
        setFootAnalysis,
        addCollectedFrame,
        setCollectedData,
        clearCollectedData,
        resetApp,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
