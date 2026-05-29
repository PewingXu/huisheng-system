# 汇盛足底压力采集与分析系统 — 项目复现教程

## 第一章：技术栈概览

本项目是一个**前后端分离**的足底压力采集与分析系统，涵盖硬件通信、3D可视化、医学算法、报告生成等多个领域。

### 1.1 前端技术

| 技术 | 版本 | 用途 |
|------|------|------|
| **React** | 19.x | UI 框架，组件化开发 |
| **TypeScript** | 5.6 | 类型安全的 JavaScript 超集 |
| **Vite** | 7.x | 构建工具，开发服务器，HMR 热更新 |
| **Tailwind CSS** | 4.x | 原子化 CSS 框架，快速样式开发 |
| **Framer Motion** | 12.x | React 动画库，页面过渡和交互动画 |
| **Three.js** | 0.182 | 3D 渲染引擎，足底压力 3D 可视化 |
| **@react-three/fiber** | — | Three.js 的 React 封装 |
| **Recharts** | 2.15 | React 图表库，柱状图/饼图/折线图 |
| **Radix UI + shadcn/ui** | — | 无障碍 UI 组件库（按钮、对话框、表单等） |
| **Wouter** | 3.3 | 轻量级路由（替代 React Router） |
| **Web Serial API** | — | 浏览器原生串口通信，连接硬件传感器 |

### 1.2 后端技术

| 技术 | 版本 | 用途 |
|------|------|------|
| **FastAPI** | 0.115 | Python Web 框架，提供 REST API |
| **Uvicorn** | 0.30 | ASGI 服务器，运行 FastAPI |
| **NumPy** | 1.26 | 数值计算，矩阵运算 |
| **Pandas** | 2.2 | 数据处理，CSV 读取 |
| **SciPy** | 1.14 | 科学计算，置信椭圆、样本熵 |
| **Matplotlib** | 3.9 | 图表绘制，生成分析图片 |
| **Seaborn** | 0.13 | 统计可视化，热力图 |
| **OpenCV** | 4.10 | 图像处理，连通域检测 |
| **PyInstaller** | 6.10 | 打包为独立 exe，无需 Python 环境 |

### 1.3 硬件接口

- **传感器**: 64×64 压力传感器阵列（共 4096 个采样点）
- **通信协议**: 串口通信，波特率 6,000,000 bps
- **数据格式**: 每帧 4100 字节（4096 数据 + 4 字节帧尾 `0xAA 0x55 0x03 0x99`）
- **空间分辨率**: 每格 7mm（`PITCH_MM = 7.0`）

### 1.4 核心算法

- **足弓分析**: Clarke 指数、Staheli 指数
- **COP 分析**: 压力中心轨迹长度、活动面积、最大摆幅、偏移速度
- **区域分析**: 前足/中足/后足 压力占比和面积占比
- **信号处理**: 连通域检测、高斯滤波、样本熵

---

## 第二章：项目目录结构

```
huisheng-prototype/
│
├── client/                          # ===== 前端源代码 =====
│   └── src/
│       ├── main.tsx                 # React 渲染入口
│       ├── App.tsx                  # 应用主入口（路由配置）
│       ├── index.css                # 全局样式（Tailwind）
│       │
│       ├── pages/                   # 页面组件（按业务流程排列）
│       │   ├── PrototypeApp.tsx     # 主应用容器（步骤导航）
│       │   ├── HomePage.tsx         # 首页（品牌介绍）
│       │   ├── CreateUserPage.tsx   # 创建用户（表单录入）
│       │   ├── RealtimePage.tsx     # 实时监测（3D + 串口）
│       │   ├── CollectionPage.tsx   # 数据采集（定时采集 + CSV导入）
│       │   ├── ReportPage.tsx       # 分析报告（核心展示页）
│       │   └── SolutionPage.tsx     # 解决方案（3D鞋垫）
│       │
│       ├── lib/                     # 核心算法和工具库
│       │   ├── FootAnalysis.ts      # 足底压力分析算法（前端JS版）
│       │   ├── pythonApi.ts         # Python 后端 API 调用
│       │   ├── SerialService.ts     # 串口通信服务
│       │   └── utils.ts            # 通用工具函数
│       │
│       ├── components/              # 可复用组件
│       │   ├── Scene.tsx            # Three.js 3D 场景容器
│       │   ├── InsoleModel.tsx      # 3D 鞋垫模型（压力热力图）
│       │   ├── InsoleViewer3D.tsx   # 3D 鞋垫查看器（方案页）
│       │   ├── Sidebar.tsx          # 侧边栏步骤导航
│       │   └── ui/                  # shadcn/ui 组件库（50+组件）
│       │
│       ├── contexts/                # React Context 全局状态
│       │   ├── AppContext.tsx       # 应用状态（用户、采集数据、步骤）
│       │   └── ThemeContext.tsx     # 主题切换（明/暗）
│       │
│       └── hooks/                   # 自定义 Hooks
│           └── useMobile.tsx        # 移动端检测
│
├── OneStep_report.py                # ===== Python 核心算法（3000+行）=====
├── api_server.py                    # FastAPI 后端服务器
├── heatmap_renderer.py              # 热力图渲染器（Playwright）
├── OneStep_template.py              # PDF 报告模板生成器
│
├── vite.config.ts                   # Vite 构建配置（含 Python 自启动插件）
├── package.json                     # Node.js 项目配置
├── requirements.txt                 # Python 依赖清单
├── build_api.bat                    # PyInstaller 打包脚本
└── sit2026-1-27 14-00-59.csv        # 示例数据文件
```

