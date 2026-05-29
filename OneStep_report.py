import sys, json, traceback
import math
import statistics
import matplotlib.pyplot as plt
import cv2
import pandas as pd
import ast
import numpy as np
from matplotlib import image as mpimg
from scipy.spatial.distance import euclidean, cdist
# from tabulate import tabulate
import seaborn as sns
import matplotlib
import json
import os
matplotlib.use('Agg')
import matplotlib.pyplot as plt

from matplotlib.colors import ListedColormap
from matplotlib.backends.backend_pdf import PdfPages
from scipy.ndimage import gaussian_filter  # 未使用，但保留你的 import
# from scipy.interpolate import griddata  # 未使用，但保留你的 import
from matplotlib.colors import LinearSegmentedColormap  # 未使用，但保留你的 import


import asyncio
from heatmap_renderer import generate_heatmap_png
from pathlib import Path

# =========================
# 全局显示设置（中文/负号）
# =========================
plt.rcParams['font.family'] =  ['Microsoft YaHei','SimSun','SimHei']
plt.rcParams['axes.unicode_minus'] = False


# =========================
# 数据假设与单位说明（强烈建议先读）
# - 每帧数据为长度4096的一维列表，可重构为64×64矩阵（行=前后x，列=左右y）
# - y方向（列）：0~31为左脚，32~63为右脚（因此右脚坐标需+32做全局对齐）
# - 压力单位：相对值，阈值≤4视为噪声置0
# - 空间单位：网格索引（格）；部分指标换算为毫米，使用 1 格 ≈ 1.4 mm
# - 时间采样：默认 12.5 Hz（dt = 0.08 s）
# 提示：面向报告请优先看 calculate_cop_time_series（单位统一）；研究/调参对比可看 calculate_cop_metrics
# =========================


def load_csv_data(file_path, progress_every=100):
    """
    读取CSV文件，返回原始数据数组

    参数:
        file_path: CSV文件路径
        progress_every: 进度打印间隔

    返回:
        list[list]: 每帧4096长度的原始数据数组
    """
    print(f"正在读取CSV文件: {file_path}")
    df = pd.read_csv(file_path)
    if 'data' not in df.columns:
        raise ValueError("CSV缺少 'data' 列")

    data_array = []
    total_rows = len(df)
    print(f"检测到 {total_rows} 帧")

    for idx, (_, row) in enumerate(df.iterrows()):
        if progress_every and idx % progress_every == 0:
            print(f"读取进度: {idx}/{total_rows}")

        try:
            arr = ast.literal_eval(row['data'])
        except Exception as e:
            print(f"第{idx}帧解析失败，跳过: {e}")
            continue

        if len(arr) != 4096:
            print(f"警告：第{idx}帧数据长度不为4096，跳过该帧")
            continue

        data_array.append(arr)

    print(f"成功读取 {len(data_array)} 帧原始数据")
    return data_array


def preprocess_origin_data(data_array,
                           rotate_90_ccw=True,
                           mirrored_horizon=True,
                           mirrored_vertical=False,
                           apply_denoise=True,
                           small_comp_min_size=3,
                           small_comp_connectivity=4,
                           margin=0,
                           multi_component_mode=True,
                           multi_component_top_n=3,
                           multi_component_min_size=50,
                           progress_every=100):
    """
    对原始数据数组进行完整预处理（旋转、镜像、去噪、连通域裁剪）

    参数:
        data_array: 原始数据数组（每帧4096长度的list）
        rotate_90_ccw: 是否逆时针旋转90度
        mirrored_horizon: 是否水平镜像
        apply_denoise: 是否应用去噪
        small_comp_min_size: 小连通域剔除的最小尺寸
        small_comp_connectivity: 连通性类型(4或8)
        margin: 连通域外接框外扩像素数
        multi_component_mode: 是否启用多连通域模式
        multi_component_top_n: 保留前N大连通域
        multi_component_min_size: 连通域最小面积阈值
        progress_every: 进度打印间隔

    返回:
        list[list]: 预处理后的数据数组（每帧4096长度）
    """
    print(f"开始预处理 {len(data_array)} 帧原始数据...")

    # ===== 工具函数定义 =====
    def largest_bboxes_multi(mask, top_n=3, min_size=50):
        """返回前N大连通域的合并外接框"""
        num_labels, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
        if num_labels <= 1:
            return None

        counts = np.bincount(labels.ravel())
        counts[0] = 0

        valid_labels = []
        for label in range(1, num_labels):
            if counts[label] >= min_size:
                valid_labels.append((label, counts[label]))

        if not valid_labels:
            return None

        valid_labels.sort(key=lambda x: x[1], reverse=True)
        top_labels = [label for label, _ in valid_labels[:top_n]]

        all_rows = []
        all_cols = []
        total_pixels = 0
        for label in top_labels:
            rr, cc = np.where(labels == label)
            all_rows.extend(rr.tolist())
            all_cols.extend(cc.tolist())
            total_pixels += counts[label]

        if not all_rows:
            return None

        return min(all_rows), max(all_rows), min(all_cols), max(all_cols), total_pixels

    def largest_bbox(mask):
        """返回最大连通域外接框"""
        num_labels, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
        if num_labels <= 1:
            return None
        counts = np.bincount(labels.ravel())
        counts[0] = 0
        max_label = int(np.argmax(counts))
        rr, cc = np.where(labels == max_label)
        return rr.min(), rr.max(), cc.min(), cc.max(), counts[max_label]

    # ===== 主处理流程 =====
    processed_data = []
    nonzero_frames = 0
    broken_foot_count = 0

    for idx, frame_data in enumerate(data_array):
        if progress_every and idx % progress_every == 0:
            print(f"预处理进度: {idx}/{len(data_array)}")

        mat = np.array(frame_data, dtype=float).reshape(64, 64)

        # 1) 几何操作：先旋转，再镜像
        if rotate_90_ccw:
            mat = np.rot90(mat, k=1)
        if mirrored_horizon:
            mat = np.fliplr(mat)
        if mirrored_vertical:  # ✅ 新增：垂直翻转
            mat = np.flipud(mat)

        if apply_denoise:
            # 2) 小连通域剔除
            mat = _remove_small_components(mat, min_size=small_comp_min_size,
                                           connectivity=small_comp_connectivity)

            # 3) 左右脚连通域裁剪
            left_half = mat[:, :32]
            right_half = mat[:, 32:]

            if multi_component_mode:
                left_bbox = largest_bboxes_multi((left_half > 0), top_n=multi_component_top_n,
                                                 min_size=multi_component_min_size)
                right_bbox = largest_bboxes_multi((right_half > 0), top_n=multi_component_top_n,
                                                  min_size=multi_component_min_size)
            else:
                left_bbox = largest_bbox((left_half > 0))
                right_bbox = largest_bbox((right_half > 0))

            keep = np.zeros_like(mat, dtype=bool)

            if left_bbox is not None:
                t, b, l, r, _ = left_bbox
                t = max(t - margin, 0)
                b = min(b + margin, 63)
                l = max(l - margin, 0)
                r = min(r + margin, 31)
                keep[t:b + 1, l:r + 1] = True

                if multi_component_mode:
                    x_coverage = (b - t) / 64
                    if x_coverage < 0.7:
                        broken_foot_count += 1

            if right_bbox is not None:
                t, b, l, r, _ = right_bbox
                t = max(t - margin, 0)
                b = min(b + margin, 63)
                l = max(l - margin, 0) + 32
                r = min(r + margin, 31) + 32
                keep[t:b + 1, l:r + 1] = True

            mat = np.where(keep, mat, 0.0)

        # 统计非零像素
        nz = int((mat > 0).sum())
        if nz > 0:
            nonzero_frames += 1
        if progress_every and idx % progress_every == 0:
            print(f"- 第{idx}帧: 非零像素={nz}")

        processed_data.append(mat.flatten().tolist())

    print(f"预处理完成: {len(processed_data)} 帧，非零帧 {nonzero_frames} 帧")
    if multi_component_mode:
        print(f"- 多连通域模式: top_n={multi_component_top_n}, min_size={multi_component_min_size}")
        if broken_foot_count > 0:
            print(f"- 检测到疑似断裂足印: {broken_foot_count} 帧")
    else:
        print(f"- 单连通域模式")
    print(
        f"- 处理顺序: 旋转 → 镜像 → 小连通域剔除(min_size={small_comp_min_size}, conn={small_comp_connectivity}) → BBox裁剪(margin={margin})")

    return processed_data

def _remove_small_components(mat: np.ndarray, min_size: int = 3, connectivity: int = 4) -> np.ndarray:
    """
    将连通域面积 < min_size 的区域视为离散点/小块并置0。
    - 连通域在二值图 (mat > 0) 上统计；
    - connectivity=4（上下左右相连）更严格，8 包含对角。
    """
    mask = (mat > 2).astype(np.uint8)
    num, lab = cv2.connectedComponents(mask, connectivity=connectivity)
    if num <= 1:
        return mat
    counts = np.bincount(lab.ravel())
    keep = np.zeros(num, dtype=bool)
    for lbl in range(1, num):
        if counts[lbl] >= min_size:
            keep[lbl] = True
    keep_mask = keep[lab]
    return np.where(keep_mask, mat, 0.0)


def preprocess_data_array(data_array, rotate_90_ccw=True, mirrored_horizon=True,mirrored_vertical=False):
    """
    预处理数据数组，可选择性地进行90度逆时针旋转或水平镜像

    参数:
        data_array: 原始数据数组，每行包含4096个压力值
        rotate_90_ccw: 是否进行90度逆时针旋转，默认True

    返回:
        processed_df: 处理后的DataFrame
    """
    processed_array = []
    for frame_data in data_array:
        if len(frame_data) != 4096:
            print(f"警告：数据长度不为4096，跳过该帧")
            continue

        # 将1D数组重构为64×64矩阵
        original_matrix = np.array(frame_data).reshape(64, 64)

        if rotate_90_ccw:
            # 逆时针旋转90°
            original_matrix = np.rot90(original_matrix, k=1)
        if mirrored_horizon:
            # 左右镜像
            original_matrix = np.fliplr(original_matrix)
        if mirrored_vertical:  # ✅ 新增：上下镜像
            original_matrix = np.flipud(original_matrix)

        # 重新展平为1D数组
        processed_frame = original_matrix.flatten().tolist()
        processed_array.append(processed_frame)

    print(f"已完成{len(processed_array)}帧数据的预处理")
    processed_df = pd.DataFrame({'data': processed_array})

    return processed_df


# =============== 性能优化1：矢量化压力曲线（替换原逐帧循环） ===============
def extract_pressure_curves(data_array, thr=2):
    """
    矢量化计算左右脚每帧非零点数（阈值>thr）
    返回：left_counts, right_counts（list）
    """
    arr = np.array(data_array, dtype=float).reshape(-1, 64, 64)
    arr = np.where(arr > thr, arr, 0)
    left = (arr[:, :, :32] != 0).sum(axis=(1, 2)).tolist()
    right = (arr[:, :, 32:] != 0).sum(axis=(1, 2)).tolist()
    return left, right


def find_pressure_peak_interval(pressure_curve, threshold_ratio=0.8):
    peak_value = max(pressure_curve)
    peak_index = pressure_curve.index(peak_value)
    threshold = peak_value * threshold_ratio
    left_index = peak_index
    while left_index > 0 and pressure_curve[left_index] >= threshold:
        left_index -= 1
    right_index = peak_index
    while right_index < len(pressure_curve) - 1 and pressure_curve[right_index] >= threshold:
        right_index += 1
    if left_index > 0:
        left_index += 1
    if right_index < len(pressure_curve) - 1:
        right_index -= 1
    return left_index, right_index


def calculate_cop_corrected(pressure_grid, isRight):
    total_pressure = 0
    weighted_x = 0
    weighted_y = 0
    rows = len(pressure_grid)
    cols = len(pressure_grid[0])
    if isRight:
        for x in range(rows):
            for y in range(cols):
                pressure = pressure_grid[x][y]
                total_pressure += pressure
                weighted_x += pressure * x
                weighted_y += pressure * (y + 32)
    else:
        for x in range(rows):
            for y in range(cols):
                pressure = pressure_grid[x][y]
                total_pressure += pressure
                weighted_x += pressure * x
                weighted_y += pressure * y
    if total_pressure <= 0:
        raise ValueError("当前无压力值")
    cop_x = weighted_x / total_pressure
    cop_y = weighted_y / total_pressure
    return cop_x, cop_y


def calculate_cop_trajectories(df, left_curve, right_curve, threshold_ratio):
    left_left_index, left_right_index = find_pressure_peak_interval(left_curve, threshold_ratio)
    right_left_index, right_right_index = find_pressure_peak_interval(right_curve, threshold_ratio)
    left_serial_matrix_cop = []
    right_serial_matrix_cop = []
    for index in range(left_left_index, left_right_index + 1):
        matrix = [df.iloc[index]['data'][i * 64:(i + 1) * 64] for i in range(64)]
        left_matrix = [row[:32] for row in matrix]
        leftIn, rightIn = calculate_cop_corrected(left_matrix, False)
        left_serial_matrix_cop.append([leftIn, rightIn])
    for index in range(right_left_index, right_right_index + 1):
        matrix = [df.iloc[index]['data'][i * 64:(i + 1) * 64] for i in range(64)]
        right_matrix = [row[32:] for row in matrix]
        leftIn, rightIn = calculate_cop_corrected(right_matrix, True)
        right_serial_matrix_cop.append([leftIn, rightIn])
    return left_serial_matrix_cop, right_serial_matrix_cop


