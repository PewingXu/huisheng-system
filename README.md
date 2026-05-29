# Huisheng System

汇生系统是一个面向足底压力采集、可视化与分析的前后端一体化项目。系统支持通过浏览器连接硬件采集足底压力数据，并提供实时监测、数据采集、压力热力图、COP 轨迹分析、足弓指标分析和报告展示等能力。

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

## 注意事项

- 不要提交 `node_modules/`、`dist/`、日志文件、缓存文件和 `.env` 文件。
- 不要把真实用户隐私数据、硬件采集原始敏感数据、密钥或 token 提交到仓库。
- 硬件串口功能需要使用支持 Web Serial API 的浏览器，例如 Chrome 或 Edge。