---

## 第三章：从零开始 — 环境搭建

### 3.1 前置要求

1. **Node.js** 18+ （推荐 20.x）
2. **pnpm** 包管理器：`npm install -g pnpm`
3. **Python** 3.9 ~ 3.13（推荐 Anaconda，避免系统 Python 版本问题）
4. **浏览器**: Chrome 或 Edge（需要 Web Serial API 支持）

### 3.2 安装步骤

```bash
# 1. 进入项目目录
cd huisheng-prototype

# 2. 安装前端依赖
pnpm install

# 3. 安装 Python 依赖（使用 Anaconda 环境）
pip install -r requirements.txt

# 4. 一键启动（前端 + Python 后端同时启动）
pnpm dev

# 5. 浏览器访问
# http://localhost:3000
```

### 3.3 启动流程说明

执行 `pnpm dev` 后，Vite 插件 `vitePluginPythonApi`（定义在 `vite.config.ts`）会：
1. 自动检测 Python 环境（优先 Anaconda → 系统 Python → 打包 exe）
2. 启动 `api_server.py`（FastAPI，端口 8765）
3. 配置 Vite 代理：`/pyapi` → `http://127.0.0.1:8765`
4. 启动 Vite 开发服务器（端口 3000）

用户只需访问 `http://localhost:3000`，Python 后端对用户透明。

---

## 第四章：前端核心文件详解

### 4.1 入口文件

#### `client/src/main.tsx` — React 渲染入口
- 创建 React 根节点，渲染 `<App />` 组件

#### `client/src/App.tsx` — 应用主入口
- 配置路由（Wouter）
- 包裹全局 Context Provider（AppContext, ThemeContext）
- 定义页面路由映射

---

### 4.2 页面组件（按业务流程）

#### `pages/PrototypeApp.tsx` — 主应用容器
- **功能**: 整合所有页面，管理步骤导航
- **核心逻辑**: 根据 `currentStep` 状态渲染对应页面
- **包含**: Sidebar 侧边栏 + 页面内容区

#### `pages/HomePage.tsx` — 首页
- **功能**: 品牌展示，产品介绍
- **特性**: 动画入场效果，三大特性卡片

#### `pages/CreateUserPage.tsx` — 创建用户
- **功能**: 录入受试者信息（姓名、年龄、性别、身高、体重）
- **技术**: React Hook Form + Zod 表单验证

#### `pages/RealtimePage.tsx` — 实时监测
- **功能**: 实时显示传感器数据
- **关键技术**:
  - `SerialService` 连接硬件串口
  - `Scene` + `InsoleModel` 3D 实时渲染
  - `Recharts` 实时波形图
- **参数调节**: 镜像开关、滤波阈值、裁剪范围

#### `pages/CollectionPage.tsx` — 数据采集
- **功能**: 定时采集足底压力数据
- **采集模式**:
  - 静态采集（站立 5 秒）
  - 动态采集（行走 10 秒）