# =============== 性能优化2：OpenCV 连通域替代 DFS（核心加速） ===============
def largest_component_points(binary_mat: np.ndarray, thr: float = 4.0):
    """
    输入：binary_mat 为 2D 矩阵，阈值 > thr 视为前景
    输出：最大连通域的点坐标列表 [(row, col), ...]
    """
    mask = (binary_mat > 1).astype(np.uint8)
    num_labels, labels = cv2.connectedComponents(mask, connectivity=8)
    if num_labels <= 1:
        return []
    counts = np.bincount(labels.ravel())
    counts[0] = 0  # 背景
    max_label = int(np.argmax(counts))
    rows, cols = np.where(labels == max_label)
    return list(zip(rows.tolist(), cols.tolist()))


def largest_component_points_multi(binary_mat: np.ndarray, thr: float = 1.0,
                                   top_n: int = 5, min_size: int = 50):
    """
    多连通域版本：返回前N大连通域的合并坐标列表

    返回格式与 largest_component_points 完全相同: [(row, col), ...]
    """
    mask = (binary_mat > thr).astype(np.uint8)
    num_labels, labels = cv2.connectedComponents(mask, connectivity=8)

    if num_labels <= 1:
        return []

    counts = np.bincount(labels.ravel())
    counts[0] = 0

    # 找面积 >= min_size 的连通域
    valid_labels = []
    for label in range(1, num_labels):
        if counts[label] >= min_size:
            valid_labels.append((label, counts[label]))

    # 如果没有满足条件的，降级到最大连通域
    if not valid_labels:
        max_label = int(np.argmax(counts))
        rows, cols = np.where(labels == max_label)
        return list(zip(rows.tolist(), cols.tolist()))

    # 按面积排序，取前N个
    valid_labels.sort(key=lambda x: x[1], reverse=True)
    top_labels = [label for label, _ in valid_labels[:top_n]]

    # 合并所有连通域的坐标
    all_points = []
    for label in top_labels:
        rows, cols = np.where(labels == label)
        all_points.extend(list(zip(rows.tolist(), cols.tolist())))

    return all_points


def foot_contact_points_for_visual(binary_mat: np.ndarray, thr: float = 1.0,
                                   min_size: int = 3, min_pressure_ratio: float = 0.02):
    """
    可视化足型用的接触点提取。
    足趾常常与前掌存在小间隙，如果只取最大连通域会被漏掉；这里保留同一半区内
    有一定面积或压力贡献的连通域，避免真实脚趾被当作噪点删掉。
    """
    mat = np.array(binary_mat, dtype=float)
    mask = (mat > thr).astype(np.uint8)
    num_labels, labels = cv2.connectedComponents(mask, connectivity=8)
    if num_labels <= 1:
        return []

    counts = np.bincount(labels.ravel())
    counts[0] = 0
    total_pressure = float(mat[mask > 0].sum())
    if total_pressure <= 0:
        return []

    valid_labels = []
    for label in range(1, num_labels):
        if counts[label] < min_size:
            continue
        component_pressure = float(mat[labels == label].sum())
        if component_pressure / total_pressure >= min_pressure_ratio:
            valid_labels.append((label, counts[label]))

    if not valid_labels:
        max_label = int(np.argmax(counts))
        rows, cols = np.where(labels == max_label)
        return list(zip(rows.tolist(), cols.tolist()))

    valid_labels.sort(key=lambda x: x[1], reverse=True)
    all_points = []
    for label, _ in valid_labels:
        rows, cols = np.where(labels == label)
        all_points.extend(list(zip(rows.tolist(), cols.tolist())))
    return all_points


def detect_heel_for_frame(frame_data, isRight, thr: float = 2.0,
                          min_pressure_ratio: float = 0.02):
    """
    提取单帧某只脚的最大连通域（足迹）与脚跟位置（x最大行的y中位数）
    坐标体系：x=row(0..63), y=col(0..63)
    右脚输出全局坐标需把列坐标 +32
    返回：
        area: [maxArea]，其中 maxArea 为 [(x,y), ...] 全局坐标
        x_heel: [x_max]
        y_heel: [median_y]
    """
    area = []
    x_heel = []
    y_heel = []

    mat = np.array(frame_data, dtype=float).reshape(64, 64)
    half = mat[:, 32:] if isRight else mat[:, :32]
    if not np.any(half):
        return None, None, None

    maxArea = foot_contact_points_for_visual(
        half,
        thr=thr,
        min_size=3,
        min_pressure_ratio=min_pressure_ratio,
    )
    if not maxArea:
        return None, None, None

    # 右脚列坐标对齐到全局：+32
    if isRight:
        maxArea = [(r, c + 32) for (r, c) in maxArea]

    # 脚跟：取 x 最大行的 y 中位数
    xs = [p[0] for p in maxArea]
    max_x = max(xs)
    ys_on_max_x = [p[1] for p in maxArea if p[0] == max_x]
    y_med = statistics.median(ys_on_max_x)

    area.append(maxArea)
    x_heel.append(max_x)
    y_heel.append(y_med)

    return area, x_heel, y_heel


def detect_heel(pressure_curve, isShow, isRight, df):
    peak_value = max(pressure_curve)
    PointsMaxIndex = pressure_curve.index(peak_value)
    frame_data = df.iloc[PointsMaxIndex]['data']
    return detect_heel_for_frame(frame_data, isRight)


def divide_x_regions(half_max_area):
    x_value = [coord[0] for coord in half_max_area]
    min_x = min(x_value)
    max_x = max(x_value)
    total_range = max_x - min_x
    section_boundaries = []
    current = min_x
    ratios = [3, 4, 4, 4]
    total_ratio = sum(ratios)
    for i, ratio in enumerate(ratios):
        if i == len(ratios) - 1:
            end = max_x
        else:
            end = current + (ratio / total_ratio) * total_range
        section_boundaries.append((current, end))
        current = end
    section_coords = [[] for _ in range(4)]
    for coord in half_max_area:
        x = coord[0]
        for i, (start, end) in enumerate(section_boundaries):
            if start <= x < end or (i == 3 and x == end):
                section_coords[i].append(coord)
                break
    return section_coords


def calculate_region_areas(section_coords):
    areas = [len(section) for section in section_coords]
    # 区域映射：R4=后足，R3=中足，R2=前足（你当前实现）
    areaA = areas[3]  # 后足
    areaB = areas[2]  # 中足
    areaC = areas[1]  # 前足
    total_area = areaA + areaB + areaC
    area_AI = areaB / total_area if total_area > 0 else 0.0

    # 五档阈值（窄过渡带）
    # 高 <0.20；正常偏高 0.20–<0.21；正常 0.21–≤0.26；正常偏扁 0.26–≤0.27；扁平 >0.27
    if area_AI < 0.20:
        area_type = "高足弓(high arch)"
    elif area_AI < 0.21:
        area_type = "正常偏高(slightly high)"
    elif area_AI <= 0.26:
        area_type = "正常足弓(normal arch)"
    elif area_AI <= 0.27:
        area_type = "正常偏扁(slightly flat)"
    else:
        area_type = "扁平足(flat foot)"

    return area_AI, area_type


def calculate_2d_angle(A, B, C):
    if len(A) != 2 or len(B) != 2 or len(C) != 2:
        raise ValueError("所有点必须是二维坐标(x, y)")
    Ax, Ay = A[0], A[1]
    Bx, By = B[0], B[1]
    Cx, Cy = C[0], C[1]
    ca_x = Ax - Cx
    ca_y = Ay - Cy
    cb_x = Bx - Cx
    cb_y = By - Cy
    dot_product = ca_x * cb_x + ca_y * cb_y
    len_ca = math.sqrt(ca_x ** 2 + ca_y ** 2)
    len_cb = math.sqrt(cb_x ** 2 + cb_y ** 2)
    if len_ca == 0 or len_cb == 0:
        raise ValueError("点C不能与点A或点B重合")
    cos_theta = max(min(dot_product / (len_ca * len_cb), 1.0), -1.0)
    angle_rad = math.acos(cos_theta)
    angle_deg = math.degrees(angle_rad)
    return round(angle_deg, 2)


def get_b_point(b_region, isRight):
    if not b_region:
        return None
    sorted_by_x = sorted(b_region, key=lambda coord: coord[0])
    x_groups = {}
    for coord in sorted_by_x:
        x_val = coord[0]
        if x_val not in x_groups:
            x_groups[x_val] = []
        x_groups[x_val].append(coord)
    first_points = []
    for x_val in sorted(x_groups.keys()):
        group = sorted(x_groups[x_val], key=lambda coord: coord[1])
        if group:
            if isRight:
                first_points.append(group[0])
            else:
                first_points.append(group[-1])
    if first_points:
        if isRight:
            b_point = max(first_points, key=lambda coord: coord[1])
        else:
            b_point = min(first_points, key=lambda coord: coord[1])
        return b_point
    else:
        return None


def calculate_clarke(section_coords, isRight):
    a_region = section_coords[3]
    if not a_region:
        return None, None
    a_x_median = np.percentile([coord[0] for coord in a_region], 50, method='lower')
    a_candidates = [coord for coord in a_region if coord[0] == a_x_median]
    if isRight:
        a_point = min(a_candidates, key=lambda coord: coord[1])
    else:
        a_point = max(a_candidates, key=lambda coord: coord[1])
    b_region = section_coords[2]
    b_point = get_b_point(b_region, isRight)
    if b_point is None:
        return None, None
    c_region = section_coords[1]
    if not c_region:
        return None, None
    c_x_median = np.percentile([coord[0] for coord in c_region], 50, method='lower')
    c_candidates = [coord for coord in c_region if coord[0] == c_x_median]
    if isRight:
        c_point = min(c_candidates, key=lambda coord: coord[1])
    else:
        c_point = max(c_candidates, key=lambda coord: coord[1])
    try:
        clarke_angle = calculate_2d_angle(a_point, b_point, c_point)
    except:
        return None, None
    if clarke_angle < 42:
        return clarke_angle, "扁平足(flat foot)"
    elif 42 <= clarke_angle <= 48:
        return clarke_angle, "正常足(normal foot)"
    else:
        return clarke_angle, "高弓足(high arch foot)"


def calculate_distance_to_line(line_point_a, line_point_b, point_c):
    x1, y1 = line_point_a
    x2, y2 = line_point_b
    xc, yc = point_c
    if x2 == x1:
        A = 1;
        B = 0;
        C = -x1
    else:
        A = y2 - y1
        B = -(x2 - x1)
        C = (x2 - x1) * y1 - (y2 - y1) * x1
    denominator = math.sqrt(A * A + B * B)
    distance_c = abs(A * xc + B * yc + C) / denominator
    return distance_c


def get_perpendicular_line_equation(line_point_a, line_point_b, point_c):
    x1, y1 = line_point_a
    x2, y2 = line_point_b
    xc, yc = point_c
    if x1 == x2:
        foot_point = (x1, yc)
        return foot_point, (0, 1, -yc)
    elif y1 == y2:
        foot_point = (xc, y1)
        return foot_point, (1, 0, -xc)
    else:
        k_ab = (y2 - y1) / (x2 - x1)
        b_ab = y1 - k_ab * x1
        k_perp = -1 / k_ab
        x_foot = (k_ab * xc - k_perp * xc + yc - b_ab) / (k_ab - k_perp)
        y_foot = k_ab * x_foot + b_ab
        foot_point = (x_foot, y_foot)
        if math.isclose(x_foot, xc, abs_tol=1e-8):
            return foot_point, (1, 0, -xc)
        else:
            k_new = (y_foot - yc) / (x_foot - xc)
            b_new = yc - k_new * xc
            return foot_point, (k_new, -1, b_new)


def find_closest_point_to_foot(region, line_point_a, line_point_b, point_c, isRight):
    if line_point_a[1] == line_point_b[1]:
        foot_point = [point_c[0], line_point_a[1]]
        same_x_points = [p for p in region if p[0] == foot_point[0]]
        if same_x_points:
            if isRight:
                closest_point = min(same_x_points, key=lambda p: p[1])
            else:
                closest_point = max(same_x_points, key=lambda p: p[1])
            return closest_point
    foot_point, _ = get_perpendicular_line_equation(line_point_a, line_point_b, point_c)
    min_distance = float('inf')
    closest_point = None
    for point in region:
        distance = math.sqrt((point[0] - foot_point[0]) ** 2 + (point[1] - foot_point[1]) ** 2)
        if distance < min_distance:
            min_distance = distance
            closest_point = point
    return closest_point


