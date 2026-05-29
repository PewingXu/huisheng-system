"""
FastAPI 后端服务 - 封装 OneStep_report.py 的计算逻辑
供前端系统调用，确保计算结果与 Python 完全一致
"""

import sys
import os
import io

# 修复 Windows GBK 编码问题（OneStep_report.py 中有 emoji 字符）
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import json
import tempfile
import traceback
import base64
import shutil
import numpy as np
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

# 设置 matplotlib 为无头模式（必须在 OneStep_report 导入前）
import matplotlib
matplotlib.use('Agg')

# 确保能导入同目录下的模块
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# heatmap_renderer 依赖 playwright（仅 PDF 报告需要），API 服务不需要
# 如果 playwright 未安装，提供一个空的 mock 避免导入失败
try:
    import playwright  # noqa: F401
except ImportError:
    import types
    mock_module = types.ModuleType("heatmap_renderer")
    async def _noop(*args, **kwargs): return None
    mock_module.generate_heatmap_png = _noop  # type: ignore
    sys.modules["heatmap_renderer"] = mock_module

from OneStep_report import (
    load_csv_data,
    preprocess_origin_data,
    cal_cop_fromData,
    calculate_cop_time_series,
)

app = FastAPI(title="HuiSheng Foot Analysis API", version="1.0.0")

# 允许前端跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class AnalyzeRequest(BaseModel):
    """分析请求：接收原始帧数据（每帧4096个值的二维数组）"""
    frames: List[List[float]]
    fps: float = 42
    threshold_ratio: float = 0.8


class AnalyzeCSVRequest(BaseModel):
    """分析请求：接收 CSV 文本内容"""
    csv_content: str
    fps: float = 42
    threshold_ratio: float = 0.8