- **CSV 导入**: `handleFileUpload()` 解析 CSV 文件
- **数据存储**: 采集的帧数据存入 `AppContext.collectedData`

#### `pages/ReportPage.tsx` — 分析报告（核心页面）
- **功能**: 展示完整的足底压力分析报告
- **数据来源**（双引擎）:
  1. **Python 后端**（优先）: 调用 `analyzePython()` → `convertPythonResult()`
  2. **前端 JS**（降级）: 调用 `generateFootReport()`
- **展示内容**:
  - 足弓分析（AI 指数、足弓类型）
  - 足弓区域分布图（Python 生成的 `arch_regions.png`）
  - COP 压力中心轨迹（Python 生成的 `cop_trajectory.png`）
  - COP 平衡指标（轨迹长度、活动面积、摆幅等）
  - 区域压力分布饼图
  - 左右脚对比
- **关键组件**:
  - `PressureHeatmap` — Canvas 绘制压力热力图
  - `SingleFootCOPChart` — Canvas 绘制 COP 轨迹
  - `ArchTypeIndicator` — 足弓类型指示器

#### `pages/SolutionPage.tsx` — 解决方案
- **功能**: 3D 鞋垫模型展示
- **特性**: 360° 旋转、颜色切换、参数标注、STL 下载

---

### 4.3 核心算法库

#### `lib/FootAnalysis.ts` — 足底压力分析算法（前端 JS 版）

这是 Python `OneStep_report.py` 的 JavaScript 移植版本，作为 Python 后端不可用时的降级方案。

**常量**:
```typescript
PITCH_MM = 7.0    // 传感器间距 7mm
GRID_SIZE = 64    // 64×64 矩阵
```

**核心函数**:

| 函数 | 功能 |
|------|------|
| `parseFrameData(frame)` | 将 4096 长度的一维数组解析为 64×64 矩阵 |
| `preprocessData(matrix)` | 数据预处理（旋转、镜像、去噪） |
| `extractFootData(matrix, side)` | 从全矩阵中提取左脚或右脚数据 |
| `calculateCOP(footData)` | 计算单帧压力中心坐标 |
| `analyzeArch(footData)` | 足弓分析（Clarke 指数） |
| `analyzeRegionPressure(footData)` | 前/中/后足区域压力分析 |
| `calculateCOPMetrics(trajectory, fps)` | 计算 COP 指标（轨迹长度、面积、摆幅等） |
| `generateFootReport(frames, fps)` | **主入口** — 生成完整分析报告 |

**数据流**: `frames[]` → `parseFrameData` → `preprocessData` → `extractFootData` → 各分析函数 → `FootReport`

#### `lib/pythonApi.ts` — Python 后端 API 调用

**核心函数**:

| 函数 | 功能 |
|------|------|
| `checkPythonBackend()` | 检查 Python 后端是否可用（GET /health） |
| `analyzePython(frames, fps)` | 发送帧数据到后端分析（POST /analyze） |
| `convertPythonResult(result)` | 将 Python 返回结果转换为前端 `FootReport` 格式 |

**返回数据**:
- `data` — 分析指标（COP 指标、足弓特征、区域压力等）
- `images` — base64 编码的图片（轨迹图、区域图、热力图等）

#### `lib/SerialService.ts` — 串口通信服务

**核心属性**:
```typescript
ROWS = 64, COLS = 64     // 传感器尺寸
DATA_SIZE = 4096          // 每帧数据量
FOOTER = [0xAA, 0x55, 0x03, 0x99]  // 帧尾标识
baudRate = 6_000_000      // 波特率 600 万
```

**核心方法**:

| 方法 | 功能 |
|------|------|
| `connect()` | 打开串口连接（Web Serial API） |
| `disconnect()` | 断开连接 |
| `setOnData(callback)` | 注册数据回调（每帧触发） |
| `readLoop()` | 持续读取串口数据，解析帧格式 |

---

### 4.4 全局状态管理

#### `contexts/AppContext.tsx`

**状态**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `currentStep` | number | 当前步骤（0~4） |
| `currentUser` | object | 用户信息 |
| `isCollecting` | boolean | 是否正在采集 |
| `collectedData` | number[][] | 采集的帧数据 |
| `collectionProgress` | number | 采集进度 |