def calculate_staheli(section_coords, isRight):
    a_region = section_coords[3]
    b_region = section_coords[2]
    c_region = section_coords[1]
    if not a_region or not b_region or not c_region:
        return None, None, None
    try:
        if isRight:
            sorted_a_region = sorted(a_region, key=lambda point: (point[0], point[1]))
            a_left_point = sorted_a_region[0]
            for a in sorted_a_region:
                if a_left_point[1] >= a[1]:
                    a_left_point = a
            a_x_min = min(a_region, key=lambda x: x[0])[0]
            a_x_max = max(a_region, key=lambda x: x[0])[0]
            a_x_mid = math.ceil((a_x_min + a_x_max) / 2)
            a_mid_right_point = max([p for p in a_region if a_x_mid == p[0]])
            c_left_point = min(c_region, key=lambda point: point[1])
            b_x_min = min(b_region, key=lambda x: x[0])[0]
            b_x_max = max(b_region, key=lambda x: x[0])[0]
            b_x_mid = math.ceil((b_x_min + b_x_max) / 2)
            b_mid_right_point = max([p for p in b_region if b_x_mid == p[0]])
            distance_heel = calculate_distance_to_line(a_left_point, c_left_point, a_mid_right_point)
            b_feet_point = find_closest_point_to_foot(b_region, a_left_point, c_left_point, b_mid_right_point, True)
            distance_middle = math.sqrt(
                (b_mid_right_point[0] - b_feet_point[0]) ** 2 + (b_mid_right_point[1] - b_feet_point[1]) ** 2)
            staheli_distance = distance_middle / distance_heel
        else:
            sorted_a_region = sorted(a_region, key=lambda point: (point[0], point[1]))
            a_left_point = sorted_a_region[0]
            for a in sorted_a_region:
                if a_left_point[1] <= a[1]:
                    a_left_point = a
            a_x_min = min(a_region, key=lambda x: x[0])[0]
            a_x_max = max(a_region, key=lambda x: x[0])[0]
            a_x_mid = math.ceil((a_x_min + a_x_max) / 2)
            a_mid_right_point = min([p for p in a_region if a_x_mid == p[0]])
            c_left_point = max(c_region, key=lambda point: point[1])
            b_x_min = min(b_region, key=lambda x: x[0])[0]
            b_x_max = max(b_region, key=lambda x: x[0])[0]
            b_x_mid = math.ceil((b_x_min + b_x_max) / 2)
            b_mid_right_point = min([p for p in b_region if b_x_mid == p[0]])
            distance_heel = calculate_distance_to_line(a_left_point, c_left_point, a_mid_right_point)
            b_feet_point = find_closest_point_to_foot(b_region, a_left_point, c_left_point, b_mid_right_point, False)
            distance_middle = math.sqrt(
                (b_mid_right_point[0] - b_feet_point[0]) ** 2 + (b_mid_right_point[1] - b_feet_point[1]) ** 2)
            staheli_distance = distance_middle / distance_heel
        return staheli_distance, distance_middle, distance_heel
    except:
        return None, None, None


def calculate_single_frame_arch_features(frame_data, contact_threshold=2.0,
                                         min_pressure_ratio=0.02):
    try:
        left_area, left_x_heel, left_y_heel = detect_heel_for_frame(
            frame_data,
            False,
            thr=contact_threshold,
            min_pressure_ratio=min_pressure_ratio,
        )
        right_area, right_x_heel, right_y_heel = detect_heel_for_frame(
            frame_data,
            True,
            thr=contact_threshold,
            min_pressure_ratio=min_pressure_ratio,
        )
        if left_area is None or right_area is None:
            return None
        left_max_area = left_area[0]
        right_max_area = right_area[0]
        left_section_coords = divide_x_regions(left_max_area)
        right_section_coords = divide_x_regions(right_max_area)
        left_area_ai, left_area_type = calculate_region_areas(left_section_coords)
        right_area_ai, right_area_type = calculate_region_areas(right_section_coords)
        left_clarke_angle, left_clarke_type = calculate_clarke(left_section_coords, False)
        right_clarke_angle, right_clarke_type = calculate_clarke(right_section_coords, True)
        left_staheli, left_distance_middle, left_distance_heel = calculate_staheli(left_section_coords, False)
        right_staheli, right_distance_middle, right_distance_heel = calculate_staheli(right_section_coords, True)
        return {
            'left_foot': {
                'area_index': left_area_ai,
                'area_type': left_area_type,
                'clarke_angle': left_clarke_angle,
                'clarke_type': left_clarke_type,
                'staheli_ratio': left_staheli,
                'distance_middle': left_distance_middle,
                'distance_heel': left_distance_heel,
                'section_coords': left_section_coords,
                'max_area': left_max_area
            },
            'right_foot': {
                'area_index': right_area_ai,
                'area_type': right_area_type,
                'clarke_angle': right_clarke_angle,
                'clarke_type': right_clarke_type,
                'staheli_ratio': right_staheli,
                'distance_middle': right_distance_middle,
                'distance_heel': right_distance_heel,
                'section_coords': right_section_coords,
                'max_area': right_max_area
            }
        }
    except:
        return None


def calculate_average_frame_data(data_array, total_curve=None):
    """
    计算用于可视化的平均压力帧。
    多帧静态站立报告用它作为足弓区域图和 COP 热力图的共同底图，
    避免一个图取峰值帧、另一个图看起来像另一帧。
    """
    arr = np.array(data_array, dtype=float)
    if arr.size == 0:
        return []

    arr = arr.reshape(-1, 64, 64)
    if total_curve is not None and len(total_curve) == len(arr):
        mask = np.array(total_curve, dtype=float) > 0
        if np.any(mask):
            arr = arr[mask]

    return np.mean(arr, axis=0).flatten().tolist()


def calculate_multi_frame_arch_features(data_array, peak_index, visual_frame_data=None):
    """
    多帧模式：
    1. 统计指标取所有帧的平均值（AI、Clarke、Staheli等）
    2. 可视化数据用所有有效帧的平均压力帧（section_coords、max_area）
    """
    print(f"检测到多帧数据 ({len(data_array)} 帧)，开始计算每帧足弓特征...")

    # ========== 第一步：先计算平均压力帧（用于可视化）==========
    if visual_frame_data is None:
        visual_frame_data = data_array[peak_index]
    visual_result = calculate_single_frame_arch_features(
        visual_frame_data,
        contact_threshold=0.5,
        min_pressure_ratio=0.005,
    )

    if visual_result is None:
        print("❌ 平均压力帧计算失败")
        return None

    print("✅ 平均压力帧计算成功")

    # ========== 第二步：计算所有帧的平均值（用于统计）==========
    all_frame_results = []
    valid_frames = 0

    for idx, frame_data in enumerate(data_array):
        if idx % 50 == 0:
            print(f"处理进度: {idx}/{len(data_array)}")

        frame_result = calculate_single_frame_arch_features(frame_data)

        if frame_result is not None:
            all_frame_results.append(frame_result)
            valid_frames += 1

    print(f"有效帧数: {valid_frames}")

    if not all_frame_results:
        print("没有有效的足弓特征数据")
        return None

    # ========== 第三步：统计平均值 ==========
    left_area_indices = [r['left_foot']['area_index'] for r in all_frame_results
                         if r['left_foot']['area_index'] is not None]
    right_area_indices = [r['right_foot']['area_index'] for r in all_frame_results
                          if r['right_foot']['area_index'] is not None]

    left_clarke_angles = [r['left_foot']['clarke_angle'] for r in all_frame_results
                          if r['left_foot']['clarke_angle'] is not None]
    right_clarke_angles = [r['right_foot']['clarke_angle'] for r in all_frame_results
                           if r['right_foot']['clarke_angle'] is not None]

    left_staheli_ratios = [r['left_foot']['staheli_ratio'] for r in all_frame_results
                           if r['left_foot']['staheli_ratio'] is not None]
    right_staheli_ratios = [r['right_foot']['staheli_ratio'] for r in all_frame_results
                            if r['right_foot']['staheli_ratio'] is not None]

    left_distance_middles = [r['left_foot']['distance_middle'] for r in all_frame_results
                             if r['left_foot']['distance_middle'] is not None]
    right_distance_middles = [r['right_foot']['distance_middle'] for r in all_frame_results
                              if r['right_foot']['distance_middle'] is not None]

    left_distance_heels = [r['left_foot']['distance_heel'] for r in all_frame_results
                           if r['left_foot']['distance_heel'] is not None]
    right_distance_heels = [r['right_foot']['distance_heel'] for r in all_frame_results
                            if r['right_foot']['distance_heel'] is not None]

    # 计算平均值
    def get_average_and_type(values, type_func):
        if not values:
            return None, "无数据"
        avg_val = np.mean(values)
        return avg_val, type_func(avg_val)

    def area_type_func(ai):
        if ai < 0.21:
            return "高足弓(high arch)"
        elif 0.21 <= ai <= 0.26:
            return "正常足弓(normal arch)"
        else:
            return "扁平足(flat foot)"

    def clarke_type_func(angle):
        if angle < 42:
            return "扁平足(flat foot)"
        elif 42 <= angle <= 48:
            return "正常足(normal foot)"
        else:
            return "高弓足(high arch foot)"

    left_avg_area_index, left_avg_area_type = get_average_and_type(left_area_indices, area_type_func)
    right_avg_area_index, right_avg_area_type = get_average_and_type(right_area_indices, area_type_func)

    left_avg_clarke_angle, left_avg_clarke_type = get_average_and_type(left_clarke_angles, clarke_type_func)
    right_avg_clarke_angle, right_avg_clarke_type = get_average_and_type(right_clarke_angles, clarke_type_func)

    left_avg_staheli = np.mean(left_staheli_ratios) if left_staheli_ratios else None
    right_avg_staheli = np.mean(right_staheli_ratios) if right_staheli_ratios else None

    left_avg_distance_middle = np.mean(left_distance_middles) if left_distance_middles else None
    right_avg_distance_middle = np.mean(right_distance_middles) if right_distance_middles else None

    left_avg_distance_heel = np.mean(left_distance_heels) if left_distance_heels else None
    right_avg_distance_heel = np.mean(right_distance_heels) if right_distance_heels else None

    # ========== 第四步：返回结果（平均指标 + 平均帧可视化数据）==========
    return {
        'left_foot': {
            'area_index': left_avg_area_index,
            'area_type': left_avg_area_type,
            'clarke_angle': left_avg_clarke_angle,
            'clarke_type': left_avg_clarke_type,
            'staheli_ratio': left_avg_staheli,
            'distance_middle': left_avg_distance_middle,
            'distance_heel': left_avg_distance_heel,
            'section_coords': visual_result['left_foot']['section_coords'],
            'max_area': visual_result['left_foot']['max_area']
        },
        'right_foot': {
            'area_index': right_avg_area_index,
            'area_type': right_avg_area_type,
            'clarke_angle': right_avg_clarke_angle,
            'clarke_type': right_avg_clarke_type,
            'staheli_ratio': right_avg_staheli,
            'distance_middle': right_avg_distance_middle,
            'distance_heel': right_avg_distance_heel,
            'section_coords': visual_result['right_foot']['section_coords'],
            'max_area': visual_result['right_foot']['max_area']
        },
        'frame_count': valid_frames,
        'is_multi_frame': True,
        'peak_frame_index': peak_index,
        'visual_frame_type': 'average',
    }


def calculate_complete_arch_features(data_array, left_curve, right_curve, show_plots=False):
    """
    目的：
    - 多帧：统计指标取平均，可视化也使用所有有效帧的平均压力帧
    - 所有可视化（热力图、足弓分区）都基于同一个平均帧
    - 单帧：直接使用该帧
    """
    # ✅ 关键修改：计算总压力曲线（左脚+右脚）
    total_curve = [l + r for l, r in zip(left_curve, right_curve)]
    peak_value = max(total_curve)
    peak_index = total_curve.index(peak_value)
    peak_frame_data = data_array[peak_index]

    print(f"峰值帧索引: {peak_index}, 总压力: {peak_value}")

    if len(data_array) > 1:
        print(f"检测到多帧数据 ({len(data_array)} 帧)")

        visual_frame_data = calculate_average_frame_data(data_array, total_curve)
        visual_total_pressure = float(np.sum(np.array(visual_frame_data, dtype=float))) if visual_frame_data else 0.0

        # 1) 先做全序列平均统计（得到平均 AI/Clarke/Staheli 等）
        arch_result = calculate_multi_frame_arch_features(data_array, peak_index, visual_frame_data)

        if arch_result:
            # 为兼容前端字段名，继续使用 peak_frame_data 字段承载“可视化帧”。
            arch_result['peak_frame_data'] = visual_frame_data
            arch_result['peak_frame_index'] = peak_index
            arch_result['peak_total_pressure'] = peak_value
            arch_result['visual_frame_type'] = 'average'
            arch_result['visual_total_pressure'] = visual_total_pressure

        return arch_result

    else:
        print("检测到单帧数据")

        # 单帧模式：直接使用该帧
        single_result = calculate_single_frame_arch_features(peak_frame_data)

        if single_result is None:
            print("无法计算足弓特征")
            return None

        # 添加峰值帧信息
        single_result['frame_count'] = 1
        single_result['is_multi_frame'] = False
        single_result['peak_frame_data'] = peak_frame_data
        single_result['peak_frame_index'] = peak_index
        single_result['peak_total_pressure'] = peak_value

        return single_result


def sample_entropy(time_series, m=2, r=0.2):
    N = len(time_series)
    if N <= m + 1:
        return 0
    ts = (time_series - np.mean(time_series)) / np.std(time_series)

    def get_vectors(m):
        return np.array([ts[i:i + m] for i in range(N - m)])

    vecs_m = get_vectors(m)
    dist_m = np.abs(vecs_m[:, None] - vecs_m[None, :])
    max_dist_m = np.max(dist_m, axis=2)
    sim_m = np.sum(max_dist_m <= r, axis=1) - 1
    total_m1_sim = 0
    for i in range(len(vecs_m)):
        mask = (max_dist_m[i] <= r) & (np.arange(len(vecs_m)) != i)
        if not np.any(mask):
            continue
        for j in np.where(mask)[0]:
            if np.abs(ts[i + m] - ts[j + m]) <= r:
                total_m1_sim += 1
    B = np.sum(sim_m)
    A = total_m1_sim
    ratio = A / B if B > 0 else 0
    return -np.log(ratio) if ratio > 0 else 0


