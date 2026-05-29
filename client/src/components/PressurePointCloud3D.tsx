/**
 * 压力点云视图（第三种视图模式）
 *
 * 设计：
 *   1. 黑色背景
 *   2. 64×64 → 128×128 双线性上采样：密度翻倍，但仍保留离散点的视觉
 *   3. 渲染为小硬圆点（不使用软边精灵）—— 看上去仍然是一颗颗的点
 *   4. jet 色表着色 + 高度抬升 (Y 轴 = 压力)
 *   5. BufferGeometry 复用 + Float32Array 直接写入，避免每帧 GC
 *
 * 交互：OrbitControls — 左键旋转 / 右键平移 / 滚轮缩放
 */

import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

interface Props {
  realtimeData: number[][] | null;
  /** 压力 → 高度的缩放系数，默认 0.45 */
  heightScale?: number;
  /** 单点尺寸（小硬圆点），默认 0.05 */
  pointSize?: number;
}

const ROWS = 64;
const COLS = 64;
const UPSAMPLE = 2;
const UP_N = ROWS * UPSAMPLE; // 128
const TOTAL = UP_N * UP_N;

/** matplotlib jet 色表 */
function jetRGB(t: number): [number, number, number] {
  if (t <= 0) return [0, 0, 0.5];
  if (t >= 1) return [0.5, 0, 0];
  if (t < 0.125) return [0, 0, 0.5 + t / 0.125 * 0.5];
  if (t < 0.375) return [0, (t - 0.125) / 0.25, 1];
  if (t < 0.625) {
    const s = (t - 0.375) / 0.25;
    return [s, 1, 1 - s];
  }
  if (t < 0.875) return [1, 1 - (t - 0.625) / 0.25, 0];
  return [1 - (t - 0.875) / 0.125 * 0.5, 0, 0];
}

function flatten(data: number[][] | null): number[] | null {
  if (!data) return null;
  if (data.length === ROWS * COLS && typeof data[0] === 'number') {
    return data as unknown as number[];
  }
  const out: number[] = [];
  for (const row of data) {
    if (Array.isArray(row)) {
      for (const v of row) out.push(v);
    } else {
      out.push(row as unknown as number);
    }
  }
  return out;
}

/** 生成一张 8px 圆形精灵 alpha 贴图（硬边圆）：让默认方块点变成圆点 */
function makeCircleSprite(): THREE.Texture {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

interface PointsHandle {
  positions: Float32Array;
  colors: Float32Array;
  count: number;
}

function PointCloud({ realtimeData, heightScale = 0.45, pointSize = 0.05 }: Props) {
  const sprite = useMemo(() => makeCircleSprite(), []);
  const pointsRef = useRef<THREE.Points>(null);

  // 一次性分配最大容量缓冲区，后续只改值不重建对象（性能关键）
  const buffers = useMemo<PointsHandle>(() => ({
    positions: new Float32Array(TOTAL * 3),
    colors: new Float32Array(TOTAL * 3),
    count: 0,
  }), []);

  // 静态 BufferGeometry：position/color attribute 复用同一份 typed array
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3));
    g.setDrawRange(0, 0);
    return g;
  }, [buffers]);

  useEffect(() => {
    const flat = flatten(realtimeData);
    if (!flat) {
      geometry.setDrawRange(0, 0);
      (pointsRef.current as unknown as { geometry?: THREE.BufferGeometry } | null);
      return;
    }

    // 计算 vmax（先扫一遍原始 4096 格）
    let vmax = 0;
    for (let i = 0; i < flat.length; i++) if (flat[i] > vmax) vmax = flat[i];
    if (vmax <= 0) {
      geometry.setDrawRange(0, 0);
      const ga = geometry.attributes.position as THREE.BufferAttribute;
      ga.needsUpdate = true;
      return;
    }
    const noiseFloor = vmax * 0.05;

    const step = 0.06 / UPSAMPLE;
    const half = (UP_N - 1) / 2;

    const positions = buffers.positions;
    const colors = buffers.colors;
    let idx = 0;

    // 双线性上采样 + 直接写入缓冲（避免中间数组）
    const lastIdx = ROWS - 1;
    for (let r = 0; r < UP_N; r++) {
      const fr = r / UPSAMPLE;
      const r0 = Math.floor(fr);
      const r1 = r0 < lastIdx ? r0 + 1 : lastIdx;
      const dr = fr - r0;
      const w0r = 1 - dr;
      const w1r = dr;
      for (let c = 0; c < UP_N; c++) {
        const fc = c / UPSAMPLE;
        const c0 = Math.floor(fc);
        const c1 = c0 < lastIdx ? c0 + 1 : lastIdx;
        const dc = fc - c0;
        const v00 = flat[r0 * COLS + c0];
        const v01 = flat[r0 * COLS + c1];
        const v10 = flat[r1 * COLS + c0];
        const v11 = flat[r1 * COLS + c1];
        const v =
          v00 * w0r * (1 - dc) +
          v01 * w0r * dc +
          v10 * w1r * (1 - dc) +
          v11 * w1r * dc;
        if (v <= noiseFloor) continue;
        const t = v >= vmax ? 1 : v / vmax;
        const o = idx * 3;
        positions[o] = (c - half) * step;
        positions[o + 1] = t * heightScale;
        positions[o + 2] = -(r - half) * step;
        const [cr, cg, cb] = jetRGB(t);
        colors[o] = cr;
        colors[o + 1] = cg;
        colors[o + 2] = cb;
        idx++;
      }
    }

    buffers.count = idx;
    geometry.setDrawRange(0, idx);
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    geometry.computeBoundingSphere();
  }, [realtimeData, heightScale, buffers, geometry]);

  return (
    <points ref={pointsRef} geometry={geometry}>
      <pointsMaterial
        size={pointSize}
        vertexColors
        sizeAttenuation
        map={sprite}
        alphaTest={0.5}
        transparent={false}
        depthWrite
      />
    </points>
  );
}

/** 暗色弱网格作为高度参考 */
function GroundGrid() {
  return <gridHelper args={[6, 24, '#222', '#151515']} position={[0, 0, 0]} />;
}

export default function PressurePointCloud3D({ realtimeData, heightScale, pointSize }: Props) {
  return (
    <div className="w-full h-full bg-black relative">
      <Canvas dpr={[1, 1.5]} gl={{ alpha: false, antialias: true }}>
        <color attach="background" args={['#000']} />
        <PerspectiveCamera makeDefault position={[0, 2.4, 3.2]} fov={50} />
        <OrbitControls
          enablePan
          minPolarAngle={0}
          maxPolarAngle={Math.PI / 2}
          target={[0, 0, 0]}
        />
        <ambientLight intensity={0.9} />
        <GroundGrid />
        <PointCloud
          realtimeData={realtimeData}
          heightScale={heightScale}
          pointSize={pointSize}
        />
      </Canvas>
      <div className="absolute bottom-4 left-4 text-xs text-gray-500 pointer-events-none">
        <p>Left Click: Rotate</p>
        <p>Right Click: Pan</p>
        <p>Scroll: Zoom</p>
      </div>
    </div>
  );
}