**方法**: `setCurrentStep()`, `addCollectedFrame()`, `setCollectedData()`, `clearCollectedData()`, `resetApp()`

---

## 第五章：Python 后端详解

### 5.1 `api_server.py` — FastAPI 服务器

**职责**: 封装 `OneStep_report.py` 的计算逻辑，提供 HTTP API 供前端调用。

**API 端点**:

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/analyze` | 接收帧数据进行分析 |
| POST | `/analyze-csv` | 接收 CSV 文本进行分析 |

**核心函数**:

| 函数 | 功能 |
|------|------|
| `run_analysis(raw_data, fps, threshold_ratio)` | 执行完整分析流程，返回指标 + base64 图片 |
| `numpy_to_python(obj)` | 递归将 NumPy 类型转为 Python 原生类型 |
| `read_image_as_base64(path)` | 读取 PNG 文件转为 base64 data URI |

**图片生成流程**:
1. 创建临时目录
2. 调用 `cal_cop_fromData(save_pdf_path=tmp_pdf)` 触发图片生成
3. 读取生成的 PNG 文件（`arch_regions.png`, `cop_trajectory.png` 等）
4. 转为 base64 返回给前端
5. 清理临时目录（不保留本地文件）

**关键设计**:
- `matplotlib.use('Agg')` — 无头模式，服务器不弹窗
- `heatmap_renderer` mock — 避免 Playwright 依赖
- UTF-8 编码包装 — 解决 Windows GBK 编码问题
- 同步 endpoint（`def` 而非 `async def`）— 避免 `asyncio.run()` 事件循环冲突

---

### 5.2 `OneStep_report.py` — 核心分析算法（3000+ 行）

这是整个系统的**算法核心**，实现了完整的足底压力分析流程。

#### 数据加载与预处理

| 函数 | 功能 |
|------|------|
| `load_csv_data(file_path)` | 读取 CSV 文件，返回二维数组 |
| `preprocess_origin_data(data_array, ...)` | 完整预处理：旋转、镜像、去噪、连通域检测、BBox 裁剪 |
| `preprocess_data_array(data_array)` | 简化预处理（内部使用） |

#### COP 计算

| 函数 | 功能 |
|------|------|
| `calculate_cop_corrected(pressure_grid, isRight)` | 计算单帧压力中心（加权质心法） |
| `calculate_cop_trajectories(df, left_curve, right_curve)` | 计算多帧 COP 轨迹 |
| `calculate_cop_metrics(cop_trajectory, dt)` | 计算 COP 指标：轨迹长度、活动面积、最大摆幅、偏移速度等 |
| `calculate_cop_time_series(left_cop, right_cop, additional_data)` | 计算时间序列 COP 指标（英文键名，供前端使用） |

#### 足弓分析

| 函数 | 功能 |
|------|------|
| `calculate_clarke(section_coords, isRight)` | Clarke 足弓指数 |
| `calculate_staheli(section_coords, isRight)` | Staheli 足弓指数 |
| `calculate_single_frame_arch_features(frame_data)` | 单帧足弓特征 |
| `calculate_multi_frame_arch_features(data_array, peak_index)` | 多帧足弓特征（取峰值帧） |
| `calculate_complete_arch_features(data_array)` | 完整足弓分析入口 |

#### 区域分析

| 函数 | 功能 |
|------|------|
| `divide_x_regions(half_max_area)` | 将足底划分为前足/中足/后足 |
| `calculate_region_areas(section_coords)` | 计算各区域面积 |
| `calculate_region_pressures(section_coords, matrix)` | 计算各区域压力占比 |

#### 可视化与报告

| 函数 | 功能 |
|------|------|
| `visualize_foot_regions(ax, section_coords, ...)` | 绘制足弓区域划分图 |
| `draw_confidence_ellipse(ax, cop_trajectory)` | 绘制 COP 置信椭圆 |
| `create_pdf_report(left_cop, right_cop, arch_results, ...)` | 生成完整 PDF 报告 + PNG 图片 |

#### 主入口函数

```python
cal_cop_fromData(data_array, threshold_ratio=0.8, fps=42,
                 show_plots=False, save_pdf_path=None)