def calculate_cop_metrics(cop_trajectory, dt=0.024):
    cop_array = np.array(cop_trajectory)
    if cop_array.size == 0:
        return None
    x = cop_array[:, 0]
    y = cop_array[:, 1]
    n = len(x)
    center = np.mean(cop_array, axis=0)
    range_x = np.ptp(x)
    range_y = np.ptp(y)
    centered_cop = cop_array - center
    if n > 2:
        cov = np.cov(centered_cop, rowvar=False)
        eigenvalues = np.linalg.eigvalsh(cov)
        lambda1, lambda2 = sorted(eigenvalues, reverse=True)
        ellipse_area = np.pi * 5.991 * np.sqrt(lambda1 * lambda2)
    else:
        ellipse_area = 0.0
    if n > 1:
        vx = np.diff(x) / dt
        vy = np.diff(y) / dt
        v_total = np.sqrt(vx ** 2 + vy ** 2)
        rms_vx = np.sqrt(np.mean(vx ** 2))
        rms_vy = np.sqrt(np.mean(vy ** 2))
        rms_v = np.sqrt(np.mean(v_total ** 2))
    else:
        vx, vy, v_total = np.array([0.0]), np.array([0.0]), np.array([0.0])
        rms_vx = rms_vy = rms_v = 0.0
    if n > 2:
        ax = np.diff(vx) / dt
        ay = np.diff(vy) / dt
        a_total = np.sqrt(ax ** 2 + ay ** 2)
        rms_ax = np.sqrt(np.mean(ax ** 2))
        rms_ay = np.sqrt(np.mean(ay ** 2))
        rms_a = np.sqrt(np.mean(a_total ** 2))
    else:
        ax, ay, a_total = np.array([0.0]), np.array([0.0]), np.array([0.0])
        rms_ax = rms_ay = rms_a = 0.0
    displacement = np.sqrt((x - center[0]) ** 2 + (y - center[1]) ** 2)
    min_samples = 30
    sampen_x = sample_entropy(x) if n > min_samples else 0.0
    sampen_y = sample_entropy(y) if n > min_samples else 0.0
    sampen_disp = sample_entropy(displacement) if n > min_samples else 0.0
    sampen_vx = sample_entropy(vx) if len(vx) > min_samples else 0.0
    sampen_vy = sample_entropy(vy) if len(vy) > min_samples else 0.0
    sampen_v = sample_entropy(v_total) if len(v_total) > min_samples else 0.0
    return {
        "横向偏移（range）": float(range_x),
        "纵向偏移（range）": float(range_y),
        "置信椭圆面积": float(ellipse_area),
        "横向速度（RMS）": float(rms_vx),
        "纵向速度（RMS）": float(rms_vy),
        "合速度（RMS）": float(rms_v),
        "横向加速度（RMS）": float(rms_ax),
        "纵向加速度（RMS）": float(rms_ay),
        "合加速度（RMS）": float(rms_a),
        "横向偏移（SampEn）": float(sampen_x),
        "纵向偏移（SampEn）": float(sampen_y),
        "合偏移（SampEn）": float(sampen_disp),
        "横向速度（SampEn）": float(sampen_vx),
        "纵向速度（SampEn）": float(sampen_vy),
        "合速度（SampEn）": float(sampen_v)
    }