def numpy_to_python(obj):
    """递归将 numpy 类型转换为 Python 原生类型，以便 JSON 序列化"""
    if isinstance(obj, dict):
        return {k: numpy_to_python(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [numpy_to_python(item) for item in obj]
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (np.floating,)):
        return float(obj)
    elif isinstance(obj, np.bool_):
        return bool(obj)
    return obj


def read_image_as_base64(path: str) -> str:
    """读取图片文件并转为 base64 data URI"""
    with open(path, "rb") as f:
        data = f.read()
    return "data:image/png;base64," + base64.b64encode(data).decode("ascii")


# 新 A 板左右半区与旧板相反。默认在统一预处理后交换左右 32 列，
# 让后续 left_foot / right_foot / left_cop / right_cop 都表示真实左右脚。
SWAP_LEFT_RIGHT_HALVES = os.getenv("FOOT_PRESSURE_SWAP_LR", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
}

# 新 A 板每只脚在各自 32 列半区内的内外侧方向也与旧板相反。
# 默认在左右脚归位后，对每只脚自己的半区再做一次水平镜像。
MIRROR_EACH_FOOT_HALF = os.getenv("FOOT_PRESSURE_MIRROR_EACH_FOOT", "1").lower() not in {
    "0",
    "false",
    "no",
    "off",
}


def swap_left_right_halves(frames):
    """交换每帧 64x64 矩阵的左右 32 列。"""
    arr = np.array(frames, dtype=float)
    if arr.size == 0:
        return frames
    arr = arr.reshape(-1, 64, 64)
    arr = np.concatenate([arr[:, :, 32:], arr[:, :, :32]], axis=2)
    return arr.reshape(-1, 4096).tolist()


def mirror_each_foot_half(frames):
    """分别镜像左脚半区(0-31列)和右脚半区(32-63列)。"""
    arr = np.array(frames, dtype=float)
    if arr.size == 0:
        return frames
    arr = arr.reshape(-1, 64, 64)
    left = arr[:, :, :32][:, :, ::-1]
    right = arr[:, :, 32:][:, :, ::-1]
    arr = np.concatenate([left, right], axis=2)
    return arr.reshape(-1, 4096).tolist()


def run_analysis(raw_data, fps=42, threshold_ratio=0.8):
    """执行完整的分析流程，返回可 JSON 序列化的结果 + base64 图片"""
    # 预处理（与 OneStep_report.py __main__ 一致）
    processed_data = preprocess_origin_data(
        raw_data,
        rotate_90_ccw=True,
        mirrored_horizon=True,
        mirrored_vertical=True,
        apply_denoise=True,
        small_comp_min_size=3,
        small_comp_connectivity=4,
        margin=0,
        multi_component_mode=True,
        multi_component_top_n=3,
        multi_component_min_size=10,
    )
    if SWAP_LEFT_RIGHT_HALVES:
        processed_data = swap_left_right_halves(processed_data)
    if MIRROR_EACH_FOOT_HALF:
        processed_data = mirror_each_foot_half(processed_data)

    # 使用临时目录生成图片
    tmp_dir = tempfile.mkdtemp(prefix="huisheng_api_")
    tmp_pdf = os.path.join(tmp_dir, "report.pdf")

    try:
        # 分析（传入 save_pdf_path 以触发图片生成）
        results = cal_cop_fromData(
            processed_data,
            show_plots=False,
            save_pdf_path=tmp_pdf,
            rotate_data=False,
            fps=fps,
            threshold_ratio=threshold_ratio,
        )

        # 读取生成的 PNG 图片转为 base64
        images = {}
        image_files = {
            "cop_trajectory": os.path.join(tmp_dir, "cop_trajectory.png"),
            "arch_regions": os.path.join(tmp_dir, "arch_regions.png"),
            "heatmap_internal": os.path.join(tmp_dir, "heatmap_internal.png"),
            "velocity_series": os.path.join(tmp_dir, "velocity_series.png"),
            "confidence_ellipse": os.path.join(tmp_dir, "confidence_ellipse.png"),
        }
        for key, path in image_files.items():
            if os.path.exists(path):
                images[key] = read_image_as_base64(path)

    finally:
        # 清理临时目录（图片已读入内存，不保留本地文件）
        shutil.rmtree(tmp_dir, ignore_errors=True)

    # 转换为可序列化格式
    serializable = numpy_to_python(results)

    return {"metrics": serializable, "images": images}


@app.get("/health")
async def health_check():
    """健康检查接口"""
    return {"status": "ok", "service": "huisheng-foot-analysis"}


@app.post("/analyze")
def analyze_frames(request: AnalyzeRequest):
    """
    接收原始帧数据进行分析
    frames: 二维数组，每个元素是长度4096的一维数组
    """
    try:
        raw_data = request.frames
        if not raw_data or len(raw_data) == 0:
            raise HTTPException(status_code=400, detail="帧数据不能为空")

        # 验证每帧长度
        for i, frame in enumerate(raw_data):
            if len(frame) != 4096:
                raise HTTPException(
                    status_code=400,
                    detail=f"第 {i} 帧数据长度为 {len(frame)}，应为 4096",
                )

        result = run_analysis(
            raw_data,
            fps=request.fps,
            threshold_ratio=request.threshold_ratio,
        )
        return {"success": True, "data": result["metrics"], "images": result["images"]}

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/analyze-csv")
def analyze_csv(request: AnalyzeCSVRequest):
    """
    接收 CSV 文本内容进行分析
    csv_content: CSV 文件的完整文本内容
    """
    try:
        if not request.csv_content.strip():
            raise HTTPException(status_code=400, detail="CSV 内容不能为空")

        # 写入临时文件供 load_csv_data 读取
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, encoding="utf-8"
        ) as f:
            f.write(request.csv_content)
            tmp_path = f.name

        try:
            raw_data = load_csv_data(tmp_path)
            result = run_analysis(
                raw_data,
                fps=request.fps,
                threshold_ratio=request.threshold_ratio,
            )
            return {"success": True, "data": result["metrics"], "images": result["images"]}
        finally:
            os.unlink(tmp_path)

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PYTHON_API_PORT", 8766))
    print(f"Starting HuiSheng Foot Analysis API on port {port}...")
    uvicorn.run(app, host="127.0.0.1", port=port)