```

这是整个算法的**主入口**，调用流程：
1. `preprocess_data_array()` — 数据预处理
2. `extract_pressure_curves()` — 提取压力曲线
3. `calculate_cop_trajectories()` — 计算 COP 轨迹
4. `calculate_cop_metrics()` — 计算 COP 指标
5. `calculate_complete_arch_features()` — 足弓分析
6. `calculate_sway_features()` — 摇摆特征
7. `create_pdf_report()` — 生成报告和图片

---

## 第六章：数据流全链路

```
硬件传感器 (64×64)
    │
    ▼ Web Serial API
SerialService.ts ──→ readLoop() 解析帧数据
    │
    ▼ addCollectedFrame()
AppContext.collectedData (number[][])
    │
    ▼ 进入报告页
ReportPage.tsx
    │
    ├──→ [优先] pythonApi.ts → POST /pyapi/analyze
    │         │
    │         ▼
    │    api_server.py → run_analysis()
    │         │
    │         ▼
    │    OneStep_report.py → cal_cop_fromData()
    │         │
    │         ▼
    │    返回: { data: 分析指标, images: base64图片 }
    │         │
    │         ▼
    │    convertPythonResult() → FootReport
    │
    └──→ [降级] FootAnalysis.ts → generateFootReport()
              │
              ▼
         FootReport → 渲染报告页面
```

---

## 第七章：关键配置文件

### 7.1 `vite.config.ts`

**核心配置**:
- **路径别名**: `@/` → `client/src/`
- **开发服务器**: 端口 3000，允许局域网访问
- **代理**: `/pyapi` → `http://127.0.0.1:8765`
- **自定义插件 `vitePluginPythonApi`**: 自动启动 Python 后端

### 7.2 `package.json`

**常用命令**:
```bash
pnpm dev      # 启动开发服务器（含 Python 后端）
pnpm build    # 构建生产版本
pnpm start    # 启动生产服务器
pnpm check    # TypeScript 类型检查
```

### 7.3 `requirements.txt`

Python 依赖清单，使用 `pip install -r requirements.txt` 安装。

---

## 第八章：建议阅读顺序

如果你是第一次接触这个项目，建议按以下顺序阅读代码：

### 第一步：理解数据源
1. **`lib/SerialService.ts`** — 了解硬件数据如何进入系统
2. **`sit2026-1-27 14-00-59.csv`** — 查看原始数据格式

### 第二步：理解数据流
3. **`contexts/AppContext.tsx`** — 了解全局状态管理
4. **`pages/CollectionPage.tsx`** — 了解数据采集和 CSV 导入

### 第三步：理解核心算法
5. **`lib/FootAnalysis.ts`** — 前端版算法（较短，适合入门）
6. **`OneStep_report.py`** — Python 版完整算法（重点阅读）
   - 先看 `cal_cop_fromData()` 主入口
   - 再看各子函数

### 第四步：理解前后端通信
7. **`api_server.py`** — FastAPI 服务器
8. **`lib/pythonApi.ts`** — 前端 API 调用
9. **`vite.config.ts`** — 代理配置和 Python 自启动

### 第五步：理解页面展示
10. **`pages/ReportPage.tsx`** — 报告页（最复杂的页面）
11. **`pages/RealtimePage.tsx`** — 实时监测页（3D 渲染）
12. **`pages/SolutionPage.tsx`** — 解决方案页（3D 鞋垫）

### 第六步：理解 3D 渲染
13. **`components/Scene.tsx`** — Three.js 场景
14. **`components/InsoleModel.tsx`** — 3D 鞋垫模型

---

## 附录：常见问题

### Q: Python 3.14 报错怎么办？
A: 系统 Python 3.14 alpha 与 pydantic_core 不兼容。请使用 Anaconda Python 3.13 或更低版本。`vite.config.ts` 中已配置优先使用 Anaconda。

### Q: 前端显示 "JS" 标识而非 "Python"？
A: 说明 Python 后端未启动或不可用。检查终端是否有 `[Python API] Uvicorn running` 日志。

### Q: 串口连接不上？
A: 确保使用 Chrome/Edge 浏览器，且传感器已通过 USB 连接。Web Serial API 不支持 Firefox/Safari。

### Q: 如何打包为独立应用？
A: 运行 `build_api.bat`，PyInstaller 会将 Python 环境和依赖打包为 `dist/huisheng_api/huisheng_api.exe`。