def calculate_sway_features(cop_trajectory, fps=42, r_radius=0.1, time_window=0.5):
    n = len(cop_trajectory)
    if n < int(fps * 0.5):
        return None
    cop = np.array(cop_trajectory)
    center = np.mean(cop, axis=0)
    centered_cop = cop - center
    window_size = int(fps * time_window)
    density_curve = np.zeros(n)
    for i in range(n):
        start = max(0, i - window_size // 2)
        end = min(n, i + window_size // 2)
        dists = cdist([centered_cop[i]], centered_cop[start:end])[0]
        density_curve[i] = np.sum(dists <= r_radius)
    length_curve = np.zeros(n)
    window_points = int(fps * time_window)
    for i in range(n):
        start = max(0, i - window_points // 2)
        end = min(n, i + window_points // 2)
        center_point = centered_cop[i]
        points_in_window = centered_cop[start:end]
        dists = cdist([center_point], points_in_window)[0]
        mask = dists <= r_radius
        in_radius_points = points_in_window[mask]
        segment_length = 0
        if len(in_radius_points) > 1:
            for j in range(1, len(in_radius_points)):
                segment_length += euclidean(in_radius_points[j], in_radius_points[j - 1])
        length_curve[i] = segment_length
    window_points = int(fps * time_window)
    radius_curve = []
    for i in range(window_points // 2, n - window_points // 2):
        window = centered_cop[i - window_points // 2: i + window_points // 2]
        if len(window) >= 3:
            _, radius = cv2.minEnclosingCircle(window.astype(np.float32))
            radius_curve.append(radius)
        else:
            radius_curve.append(0)
    features = {
        "摇摆密度_峰值": float(np.max(density_curve)),
        "摇摆密度_均值": float(np.mean(density_curve)),
        "摇摆密度_标准差": float(np.std(density_curve)),
        "摇摆长度_峰值": float(np.max(length_curve)),
        "摇摆长度_均值": float(np.mean(length_curve)),
        "摇摆长度_标准差": float(np.std(length_curve)),
        "摇摆半径_峰值": float(np.max(radius_curve)) if radius_curve else 0.0,
        "摇摆半径_均值": float(np.mean(radius_curve)) if radius_curve else 0.0,
        "摇摆半径_标准差": float(np.std(radius_curve)) if radius_curve else 0.0
    }
    return features


def visualize_foot_regions(ax, section_coords, max_area, colors, section_names, title):
    all_x = [coord[0] for coord in max_area]
    all_y = [coord[1] for coord in max_area]
    x_min, x_max = min(all_x), max(all_x)
    y_min, y_max = min(all_y), max(all_y)
    x_range_extended = (x_min - 5, x_max + 5)
    y_range_extended = (y_min - 5, y_max + 5)
    ax.set_xlim(x_range_extended)
    ax.set_ylim(y_range_extended)
    ax.grid(True, alpha=0.3, linestyle='--')
    grid_size = 1.0
    x_bins = np.arange(x_range_extended[0], x_range_extended[1] + grid_size, grid_size)
    y_bins = np.arange(y_range_extended[0], y_range_extended[1] + grid_size, grid_size)
    heatmap_data = np.zeros((len(y_bins) - 1, len(x_bins) - 1))
    for i, coords in enumerate(section_coords):
        for coord in coords:
            x, y = coord
            x_idx = np.digitize(x, x_bins) - 1
            y_idx = np.digitize(y, y_bins) - 1
            if 0 <= x_idx < heatmap_data.shape[1] and 0 <= y_idx < heatmap_data.shape[0]:
                heatmap_data[y_idx, x_idx] = i + 1
    cmap_colors = ['white'] + colors
    cmap = ListedColormap(cmap_colors)
    ax.imshow(heatmap_data,
              extent=[x_range_extended[0], x_range_extended[1],
                      y_range_extended[0], y_range_extended[1]],
              origin='lower',
              cmap=cmap,
              aspect='auto',
              alpha=0.6)
    for i, (coords, color) in enumerate(zip(section_coords, colors)):
        if coords:
            x_vals = [coord[0] for coord in coords]
            y_vals = [coord[1] for coord in coords]
            ax.scatter(x_vals, y_vals, color=color, s=50, alpha=0.8,
                       label=section_names[i], edgecolors='black', linewidth=0.5)
    ratios = [3, 4, 4, 4]
    total_ratio = sum(ratios)
    total_x_range = x_max - x_min
    x_boundaries = [x_min]
    current_x = x_min
    for ratio in ratios:
        next_x = current_x + (ratio / total_ratio) * total_x_range
        x_boundaries.append(next_x)
        ax.axvline(x=next_x, color='red', linestyle='--', linewidth=2, alpha=0.8)
        current_x = next_x
    for i in range(len(x_boundaries) - 1):
        center_x = (x_boundaries[i] + x_boundaries[i + 1]) / 2
        ax.text(center_x, y_max + 2, section_names[i], ha='center', va='bottom',
                fontsize=10, fontweight='bold', backgroundcolor='white',
                bbox=dict(boxstyle="round,pad=0.3", facecolor='lightgray', alpha=0.8))
    for i, coords in enumerate(section_coords):
        if coords:
            x_vals = [coord[0] for coord in coords]
            y_vals = [coord[1] for coord in coords]
            center_x = np.mean(x_vals)
            center_y = np.mean(y_vals)
            ax.text(center_x, center_y, f'Region{i + 1}\n{len(coords)}pts',
                    ha='center', va='center', fontsize=9, fontweight='bold', color='white',
                    bbox=dict(boxstyle="circle,pad=0.3", facecolor=colors[i], alpha=0.9))
    ax.set_xlabel('X Coordinate')
    ax.set_ylabel('Y Coordinate')
    ax.set_title(f'{title} (Ratio 3:4:4:4)')
    ax.legend(loc='upper right')
    ax.set_xticks(np.arange(int(x_min), int(x_max) + 1, 5))
    ax.set_yticks(np.arange(int(y_min), int(y_max) + 1, 5))


def calculate_merged_region_areas(section_coords, spacing_mm=7):
    qianzu_count = len(section_coords[0]) + len(section_coords[1])
    zhongzu_count = len(section_coords[2])
    houzu_count = len(section_coords[3])
    counts = [qianzu_count, zhongzu_count, houzu_count]
    region_names = ["前足", "中足", "后足"]
    area_per_point_mm2 = spacing_mm * spacing_mm
    area_mm2 = [c * area_per_point_mm2 for c in counts]
    area_cm2 = [a / 100.0 for a in area_mm2]
    total_mm2 = sum(area_mm2)
    total_cm2 = total_mm2 / 100.0 if total_mm2 else 0.0
    percent = [(a / total_mm2) if total_mm2 > 0 else 0.0 for a in area_mm2]
    return {
        "region_names": region_names,
        "counts": counts,
        "area_mm2": area_mm2,
        "area_cm2": area_cm2,
        "total_area_mm2": total_mm2,
        "total_area_cm2": total_cm2,
        "percent": percent
    }


def calculate_cop(matrix, offset_y=0):
    total_p = np.sum(matrix)
    if total_p <= 0:
        return (None, None)
    rows, cols = matrix.shape
    x_idx, y_idx = np.meshgrid(np.arange(rows), np.arange(cols), indexing='ij')
    cop_x = np.sum(x_idx * matrix) / total_p
    cop_y = np.sum((y_idx + offset_y) * matrix) / total_p
    return (cop_x, cop_y)


def calculate_feet_centers_and_distances(df, left, right):
    total_points = [l + r for l, r in zip(left, right)]
    frame_index = total_points.index(max(total_points))
    matrix = [df.iloc[frame_index]['data'][i * 64:(i + 1) * 64] for i in range(64)]
    matrix = np.array(matrix)
    left_matrix = matrix[:, :32]
    right_matrix = matrix[:, 32:]
    left_cop = calculate_cop(left_matrix, offset_y=0)
    right_cop = calculate_cop(right_matrix, offset_y=32)
    both_cop = calculate_cop(matrix, offset_y=0)

    def euclidean_distance(p1, p2):
        if None in p1 or None in p2:
            return None
        return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)

    dist_left = euclidean_distance(left_cop, both_cop)
    dist_right = euclidean_distance(right_cop, both_cop)
    left_forward = left_cop[0] - right_cop[0] if left_cop[0] is not None and right_cop[0] is not None else None
    return {
        "frame_index": frame_index,
        "left_cop": left_cop,
        "right_cop": right_cop,
        "both_cop": both_cop,
        "left_forward": left_forward * 0.7 if left_forward is not None else None,
        "dist_left_to_both": dist_left * 0.7 if dist_left is not None else None,
        "dist_right_to_both": dist_right * 0.7 if dist_right is not None else None
    }


def calculate_region_pressures(section_coords, matrix):
    region_pressures = []
    for section in section_coords:
        total_pressure = sum(matrix[x][y] for x, y in section)
        region_pressures.append(total_pressure)
    total = sum(region_pressures)
    qianzu = region_pressures[0] + region_pressures[1]
    zhongzu = region_pressures[2]
    houzu = region_pressures[3]
    if total == 0:
        return {"前足": 0.0, "中足": 0.0, "后足": 0.0}
    return {
        "前足": qianzu / total,
        "中足": zhongzu / total,
        "后足": houzu / total
    }


def calculate_cop_time_series(left_cop, right_cop, additional_data, dt=0.024):
    if len(left_cop) >= len(right_cop):
        cop_trajectory = left_cop
    else:
        cop_trajectory = right_cop
    if not cop_trajectory:
        return {
            'time_series': None,
            'time_points': [],
            'velocity_series': [],
            'path_length': 0,
            'contact_area': 0,
            'ls_ratio': 0,
            'center_bias': 0,
            'eccentricity': 0,
            'delta_x': 0,
            'delta_y': 0,
            'major_axis': 0,
            'minor_axis': 0,
            'max_displacement': 0,
            'min_displacement': 0,
            'avg_velocity': 0,
            'rms_displacement': 0,
            'std_x': 0,
            'std_y': 0
        }
    cop_array = np.array(cop_trajectory)
    x = cop_array[:, 0]
    y = cop_array[:, 1]
    n = len(x)
    time_points = np.arange(n) * dt
    if n > 1:
        vx = np.diff(x) / dt
        vy = np.diff(y) / dt
        velocity_series = np.sqrt(vx ** 2 + vy ** 2) * 7
        velocity_series = np.concatenate([[0], velocity_series])
    else:
        velocity_series = np.array([0])
    center = np.mean(cop_array, axis=0)
    path_length = 0
    if n > 1:
        for i in range(1, n):
            distance = np.sqrt((x[i] - x[i - 1]) ** 2 + (y[i] - y[i - 1]) ** 2)
            path_length += distance
    path_length *= 7
    try:
        from scipy.spatial import ConvexHull
        if n >= 3:
            hull = ConvexHull(cop_array)
            contact_area = hull.volume * (7 ** 2)
        else:
            contact_area = 0
    except:
        contact_area = np.ptp(x) * np.ptp(y) * (7 ** 2)
    delta_x = np.ptp(x) * 7
    delta_y = np.ptp(y) * 7
    try:
        centered_data = cop_array - center
        cov_matrix = np.cov(centered_data.T)
        eigenvalues = np.linalg.eigvals(cov_matrix)
        eigenvalues = np.sort(eigenvalues)[::-1]
        major_axis = np.round(2 * np.sqrt(eigenvalues[0]) * 0.7, 2)
        minor_axis = np.round(2 * np.sqrt(eigenvalues[1]) * 0.7, 2)
        print(major_axis ,minor_axis )
    except:
        major_axis = delta_x
        minor_axis = delta_y
    displacement = np.sqrt((x - center[0]) ** 2 + (y - center[1]) ** 2) * 0.7
    max_displacement = np.max(displacement)
    min_displacement = np.min(displacement)
    avg_velocity = np.mean(velocity_series)
    rms_displacement = np.sqrt(np.mean(displacement ** 2))
    std_x = np.std(x) * 7
    std_y = np.std(y) * 7
    ls_ratio = major_axis / minor_axis if minor_axis > 0 else 0
    center_bias = np.arctan2(center[1], center[0]) * 180 / np.pi
    eccentricity = np.sqrt(1 - (minor_axis / major_axis) ** 2) if major_axis > 0 else 0
    return {
        'time_series': velocity_series,
        'time_points': time_points,
        'velocity_series': velocity_series,
        'path_length': path_length,
        'contact_area': contact_area,
        'ls_ratio': ls_ratio,
        'eccentricity': eccentricity,
        'major_axis': major_axis,
        'minor_axis': minor_axis,
        'delta_x': delta_x,
        'delta_y': delta_y,
        'max_displacement': max_displacement,
        'min_displacement': min_displacement,
        'avg_velocity': avg_velocity,
        'rms_displacement': rms_displacement,
        'center_bias': center_bias,
        'std_x': std_x,
        'std_y': std_y
    }


def draw_confidence_ellipse(ax, cop_trajectory, confidence=0.95, color='red', alpha=0.3, use_risk_color=False):
    if not cop_trajectory or len(cop_trajectory) < 3:
        return None

    from matplotlib.patches import Ellipse
    from scipy import stats

    cop_array = np.array(cop_trajectory)
    x = cop_array[:, 0]
    y = cop_array[:, 1]
    mean_x = np.mean(x)
    mean_y = np.mean(y)

    cov = np.cov(x, y)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    order = eigenvalues.argsort()[::-1]
    eigenvalues = eigenvalues[order]
    eigenvectors = eigenvectors[:, order]

    chi2_val = stats.chi2.ppf(confidence, 2)
    width = 2 * np.sqrt(eigenvalues[0] * chi2_val)
    height = 2 * np.sqrt(eigenvalues[1] * chi2_val)
    angle = np.degrees(np.arctan2(eigenvectors[1, 0], eigenvectors[0, 0]))

    area_grid = np.pi * width * height / 4
    area_cm2 = area_grid * 0.7 * 0.7

    if use_risk_color:
        ellipse_color = get_ellipse_color_by_area(area_cm2)
    else:
        ellipse_color = color

    ellipse = Ellipse((mean_x, mean_y), width, height, angle=angle,
                      facecolor=ellipse_color, alpha=alpha, edgecolor=ellipse_color, linewidth=2)
    ax.add_patch(ellipse)
    ax.plot(mean_x, mean_y, 'o', color=ellipse_color, markersize=8, markeredgecolor='white', markeredgewidth=2)

    return {
        'center': (mean_x, mean_y),
        'width': width,
        'height': height,
        'angle': angle,
        'area': area_grid,
        'area_cm2': area_cm2
    }

# ---------------- 新增：计算并绘制外接框工具 ----------------
def compute_bboxes_from_matrix(matrix, margin=0):
    """
    输入 matrix: 64x64 np.array（已旋转/镜像到标准坐标）
    返回：dict，如
      {
        'left':  (top,bottom,left,right) 或 None,
        'right': (top,bottom,left,right) 或 None
      }
    """

    def largest_bbox(mask):
        num_labels, labels = cv2.connectedComponents(mask.astype(np.uint8), connectivity=8)
        if num_labels <= 1:
            return None
        counts = np.bincount(labels.ravel())
        counts[0] = 0
        max_label = int(np.argmax(counts))
        rr, cc = np.where(labels == max_label)
        return rr.min(), rr.max(), cc.min(), cc.max()

    left = matrix[:, :32]
    right = matrix[:, 32:]

    L = largest_bbox(left > 0)
    R = largest_bbox(right > 0)

    def expand_to_global(bbox, col_offset, col_min, col_max, margin=0):
        if bbox is None:
            return None
        t, b, l, r = bbox
        t = max(t - margin, 0)
        b = min(b + margin, 63)
        l = max(l - margin, col_min)
        r = min(r + margin, col_max)
        return (t, b, l + col_offset, r + col_offset)

    left_bbox_global = expand_to_global(L, col_offset=0, col_min=0, col_max=31, margin=margin)
    right_bbox_global = expand_to_global(R, col_offset=32, col_min=0, col_max=31, margin=margin)

    return {'left': left_bbox_global, 'right': right_bbox_global}


def plot_frame_with_bboxes(matrix, ax=None, cmap='viridis', title='热力图 + 外接框', show_colorbar=True):
    """
    单帧调试可视化：热力图 + 左右脚最大连通域外接框 + 中线
    matrix: 64x64 np.array
    """
    created_ax = False
    if ax is None:
        fig, ax = plt.subplots(figsize=(6, 6))
        created_ax = True
    hm = sns.heatmap(matrix, cmap=cmap, ax=ax, cbar=show_colorbar, cbar_kws={'shrink': 0.85, 'pad': 0.02})
    ax.set_title(title)
    ax.set_xlabel('Y');
    ax.set_ylabel('X')
    # 分界线
    # ax.axvline(x=32, color='yellow', linestyle='--', linewidth=2, alpha=0.9, label='Midline (col=32)')
    # 计算 bbox 并叠加
    bboxes = compute_bboxes_from_matrix(matrix, margin=0)
    import matplotlib.patches as patches
    if bboxes['left'] is not None:
        t, b, l, r = bboxes['left']
        rect = patches.Rectangle((l, t), r - l + 1, b - t + 1,
                                 linewidth=2.5, edgecolor='red', facecolor='none', label='Left BBox')
        ax.add_patch(rect)
    if bboxes['right'] is not None:
        t, b, l, r = bboxes['right']
        rect = patches.Rectangle((l, t), r - l + 1, b - t + 1,
                                 linewidth=2.5, edgecolor='cyan', facecolor='none', label='Right BBox')
        ax.add_patch(rect)
    ax.legend(loc='upper right')
    if created_ax:
        plt.tight_layout()
        plt.show()



#===========================COP置信椭圆color bar===================================

def get_ellipse_color_by_area(area_cm2, vmin=0, vmax=5):
    """
    根据置信椭圆面积返回对应的颜色（绿色到红色渐变）

    参数:
        area_cm2: 椭圆面积 (cm²)
        vmin: 最小值 (默认0)
        vmax: 最大值 (默认10)

    返回:
        颜色值 (RGBA)
    """
    from matplotlib.colors import LinearSegmentedColormap

    # ✅ 修改：绿色 → 黄色 → 红色（更直观的风险渐变）
    colors = ['#87CEEB', '#003366']   # 绿 → 黄 → 红
    # 或者直接绿到红：colors = ['#00FF00', '#FF0000']

    cmap = LinearSegmentedColormap.from_list('green_red_cmap', colors, N=256)

    normalized = np.clip((area_cm2 - vmin) / (vmax - vmin), 0, 1)

    return cmap(normalized)


def add_risk_colorbar(fig, ax_position, vmin=0, vmax=5):
    """
    添加浅蓝色到深蓝色渐变颜色条，两端标注风险等级
    """
    from matplotlib.colors import LinearSegmentedColormap

    colors = ['#87CEEB', '#003366']  # 浅蓝 → 深蓝
    cmap = LinearSegmentedColormap.from_list('green_red_cmap', colors, N=256)

    cax = fig.add_axes(ax_position)
    norm = plt.Normalize(vmin=vmin, vmax=vmax)
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
    sm.set_array([])

    cbar = fig.colorbar(sm, cax=cax, orientation='vertical')
    cbar.set_label('椭圆面积 (cm$^2$)', fontsize=10)

    # ✅ 在两端添加风险标记
    cax.text(1.3, -0.08, '低风险', transform=cax.transAxes,
             fontsize=9, va='center', ha='left', color='#87CEEB', fontweight='bold')
    cax.text(1.3, 1.08, '风险预警', transform=cax.transAxes,
             fontsize=9, va='center', ha='left', color='#003366', fontweight='bold')

    return cbar
















def create_pdf_report(left_cop, right_cop, arch_results, additional_data, save_pdf_path,
                      *, heatmap_png_path=None, save_images_dir=None, save_json_path=None):
    """
    多页PDF报告（A4横版 11.69 x 8.27 in）+ PNG图片保存 + JSON数据保存

    修改说明：
    保留了原有的 PDF 生成逻辑（大边距、标题）。
    新增了针对 PNG 图片的独立渲染逻辑（紧凑画布、无边距），以适配新版报告模板。
    """

    # ========== 自动设置JSON路径（与PDF同名） ==========
    if save_json_path is None:
        # 将PDF路径的扩展名改为.json
        pdf_path_obj = Path(save_pdf_path)
        save_json_path = pdf_path_obj.with_suffix('.json')
        print(f"\n📝 JSON路径未指定，自动使用: {save_json_path}")

    # ========== 初始化图片路径字典 ==========
    image_paths = {}

    if save_images_dir:
        os.makedirs(save_images_dir, exist_ok=True)
        print(f"\n📁 图片保存目录: {save_images_dir}")

    # 记录外部传入的热力图路径
    if heatmap_png_path and Path(heatmap_png_path).exists():
        image_paths['heatmap_external'] = str(heatmap_png_path)

    # ========== 原有PDF生成配置（保持不变）==========
    A4_W, A4_H = 11.69, 8.27

    SUPTITLE_Y = 0.962
    GS_TOP = 0.7
    GS_BOTTOM = 0.3
    GS_LEFT = 0.08
    GS_RIGHT = 0.95
    GS_HSPACE = 0.20
    GS_WSPACE = 0.25

    def new_fig(title=None):
        fig = plt.figure(figsize=(A4_W, A4_H))
        if title:
            fig.suptitle(title, fontsize=18, fontweight='bold', y=SUPTITLE_Y)
        return fig

    def make_gs(fig, nrows=1, ncols=1,
                top=GS_TOP, bottom=GS_BOTTOM,
                left=GS_LEFT, right=GS_RIGHT,
                hspace=GS_HSPACE, wspace=GS_WSPACE):
        return fig.add_gridspec(nrows=nrows, ncols=ncols, top=top, bottom=bottom,
                                left=left, right=right, hspace=hspace, wspace=wspace)

    with PdfPages(save_pdf_path) as pdf:
        title_suffix = f"（{arch_results.get('frame_count', 0)}帧平均）" if arch_results.get('is_multi_frame',
                                                                                           False) else ""

        # ==========================================
        # 0) 等高线热力图
        # ==========================================
        if heatmap_png_path and Path(heatmap_png_path).exists():
            fig = new_fig('等高线热力图')
            gs = make_gs(fig, 1, 1)
            ax = fig.add_subplot(gs[0, 0])

            img = mpimg.imread(heatmap_png_path)
            img_r = np.rot90(img, k=-1)
            ax.imshow(img_r, origin='upper', aspect='auto')
            ax.axis('off')
            gs.tight_layout(fig, pad=0.5)

            pdf.savefig(fig)
            plt.close(fig)

        # ==========================================
        # 1) COP轨迹（左/右）
        # ==========================================
        # 定义绘图逻辑（供 PDF 和 PNG 共用）
        def draw_cop_content(ax, cop_data, title_text):
            if cop_data:
                x = [p[0] for p in cop_data]
                y = [p[1] for p in cop_data]
                sc = ax.scatter(x, y, c=range(len(x)), cmap='viridis', s=12, alpha=0.9)
                ax.plot(x, y, color='gray', alpha=0.5)
                return sc
            return None

            # ✅ 计算统一窗口范围

        from matplotlib.ticker import MultipleLocator

        left_x_range, left_y_range = 0, 0
        right_x_range, right_y_range = 0, 0
        left_center, right_center = None, None

        if left_cop and len(left_cop) >= 3:
            arr_l = np.array(left_cop)
            left_x_range = np.ptp(arr_l[:, 0])
            left_y_range = np.ptp(arr_l[:, 1])
            left_center = np.mean(arr_l, axis=0)

        if right_cop and len(right_cop) >= 3:
            arr_r = np.array(right_cop)
            right_x_range = np.ptp(arr_r[:, 0])
            right_y_range = np.ptp(arr_r[:, 1])
            right_center = np.mean(arr_r, axis=0)

        max_x_range = max(left_x_range, right_x_range, 0.1)
        max_y_range = max(left_y_range, right_y_range, 0.1)
        x_margin = max_x_range * 0.15 + 0.5
        y_margin = max_y_range * 0.15 + 0.5
        half_x = max_x_range / 2 + x_margin
        half_y = max_y_range / 2 + y_margin

        # --- A. 原有 PDF 生成逻辑 ---
        fig = new_fig(f'压力中心轨迹长度 {title_suffix}')
        gs = make_gs(fig, 1, 2, right=0.88)

        # 左脚图使用校正后的 left_cop 数据
        ax1 = fig.add_subplot(gs[0, 0])
        sc1 = draw_cop_content(ax1, left_cop, "")
        ax1.set_title('左脚 COP 轨迹', pad=8)
        ax1.set_xlabel('前后摆动')  # ✅ 修改
        ax1.set_ylabel('左右摆动')  # ✅ 修改
        if left_center is not None:
            ax1.set_xlim(left_center[0] - half_x, left_center[0] + half_x)
            ax1.set_ylim(left_center[1] - half_y, left_center[1] + half_y)
        ax1.xaxis.set_major_locator(MultipleLocator(2))
        ax1.xaxis.set_minor_locator(MultipleLocator(0.5))
        ax1.yaxis.set_major_locator(MultipleLocator(1))
        ax1.yaxis.set_minor_locator(MultipleLocator(0.5))
        ax1.grid(True, which='major', alpha=0.5, linewidth=0.8)
        ax1.grid(True, which='minor', alpha=0.2, linewidth=0.5)

        # 右脚图使用校正后的 right_cop 数据
        ax2 = fig.add_subplot(gs[0, 1])
        sc2 = draw_cop_content(ax2, right_cop, "")
        ax2.set_title('右脚 COP 轨迹', pad=8)
        ax2.set_xlabel('前后摆动')  # ✅ 修改
        ax2.set_ylabel('左右摆动')  # ✅ 修改
        if right_center is not None:
            ax2.set_xlim(right_center[0] - half_x, right_center[0] + half_x)
            ax2.set_ylim(right_center[1] - half_y, right_center[1] + half_y)
        ax2.xaxis.set_major_locator(MultipleLocator(2))
        ax2.xaxis.set_minor_locator(MultipleLocator(0.5))
        ax2.yaxis.set_major_locator(MultipleLocator(1))
        ax2.yaxis.set_minor_locator(MultipleLocator(0.5))
        ax2.grid(True, which='major', alpha=0.5, linewidth=0.8)
        ax2.grid(True, which='minor', alpha=0.2, linewidth=0.5)
        # 添加共享colorbar
        sc_for_cbar = sc1 if sc1 else sc2
        if sc_for_cbar:
            cbar_ax = fig.add_axes([0.91, 0.25, 0.02, 0.5])
            cbar = fig.colorbar(sc_for_cbar, cax=cbar_ax)
            cbar.set_label('时间序列')

        pdf.savefig(fig)

        # --- B. PNG 图片保存逻辑 ---
        if save_images_dir:
            fig_png, (p_ax1, p_ax2) = plt.subplots(1, 2, figsize=(12, 5))

            # 左脚使用校正后的 left_cop 数据
            sc1_png = draw_cop_content(p_ax1, left_cop, "")
            p_ax1.set_title("Left Foot")
            p_ax1.set_xlabel('前后')  # ✅ 修改
            p_ax1.set_ylabel('左右')  # ✅ 修改
            if left_center is not None:
                p_ax1.set_xlim(left_center[0] - half_x, left_center[0] + half_x)
                p_ax1.set_ylim(left_center[1] - half_y, left_center[1] + half_y)
            p_ax1.grid(True, alpha=0.3)

            # 右脚使用校正后的 right_cop 数据
            sc2_png = draw_cop_content(p_ax2, right_cop, "")
            p_ax2.set_title("Right Foot")
            p_ax2.set_xlabel('前后')  # ✅ 修改
            p_ax2.set_ylabel('左右')  # ✅ 修改
            if right_center is not None:
                p_ax2.set_xlim(right_center[0] - half_x, right_center[0] + half_x)
                p_ax2.set_ylim(right_center[1] - half_y, right_center[1] + half_y)
            p_ax2.grid(True, alpha=0.3)

            # 添加共享colorbar
            sc_for_cbar_png = sc1_png if sc1_png else sc2_png
            if sc_for_cbar_png:
                cbar_ax_png = fig_png.add_axes([0.92, 0.15, 0.015, 0.7])
                cbar_png = fig_png.colorbar(sc_for_cbar_png, cax=cbar_ax_png)
                cbar_png.set_label('时间序列')

            cop_trajectory_path = os.path.join(save_images_dir, 'cop_trajectory.png')
            fig_png.tight_layout(rect=[0, 0, 0.90, 1])
            fig_png.savefig(cop_trajectory_path, dpi=150)
            image_paths['cop_trajectory'] = cop_trajectory_path
            print(f"  ✅ COP轨迹图(优化版): cop_trajectory.png")
            plt.close(fig_png)

        plt.close(fig)
        # ==========================================
        # 2) 足弓分区（左/右）
        # ==========================================
        colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#F9A602']
        section_names = ['Region 1', 'Region 2', 'Region 3', 'Region 4']

        # --- A. 原有 PDF 生成逻辑 ---
        fig = new_fig(f'足弓区域划分 ')
        gs = make_gs(fig, 1, 2)
        axL = fig.add_subplot(gs[0, 0])
        visualize_foot_regions(axL, arch_results['left_foot']['section_coords'],
                               arch_results['left_foot']['max_area'], colors, section_names, "Left Foot")
        axR = fig.add_subplot(gs[0, 1])
        visualize_foot_regions(axR, arch_results['right_foot']['section_coords'],
                               arch_results['right_foot']['max_area'], colors, section_names, "Right Foot")

        pdf.savefig(fig)

        # --- B. 新增：PNG 图片保存逻辑 (优化：使用紧凑画布) ---
        if save_images_dir:
            fig_png, (p_axL, p_axR) = plt.subplots(1, 2, figsize=(10, 5))

            # 重新调用可视化函数
            visualize_foot_regions(p_axL, arch_results['left_foot']['section_coords'],
                                   arch_results['left_foot']['max_area'], colors, section_names, "Left")
            visualize_foot_regions(p_axR, arch_results['right_foot']['section_coords'],
                                   arch_results['right_foot']['max_area'], colors, section_names, "Right")

            arch_regions_path = os.path.join(save_images_dir, 'arch_regions.png')
            fig_png.tight_layout()
            fig_png.savefig(arch_regions_path, dpi=150)
            image_paths['arch_regions'] = arch_regions_path
            # print(f"  ✅ 足弓分区图(优化版): arch_regions.png")
            plt.close(fig_png)

        plt.close(fig)

        # ==========================================
        # 3) 峰值帧热力图（叠加BBox和分界线）
        # ==========================================
        # 准备数据（在绘图前处理好数据，供两套逻辑共用）
        peak_data = arch_results.get('peak_frame_data', [])
        display_mat = None

        if peak_data:
            matrix = np.array(peak_data, dtype=float).reshape(64, 64)
            # 平滑处理
            orig_zero_mask = (matrix <= 0)
            smoothed = gaussian_filter(matrix.astype(np.float32), sigma=1.0, mode='nearest')
            smoothed[orig_zero_mask] = 0.0
            matrix_sm = smoothed

            # Mask处理
            use_masked = True
            left_area = arch_results['left_foot']['max_area'] if 'left_foot' in arch_results else None
            right_area = arch_results['right_foot']['max_area'] if 'right_foot' in arch_results else None

            if use_masked and (left_area or right_area):
                mask = np.zeros_like(matrix_sm, dtype=bool)
                if left_area:
                    for (x, y) in left_area:
                        if 0 <= x < 64 and 0 <= y < 64: mask[x, y] = True
                if right_area:
                    for (x, y) in right_area:
                        if 0 <= x < 64 and 0 <= y < 64: mask[x, y] = True
                display_mat = np.where(mask, matrix_sm, 0.0)
            else:
                display_mat = matrix_sm

        # 定义绘图函数
        def draw_heatmap_content(ax, mat_data, show_cbar=True):
            if mat_data is None: return

            colors_heat = ['#FFFFFF', '#E6F3FF', '#B3D9FF', '#66B2FF', '#3399FF',
                           '#00FF00', '#FFFF00', '#FFA500', '#FF6B6B', '#FF0000']
            pressure_cmap = LinearSegmentedColormap.from_list('foot_pressure', colors_heat, N=256)

            im = ax.imshow(
                mat_data,
                cmap=pressure_cmap,
                origin='upper',
                interpolation='nearest',
                aspect='equal',
                extent=[0, 64, 64, 0],
                vmin=0, vmax=100
            )
            ax.axvline(x=32, color='white', linestyle='--', linewidth=1.5, alpha=0.8)
            ax.set_xticks([0, 16, 32, 48, 64])
            ax.set_yticks([0, 16, 32, 48, 64])
            return im

        # --- A. 原有 PDF 生成逻辑 ---
        fig = new_fig('峰值帧足底压力热力图')
        gs = make_gs(fig, 1, 2, top=0.88, bottom=0.16, left=0.06, right=0.96, wspace=0.22)
        axL = fig.add_subplot(gs[0, 0])
        axR = fig.add_subplot(gs[0, 1])

        if display_mat is not None:
            # 左侧用 seaborn (保持原样)
            sns.heatmap(matrix_sm, ax=axL, cbar=True, cbar_kws={'shrink': 0.80, 'pad': 0.02})
            axL.set_xlabel('列 (格)');
            axL.set_ylabel('行 (格)')
            axL.invert_yaxis()
            axL.set_aspect('equal', adjustable='box')

            # 右侧用自定义 (保持原样)
            imR = draw_heatmap_content(axR, display_mat)
            axR.set_xlabel('列 (格)');
            axR.set_ylabel('行 (格)')
            cbarR = fig.colorbar(imR, ax=axR, shrink=0.78, pad=0.02)
            cbarR.set_label('压力强度')

        pdf.savefig(fig)

        # --- B. 新增：PNG 图片保存逻辑 (只保存那张干净的热力图) ---
        if save_images_dir and display_mat is not None:
            fig_png, p_ax = plt.subplots(figsize=(6, 6))  # 正方形画布

            draw_heatmap_content(p_ax, display_mat, show_cbar=False)
            p_ax.axis('off')  # 关掉坐标轴，只要图

            heatmap_internal_path = os.path.join(save_images_dir, 'heatmap_internal.png')
            fig_png.tight_layout()
            fig_png.savefig(heatmap_internal_path, dpi=150, bbox_inches='tight', pad_inches=0.1)
            image_paths['heatmap_internal'] = heatmap_internal_path
            print(f"  ✅ 峰值帧热力图(优化版): heatmap_internal.png")
            plt.close(fig_png)

        plt.close(fig)

        # ==========================================
        # 4) COP速度时间序列
        # ==========================================
        cop_time = calculate_cop_time_series(left_cop, right_cop, additional_data)

        def draw_velocity_content(ax):
            if cop_time['time_series'] is not None and len(cop_time['time_points']) > 0:
                ax.plot(cop_time['time_points'], cop_time['velocity_series'], color='#66B2FF', linewidth=2)
                ax.set_xlabel('时间 (s)')
                ax.set_ylabel('速度 (mm/s)')
                ax.grid(True, alpha=0.3)
            else:
                ax.text(0.5, 0.5, '无COP时间序列数据', ha='center', va='center', fontsize=14)

        # --- A. 原有 PDF 生成逻辑 ---
        fig = new_fig('压力中心变化速度序列（mm/s）')
        gs = make_gs(fig, 1, 1)
        ax = fig.add_subplot(gs[0, 0])
        draw_velocity_content(ax)
        if cop_time['time_series'] is None: ax.axis('off')
        pdf.savefig(fig)

        # --- B. 新增：PNG 图片保存逻辑 ---
        if save_images_dir:
            fig_png, p_ax = plt.subplots(figsize=(8, 4))  # 长条形画布
            draw_velocity_content(p_ax)
            if cop_time['time_series'] is None: p_ax.axis('off')

            velocity_series_path = os.path.join(save_images_dir, 'velocity_series.png')
            fig_png.tight_layout()
            fig_png.savefig(velocity_series_path, dpi=150)
            image_paths['velocity_series'] = velocity_series_path
            print(f"  ✅ COP速度序列(优化版): velocity_series.png")
            plt.close(fig_png)

        plt.close(fig)

        # ==========================================
        # 5) COP置信椭圆
        # ==========================================
        # --- A. 原有 PDF 生成逻辑 ---
        fig = new_fig('压力中心分布面积（95%）')
        gs = make_gs(fig, 1, 2, right=0.88)

        from matplotlib.ticker import MultipleLocator

        ellipse_data = {'left': {}, 'right': {}}

        # 左脚图使用校正后的 left_cop 数据
        axL = fig.add_subplot(gs[0, 0])
        if left_cop and len(left_cop) >= 3:
            arr = np.array(left_cop)
            x, y = arr[:, 0], arr[:, 1]
            axL.scatter(x, y, c=range(len(x)), cmap='viridis', s=10, alpha=0.8)
            axL.plot(x, y, color='gray', alpha=0.5)
            info95 = draw_confidence_ellipse(axL, left_cop, confidence=0.95, use_risk_color=True, alpha=0.3)

            if info95:
                area95 = info95['area_cm2']
                ellipse_data['left'] = {'area_95': area95}
                axL.text(0.02, 0.98, f"95%面积: {area95:.4f} cm$^2$",
                         transform=axL.transAxes, va='top', fontsize=9,
                         bbox=dict(boxstyle="round,pad=0.2", facecolor='white', alpha=0.8))

            if left_center is not None:
                axL.set_xlim(left_center[0] - half_x, left_center[0] + half_x)
                axL.set_ylim(left_center[1] - half_y, left_center[1] + half_y)

        axL.xaxis.set_major_locator(MultipleLocator(2))
        axL.xaxis.set_minor_locator(MultipleLocator(0.5))
        axL.yaxis.set_major_locator(MultipleLocator(1))
        axL.yaxis.set_minor_locator(MultipleLocator(0.5))
        axL.grid(True, which='major', alpha=0.5, linewidth=0.8)
        axL.grid(True, which='minor', alpha=0.2, linewidth=0.5)
        axL.set_title('左脚', pad=8)
        axL.set_xlabel('前后摆动')
        axL.set_ylabel('左右摆动')

        # 右脚图使用校正后的 right_cop 数据
        axR = fig.add_subplot(gs[0, 1])
        if right_cop and len(right_cop) >= 3:
            arr = np.array(right_cop)
            x, y = arr[:, 0], arr[:, 1]
            axR.scatter(x, y, c=range(len(x)), cmap='viridis', s=10, alpha=0.8)
            axR.plot(x, y, color='gray', alpha=0.5)
            info95 = draw_confidence_ellipse(axR, right_cop, confidence=0.95, use_risk_color=True, alpha=0.3)

            if info95:
                area95 = info95['area_cm2']
                ellipse_data['right'] = {'area_95': area95}
                axR.text(0.02, 0.98, f"95%面积: {area95:.4f} cm$^2$",
                         transform=axR.transAxes, va='top', fontsize=9,
                         bbox=dict(boxstyle="round,pad=0.2", facecolor='white', alpha=0.8))

            if right_center is not None:
                axR.set_xlim(right_center[0] - half_x, right_center[0] + half_x)
                axR.set_ylim(right_center[1] - half_y, right_center[1] + half_y)

        axR.xaxis.set_major_locator(MultipleLocator(2))
        axR.xaxis.set_minor_locator(MultipleLocator(0.5))
        axR.yaxis.set_major_locator(MultipleLocator(1))
        axR.yaxis.set_minor_locator(MultipleLocator(0.5))
        axR.grid(True, which='major', alpha=0.5, linewidth=0.8)
        axR.grid(True, which='minor', alpha=0.2, linewidth=0.5)
        axR.set_title('右脚', pad=8)
        axR.set_xlabel('前后摆动')
        axR.set_ylabel('左右摆动')

        # 添加风险等级渐变 colorbar
        add_risk_colorbar(fig, ax_position=[0.91, 0.25, 0.02, 0.5], vmin=0, vmax=5)

        pdf.savefig(fig)

        # --- B. PNG 图片保存逻辑 ---
        if save_images_dir:
            fig_png, (p_axL, p_axR) = plt.subplots(1, 2, figsize=(12, 5))

            # 左脚使用校正后的 left_cop 数据
            if left_cop and len(left_cop) >= 3:
                arr = np.array(left_cop)
                p_axL.scatter(arr[:, 0], arr[:, 1], c=range(len(arr)), cmap='viridis', s=10, alpha=0.8)
                p_axL.plot(arr[:, 0], arr[:, 1], color='gray', alpha=0.5)
                info95_left = draw_confidence_ellipse(p_axL, left_cop, confidence=0.95, use_risk_color=True, alpha=0.3)
                if info95_left:
                    area95_left = info95_left['area_cm2']
                    p_axL.text(0.02, 0.98, f"95%面积: {area95_left:.4f} cm$^2$",
                               transform=p_axL.transAxes, va='top', fontsize=9,
                               bbox=dict(boxstyle="round,pad=0.2", facecolor='white', alpha=0.8))
                if left_center is not None:
                    p_axL.set_xlim(left_center[0] - half_x, left_center[0] + half_x)
                    p_axL.set_ylim(left_center[1] - half_y, left_center[1] + half_y)
            p_axL.set_title('Left Foot')
            p_axL.set_xlabel('前后摆动')  # ✅ 新增
            p_axL.set_ylabel('左右摆动')  # ✅ 新增
            p_axL.grid(True, alpha=0.3)

            # 右脚使用校正后的 right_cop 数据
            if right_cop and len(right_cop) >= 3:
                arr = np.array(right_cop)
                p_axR.scatter(arr[:, 0], arr[:, 1], c=range(len(arr)), cmap='viridis', s=10, alpha=0.8)
                p_axR.plot(arr[:, 0], arr[:, 1], color='gray', alpha=0.5)
                info95_right = draw_confidence_ellipse(p_axR, right_cop, confidence=0.95, use_risk_color=True, alpha=0.3)
                if info95_right:
                    area95_right = info95_right['area_cm2']
                    p_axR.text(0.02, 0.98, f"95%面积: {area95_right:.4f} cm$^2$",
                               transform=p_axR.transAxes, va='top', fontsize=9,
                               bbox=dict(boxstyle="round,pad=0.2", facecolor='white', alpha=0.8))
                if right_center is not None:
                    p_axR.set_xlim(right_center[0] - half_x, right_center[0] + half_x)
                    p_axR.set_ylim(right_center[1] - half_y, right_center[1] + half_y)
            p_axR.set_title('Right Foot')
            p_axR.set_xlabel('前后摆动')  # ✅ 新增
            p_axR.set_ylabel('左右摆动')  # ✅ 新增
            p_axR.grid(True, alpha=0.3)

            # PNG也添加colorbar
            add_risk_colorbar(fig_png, ax_position=[0.92, 0.15, 0.015, 0.7], vmin=0, vmax=5)

            confidence_ellipse_path = os.path.join(save_images_dir, 'confidence_ellipse.png')
            fig_png.tight_layout(rect=[0, 0, 0.90, 1])
            fig_png.savefig(confidence_ellipse_path, dpi=150)
            image_paths['confidence_ellipse'] = confidence_ellipse_path
            print(f"  ✅ COP置信椭圆(风险颜色版): confidence_ellipse.png")
            plt.close(fig_png)

        plt.close(fig)
        # ==========================================
        # 6) 足弓指标表 (只保留 PDF 生成，PNG 不需要，因为 JSON 会传数据)
        # ==========================================
        def safe_format(v, d=2):
            return "N/A" if v is None else f"{v:.{d}f}"

        fig = new_fig(f'足弓指标汇总{title_suffix}')
        gs = make_gs(fig, nrows=2, ncols=1, top=0.90, bottom=0.08, hspace=0.10)
        left = arch_results["left_foot"]
        right = arch_results["right_foot"]

        ax_tbl = fig.add_subplot(gs[0, 0])
        ax_tbl.axis('off')
        table_data = [
            ['指标', '左脚', '右脚'],
            ['足弓指数（AI）', safe_format(left["area_index"], 4), safe_format(right["area_index"], 4)],
            ['足弓类型（AI）', left["area_type"], right["area_type"]],
            ['足长(cm)', safe_format(additional_data["left_length"], 2),
             safe_format(additional_data["right_length"], 2)],
            ['足宽(cm)', safe_format(additional_data["left_width"], 2), safe_format(additional_data["right_width"], 2)],
            ['总面积(cm²)', safe_format(additional_data["left_area"]["total_area_cm2"], 2),
             safe_format(additional_data["right_area"]["total_area_cm2"], 2)],
            ['前足面积(cm²)', safe_format(additional_data["left_area"]["area_cm2"][0], 2),
             safe_format(additional_data["right_area"]["area_cm2"][0], 2)],
            ['中足面积(cm²)', safe_format(additional_data["left_area"]["area_cm2"][1], 2),
             safe_format(additional_data["right_area"]["area_cm2"][1], 2)],
            ['后足面积(cm²)', safe_format(additional_data["left_area"]["area_cm2"][2], 2),
             safe_format(additional_data["right_area"]["area_cm2"][2], 2)],
            ['前足压力(%)', safe_format(additional_data["left_pressure"]["前足"] * 100, 1),
             safe_format(additional_data["right_pressure"]["前足"] * 100, 1)],
            ['中足压力(%)', safe_format(additional_data["left_pressure"]["中足"] * 100, 1),
             safe_format(additional_data["right_pressure"]["中足"] * 100, 1)],
            ['后足压力(%)', safe_format(additional_data["left_pressure"]["后足"] * 100, 1),
             safe_format(additional_data["right_pressure"]["后足"] * 100, 1)],
            ['COP距整体中心(cm)', safe_format(additional_data["cop_results"]["dist_left_to_both"], 2),
             safe_format(additional_data["cop_results"]["dist_right_to_both"], 2)],
            ['左右脚前后差(cm)', safe_format(additional_data["cop_results"]["left_forward"], 2), '-'],
        ]

        table = ax_tbl.table(
            cellText=table_data[1:], colLabels=table_data[0],
            cellLoc='center', loc='center',
            bbox=[0.03, 0.02, 0.94, 0.96]
        )
        table.auto_set_font_size(False)
        table.set_fontsize(10)
        table.scale(1, 3.0)

        for (i, j), cell in table.get_celld().items():
            cell.set_linewidth(0.5)
            cell.set_height(0.06)
            cell.set_text_props(va='center', ha='center', fontsize=9)
            if i == 0:
                cell.set_facecolor('#F9A602')
                cell.set_text_props(color='white', weight='bold', size=9, va='center', ha='center')
            elif j == 0:
                cell.set_facecolor('#FFF3CD')
                cell.set_text_props(weight='bold', size=9, va='center', ha='center')

        ax_note = fig.add_subplot(gs[1, 0])
        ax_note.axis('off')
        explanation = (
            "【足弓指数（AI）】足弓指数(AI)是通过计算中足面积与前足、中足、后足总面积的比例来评估的。比例值越大，说明中足的接触面积越大，足弓越低。正常范围是0.21到0.26，如果超过0.26则可能提示存在高平足问题。\n"
            "\n"
            "【足长】脚踩在地上时，从脚趾头最前端到脚跟最后端的直线距离。有助于看清双脚是否对称，确定足长，便于选择大小合适的鞋子。\n"
            "\n"
            "【足宽】足印最宽处的横向距离，通常指脚掌最宽处到脚跟最宽处的直线距离。\n"
            "\n"
            "【总面积】脚掌和地面完全接触的面积。如果左右脚的接触面积差别超过15%，提示双脚受力不均，需留意是否有走路姿势问题或脚部异常。\n"
            "\n"
            "【前/中/后足面积】脚掌不同部分（前脚掌、足弓中间、后脚跟）和地面接触的面积大小。前足面积大说明前脚掌（脚趾到脚掌前半部分）贴地多，可能是走路时前脚掌用劲大，如踮脚、跑步蹬地发力。中足面积大说明足弓中间部分（脚心）贴地多，提示足弓比较低，如扁平足。后足面积大说明后脚跟（脚后跟）贴地多。\n"
            "\n"
            "【前/中/后足压力】脚掌不同部位（前脚掌、足弓、后脚跟）承受的体重比例。前足压力是指脚趾到脚掌前半部分承受的体重比例，正常占40%~50%。中足压力是指足弓中间部分承受的体重比例，正常只有5%~10%。如果太高，可能提示足弓较低或扁平足。后足压力是指脚后跟承受的体重比例，正常占40%~50%。\n"
            "\n"
            "【COP距整体中心】单脚踩地时，脚底压力中心到双脚总压力中心的距离。距离越小说明脚越靠近身体重心，承重越均匀；距离越大说明脚偏了，可能走路姿势不太稳。\n"
            "\n"
            "【左右脚前后差】左脚COP相对右脚的前后位置差。如果数值是正的，说明左脚的压力中心比右脚更靠前，也就是左脚“往前探”了。如果数值是负的，说明右脚的压力中心比左脚更靠前，也就是右脚“往前探”了。该数据有助于检验站姿是否歪。"
        )
        ax_note.text(-0.05, 0.95, explanation, fontsize=7, va='top', ha='left', linespacing=1.2)

        pdf.savefig(fig)

        # 这里不保存表格 PNG，因为新版报告使用 JSON 数据渲染
        plt.close(fig)

        # ==========================================
        # 7) COP统计指标表 (只保留 PDF 生成)
        # ==========================================
        fig = new_fig('COP统计指标汇总')
        gs = make_gs(fig, nrows=2, ncols=1, top=0.90, bottom=0.08, hspace=0.10)

        ax_tbl = fig.add_subplot(gs[0, 0])
        ax_tbl.axis('off')
        sd = [
            ['参数', '数值(单位)'],
            ['压力中心轨迹长度', f"{cop_time['path_length']:.2f} mm"],
            ['压力中心活动总面积', f"{cop_time['contact_area']:.2f} mm²"],
            ['压力中心最大摆幅', f"{cop_time['major_axis']:.2f} mm"],
            ['压力中心稳定摆幅', f"{cop_time['minor_axis']:.2f} mm"],
            ['压力中心摆动幅度系数', f"{cop_time['ls_ratio']:.2f}"],
            ['压力中心摆动均匀系数', f"{cop_time['eccentricity']:.2f}"],
            ['压力中心左右摆动幅度系数', f"{cop_time['delta_y']:.2f} "],
            ['压力中心前后摆动幅度系数', f"{cop_time['delta_x']:.2f} "],
            ['压力中心最大离心', f"{cop_time['max_displacement']:.2f} mm"],
            ['压力中心最小离心', f"{cop_time['min_displacement']:.2f} mm"],
            ['压力中心偏移平均速度', f"{cop_time['avg_velocity']:.2f} mm/s"],
            ['压力中心摆动强度', f"{cop_time['rms_displacement']:.2f} mm"],
            ['压力中心左右方向标准差(X标准差)', f"{cop_time['std_y']:.2f} mm"],
            ['压力中心前后方向标准差(Y标准差)', f"{cop_time['std_x']:.2f} mm"],
        ]

        table = ax_tbl.table(
            cellText=sd[1:], colLabels=sd[0],
            cellLoc='center', loc='center',
            bbox=[0.05, 0.02, 0.90, 0.96]
        )
        table.auto_set_font_size(False)
        table.set_fontsize(10)
        table.scale(1, 3.0)

        for (i, j), cell in table.get_celld().items():
            cell.set_linewidth(0.5)
            cell.set_height(0.06)
            cell.set_text_props(va='center', ha='center', fontsize=9)
            if i == 0:
                cell.set_facecolor('#66B2FF')
                cell.set_text_props(color='white', weight='bold', size=9, va='center', ha='center')
            elif j == 0:
                cell.set_facecolor('#E8F3FF')
                cell.set_text_props(weight='bold', size=9, va='center', ha='center')

        ax_note = fig.add_subplot(gs[1, 0])
        ax_note.axis('off')
        explanation = (
            "【压力中心轨迹长度】压力中心点移动的总路径长度。数值越大说明身体摆动越频繁，平衡控制越差。正常站立时，30秒内轨迹长度应小于1000毫米（mm）。如果超过1000mm，可能提示平衡能力较弱。\n轨迹长度越短，平衡越好；越长，平衡越差。\n"
            "\n"
            "【压力中心活动总面积】压力中心点活动范围的面积。数值越大说明摆动幅度越大，姿势稳定性越差。老年人通常比年轻人大 20~30%。\n"
            "\n"
            "【压力中心最大摆幅】COP椭圆的最大直径。代表主要摆动方向的幅度。配合长/短轴比判断摆动模式。如果长轴太长，说明站立方向重心不稳；配合“长/短轴比”看，能判断“前后晃”还是“左右晃”更明显。\n"
            "\n"
            "【压力中心稳定摆幅】COP椭圆的最小直径。代表次要摆动方向的幅度。数值越小说明该方向控制越好。短轴数值越小，说明这个方向控制得越好，如果短轴太长，可能说明左右容易歪。\n"
            "\n"
            "【压力中心摆动幅度系数】压力中心点椭圆的长轴与短轴之比。比值越大说明摆动方向性越明显。\n"
            "\n"
            "【压力中心摆动均匀系数】COP到平均中心的最大距离，反映极端摆动情况。突然增大可能提示失去平衡。\n"
            "\n"
            "【压力中心左右摆动幅度系数】左右方向最大摆动幅度。数值越大说明左右稳定性越差。\n"
            "\n"
            "【压力中心前后摆动幅度系数】前后方向最大摆动幅度。数值越大说明前后稳定性越差。\n"
            "\n"

            "【压力中心最大离心】COP点到平均中心的最大距离。临床意义：反映平衡控制的极限能力或临界点。该数值的突然增大或出现异常离群点，可能预示着平衡控制系统曾短暂处于失效边缘，是极有价值的风险信号。\n"
            "\n"
            "【压力中心最小离心】COP点到平均中心的最小距离。临床意义：数值小且稳定，表明受试者有能力将重心精确地调整回中心区域，具备良好的姿势精细控制能力。\n"
            "\n"
            "【压力中心偏移平均速度】COP移动的平均速度。临床意义：与轨迹长度高度相关，同样反映姿势控制的能量消耗和调整频率。速度越快，表明平衡系统越“忙碌”，控制效率越低。\n"
            "\n"
            "【压力中心摆动强度】压力中心点偏移的均方根(RMS)，综合反映摆动强度，是评估COP摆动幅度的金标准指标，其数值是揭示姿势控制神经肌肉效率的关键指标。值增高表明控制效率下降，需要付出更多努力维持稳定，与衰老、神经功能缺损及跌倒风险增高密切相关\n"
            "\n"
            "【压力中心左右方向标准差(X标准差)】ML方向位置的离散度。临床意义：数值越大，表明侧向摆动越不稳定、越不规律。是评估ML方向动态稳定性的重要参数\n"
            "\n"
            "【压力中心前后方向标准差(Y标准差)】AP方向位置的离散度。临床意义：数值越大，表明前后方向摆动越不规律。"
        )
        ax_note.text(-0.05, 0.95, explanation, fontsize=7, va='top', ha='left', linespacing=1.2)
        pdf.savefig(fig)
        plt.close(fig)

    print(f"✅ PDF 报告已保存：{save_pdf_path}")

    # ========== 保存JSON数据文件（自动覆盖）==========
    def convert_to_serializable(obj):
        """递归转换numpy类型为JSON可序列化类型"""
        if isinstance(obj, dict):
            return {k: convert_to_serializable(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [convert_to_serializable(item) for item in obj]
        elif isinstance(obj, (np.integer, int)):
            return int(obj)
        elif isinstance(obj, (np.floating, float)):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        else:
            return obj

    json_data = {
        "metadata": {
            "report_type": "足底压力分析",
            "generated_at": pd.Timestamp.now().strftime("%Y-%m-%d %H:%M:%S"),
            "pdf_report": str(save_pdf_path),
            "images_dir": save_images_dir,
            "frame_count": arch_results.get('frame_count', 0),
            "is_multi_frame": arch_results.get('is_multi_frame', False)
        },

        "image_paths": image_paths,

        "cop_data": {
            "left_cop": left_cop if left_cop else [],
            "right_cop": right_cop if right_cop else []
        },

        "cop_time_series": cop_time,

        "ellipse_data": ellipse_data,

        "arch_features": {
            "left_foot": arch_results.get("left_foot", {}),
            "right_foot": arch_results.get("right_foot", {})
        },

        "additional_data": additional_data
    }

    json_data = convert_to_serializable(json_data)

    with open(save_json_path, 'w', encoding='utf-8') as f:
        json.dump(json_data, f, ensure_ascii=False, indent=2)

    print(f"✅ JSON数据已保存（自动覆盖）: {save_json_path}")

    return image_paths
def cal_cop_fromData(data_array, threshold_ratio=0.8, fps=42, r_radius=0.1, time_window=0.5,
                     show_plots=False, save_path=None, rotate_data=True, save_pdf_path=None,save_images_dir=None):
    """
    分析数组中的足底压力数据（主函数）- 生成PDF报告
    ✅ 确保足弓区域图和热力图基于同一个平均压力帧
    """
    print(f"正在分析数据数组，共 {len(data_array)} 行数据")
    # 当上游已经传入预处理后的 64x64 数据时（API/PDF 主流程会这样做），
    # rotate_data=False 表示不要再做几何变换。之前这里仍然执行 fliplr，
    # 会让 COP 轨迹与 peak_frame_data / section_coords 的坐标系错开。
    df = preprocess_data_array(
        data_array,
        rotate_90_ccw=rotate_data,
        mirrored_horizon=rotate_data,
    )

    # 矢量化压力曲线
    left_curve, right_curve = extract_pressure_curves(data_array)

    # COP轨迹
    left_cop, right_cop = calculate_cop_trajectories(df, left_curve, right_curve, threshold_ratio)

    # ✅ 足弓指标（多帧时可视化使用平均压力帧）
    arch_results = calculate_complete_arch_features(data_array, left_curve, right_curve, False)
    if arch_results is None:
        print("无法计算足弓特征")
        return None

    # ✅ 关键：从arch_results获取峰值帧索引
    peak_index = arch_results.get('peak_frame_index', 0)
    peak_frame_data = arch_results.get('peak_frame_data')

    visual_frame_type = arch_results.get('visual_frame_type', 'peak')
    print(f"使用{visual_frame_type}帧进行所有可视化（峰值帧索引: {peak_index}）")

    # COP统计与摇摆
    left_cop_metrics = calculate_cop_metrics(left_cop)
    right_cop_metrics = calculate_cop_metrics(right_cop)
    left_sway_features = calculate_sway_features(left_cop, fps, r_radius, time_window)
    right_sway_features = calculate_sway_features(right_cop, fps, r_radius, time_window)

    # ✅ 使用可视化帧的分区数据（已在arch_results中）
    left_section_coords = arch_results['left_foot']['section_coords']
    right_section_coords = arch_results['right_foot']['section_coords']
    left_max_area = arch_results['left_foot']['max_area']
    right_max_area = arch_results['right_foot']['max_area']

    # 面积与压力分配（基于可视化帧）
    left_area_info = calculate_merged_region_areas(left_section_coords, spacing_mm=7)
    right_area_info = calculate_merged_region_areas(right_section_coords, spacing_mm=7)

    # ✅ 使用峰值帧计算COP中心
    cop_results = calculate_feet_centers_and_distances(df, left_curve, right_curve)

    # 尺寸（基于可视化帧的max_area）
    x_left_coords = [coord[0] for coord in left_max_area]
    y_left_coords = [coord[1] for coord in left_max_area]
    left_length = (max(x_left_coords) - min(x_left_coords) + 1) * 0.7 + 1.5
    left_width = (max(y_left_coords) - min(y_left_coords) + 1) * 0.7 + 1.5

    x_right_coords = [coord[0] for coord in right_max_area]
    y_right_coords = [coord[1] for coord in right_max_area]
    right_length = (max(x_right_coords) - min(x_right_coords) + 1) * 0.7 + 1.5
    right_width = (max(y_right_coords) - min(y_right_coords) + 1) * 0.7 + 1.5

    # ✅ 使用可视化帧计算压力分布
    matrix = np.array(peak_frame_data, dtype=float).reshape(64, 64)
    left_pressure = calculate_region_pressures(left_section_coords, matrix)
    right_pressure = calculate_region_pressures(right_section_coords, matrix)

    additional_data = {
        "left_length": left_length,
        "right_length": right_length,
        "left_width": left_width,
        "right_width": right_width,
        "left_area": left_area_info,
        "right_area": right_area_info,
        "left_pressure": left_pressure,
        "right_pressure": right_pressure,
        "cop_results": cop_results
    }

    results = {
        'left_cop_metrics': left_cop_metrics,
        'right_cop_metrics': right_cop_metrics,
        'left_sway_features': left_sway_features,
        'right_sway_features': right_sway_features,
        'arch_features': arch_results,
        'additional_data': additional_data,
        'cop_time_series': calculate_cop_time_series(left_cop, right_cop, additional_data),
        'left_cop_trajectory': left_cop,    # 原始COP轨迹点 [[x,y], ...]
        'right_cop_trajectory': right_cop,  # 原始COP轨迹点 [[x,y], ...]
    }

    # 控制台摘要
    if arch_results.get('is_multi_frame', False):
        print(f"\n=== 多帧数据分析结果 ({arch_results.get('frame_count')}帧平均) ===")
        print(f"可视化使用{visual_frame_type}帧 (峰值帧: {peak_index}, 峰值总压力: {arch_results.get('peak_total_pressure', 0)})")
    else:
        print(f"\n=== 单帧数据分析结果 ===")

    print(f"足弓指数： 左 {arch_results['left_foot']['area_index']:.4f} / 右 {arch_results['right_foot']['area_index']:.4f}")
    print(f"足弓类型： 左 {arch_results['left_foot']['area_type']} / 右 {arch_results['right_foot']['area_type']}")


    png_path = None
    if save_pdf_path:          # 只要准备出报告就顺手渲染
        png_path = Path(str(Path(save_pdf_path).with_suffix('')) + '_web_heatmap.png')
        asyncio.run(generate_heatmap_png(arch_results['peak_frame_data'], png_path))
    # 生成PDF报告
    if save_pdf_path:
        # ✅ 修改点：直接使用 save_pdf_path 的父目录
        # 这样图片会生成在 PDF 同级目录下，且每次运行自动覆盖同名图片
        images_dir = os.path.dirname(save_pdf_path)

        # 调用 create_pdf_report
        # 它会生成 cop_trajectory.png, arch_regions.png 等并在 images_dir 下覆盖旧文件
        create_pdf_report(
            left_cop, right_cop, arch_results, additional_data,
            save_pdf_path,
            heatmap_png_path=png_path,
            save_images_dir=images_dir  # 传入目录
        )

        # ==========================================
        # ★ 调用 ReportLab 生成最终精美报告 ★
        # ==========================================
        try:
            import OneStep_template  # 确保 report_generator.py 在同级目录下

            # 推断 JSON 路径 (逻辑是: 把 .pdf 后缀换成 .json)
            # 例如: C:\Report\output.pdf -> C:\Report\output.json
            json_path = str(Path(save_pdf_path).with_suffix('.json'))

            # 调用生成器读取 JSON 和 刚刚覆盖生成的图片
            final_pdf = OneStep_template.generate_report_from_json(json_path)

            print(f"🚀 最终精美报告已生成: {final_pdf}")

        except ImportError:
            print("⚠️ 警告: 未找到 report_generator.py，无法生成最终模板报告。")
        except Exception as e:
            print(f"❌ 生成最终报告时出错: {e}")
            import traceback
            traceback.print_exc()

    # 可选：在屏幕上调试
    if show_plots:
        plot_frame_with_bboxes(matrix, title=f'{visual_frame_type} 热力图 + 外接框')

    return results

def genPDF():
    print(1111)
    file_path = r'C:\Users\xpr12\Desktop\sit2025-9-19+11-40-30高足弓.csv'
    save_pdf_path = r"C:\Users\xpr12\Desktop\foot_pressure_repor333333.pdf"

    # 第一步：读取原始数据（只读取，不做任何处理）
    raw_data = load_csv_data(file_path)

    print(raw_data)
    # 第二步：预处理原始数据（旋转、镜像、去噪）
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

    # 第三步：分析数据（传入已预处理的数据，无需再次旋转）
    results = cal_cop_fromData(
        processed_data,
        show_plots=False,
        save_pdf_path=save_pdf_path,
        rotate_data=False  #关闭二次旋转
    )
    return results



#使用示例
if __name__ == "__main__":
    file_path = r'C:\Users\xpr12\Desktop\jq-win32-x64\jq-win32-x64\resources\data\sit2026-1-27 14-00-59.csv'
    save_pdf_path = r"C:\Users\xpr12\Desktop\foot_pressure_repor233.pdf"
    # 第一步：读取原始数据（只读取，不做任何处理）
    raw_data = load_csv_data(file_path)

    # 第二步：预处理原始数据（旋转、镜像、去噪）
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

    # 第三步：分析数据（传入已预处理的数据，无需再次旋转）
    results = cal_cop_fromData(
        processed_data,
        show_plots=False,
        save_pdf_path=save_pdf_path,
        rotate_data=False  #关闭二次旋转
    )


