# Huisheng System

汇生系统是一个面向足底压力采集、可视化与分析的前后端一体化项目。系统支持通过浏览器连接硬件采集足底压力数据，并提供实时监测、数据采集、压力热力图、COP 轨迹分析、足弓指标分析和报告展示等能力。

## 项目功能

- 足底压力数据实时监测
- 64 x 64 压力矩阵数据展示与处理
- 2D 压力热力图和 3D 鞋垫模型可视化
- 用户信息录入与采集流程管理
- 静态/动态压力数据采集
- COP 压力中心轨迹分析
- 足弓、前足/中足/后足区域压力分析
- Python 算法服务分析与前端降级分析
- 分析报告页面展示

## 技术栈

前端：

- React
- TypeScript
- Vite
- Tailwind CSS
- Three.js / React Three Fiber
- Recharts
- Radix UI / shadcn ui

后端与算法：

- Python
- FastAPI
- NumPy / Pandas / SciPy
- Matplotlib
- OpenCV

硬件通信：

- Web Serial API
- 串口压力传感器数据采集

## 项目结构

```text
huisheng-system/
├── client/                 # 前端应用
│   ├── public/             # 静态资源
│   └── src/
│       ├── components/     # 通用组件和可视化组件
│       ├── contexts/       # 全局状态
│       ├── hooks/          # 自定义 hooks
│       ├── lib/            # 算法、串口、API 工具
│       └── pages/          # 页面
├── server/                 # Node/Express 服务入口
├── shared/                 # 前后端共享常量
├── api_server.py           # Python/FastAPI 分析服务
├── OneStep_report.py       # 足底压力核心分析算法
├── heatmap_renderer.py     # 热力图渲染辅助模块
├── package.json            # 前端和服务端脚本配置
├── pnpm-lock.yaml          # pnpm 锁文件
└── vite.config.ts          # Vite 配置
```

## 本地运行

安装依赖：

```powershell
pnpm install
```

启动开发环境：

```powershell
pnpm dev
```

构建生产版本：

```powershell
pnpm build
```

TypeScript 检查：

```powershell
pnpm check
```

## 开发协作

主分支 `main` 用于保存稳定版本。新功能开发请从 `main` 创建独立分支，开发完成后推送到 GitHub，并通过 Pull Request 合并回 `main`。

示例：

```powershell
git checkout main
git pull origin main
git checkout -b chunkouyin
git push -u origin chunkouyin
```

## 注意事项

- 不要提交 `node_modules/`、`dist/`、日志文件、缓存文件和 `.env` 文件。
- 不要把真实用户隐私数据、硬件采集原始敏感数据、密钥或 token 提交到仓库。
- 硬件串口功能需要使用支持 Web Serial API 的浏览器，例如 Chrome 或 Edge。
