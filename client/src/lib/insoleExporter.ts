/**
 * 鞋垫3D模型导出工具 v2
 * 导出真正的晶格体结构（strut杆件 + joint球节点），与3D预览一致
 * 支持 STL（3D打印标准格式）和 GLTF/GLB（通用3D交换格式）
 */

import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { INSOLE_CONTOURS } from '@/lib/insoleContours';
import type { ZoneSupportCompensation } from '@/components/LatticeInsole3D';

// ============ 轮廓工具函数（与LatticeInsole3D保持一致） ============

function scaleContour(
  points: readonly (readonly [number, number])[],
  footLength: number,
  footWidth: number,
  foot: 'left' | 'right'
): [number, number][] {
  const ys = points.map(p => p[1]);
  const xs = points.map(p => p[0]);
  const normH = Math.max(...ys) - Math.min(...ys);
  const normW = Math.max(...xs) - Math.min(...xs);
  
  const scaleY = footLength / normH;
  const scaleX = footWidth / normW;
  
  const minY = Math.min(...ys);
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const maxY = Math.max(...ys);
  
  return points.map(([x, y]) => {
    const sx = -(x - centerX) * scaleX;
    let sz: number;
    if (foot === 'left') {
      sz = -((y - minY) * scaleY - footLength / 2);
    } else {
      sz = -(((maxY - y + minY) - minY) * scaleY - footLength / 2);
    }
    return [sx, sz];
  });
}

function pointInPolygon(px: number, py: number, polygon: [number, number][]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function getBounds(polygon: [number, number][]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = polygon.map(p => p[0]);
  const ys = polygon.map(p => p[1]);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys)
  };
}

function createSmoothZoneWeight(value: number, start: number, end: number): number {
  if (value <= start || value >= end) return 0;
  const t = (value - start) / (end - start);
  return Math.sin(t * Math.PI) ** 2;
}

function getLocalCompensationCm(
  x: number,
  z: number,
  footLength: number,
  foot: 'left' | 'right',
  compensation: ZoneSupportCompensation
): number {
  const normalizedZ = (-z + footLength / 2) / footLength;
  const halfWidth = footLength * 0.2;
  const normalizedX = Math.max(-1, Math.min(1, x / halfWidth));
  const innerSide = foot === 'left' ? normalizedX : -normalizedX;
  const forefootWeight = createSmoothZoneWeight(normalizedZ, 0.58, 0.92) * (0.75 + 0.25 * (1 - Math.abs(normalizedX)));
  const archWeight = createSmoothZoneWeight(normalizedZ, 0.28, 0.56) * (0.4 + 0.6 * Math.max(0, innerSide));
  const heelWeight = createSmoothZoneWeight(normalizedZ, 0.02, 0.32) * (0.8 + 0.2 * (1 - Math.abs(normalizedX)));

  return (
    (compensation.forefoot / 10) * forefootWeight +
    (compensation.arch / 10) * archWeight +
    (compensation.heel / 10) * heelWeight
  );
}

function getInsoleHeight(
  x: number, z: number,
  footLength: number,
  archCorrection: number,
  baseThickness: number,
  foot: 'left' | 'right',
  heelThickness: number = 0,
  compensation: ZoneSupportCompensation = { forefoot: 0, arch: 0, heel: 0 }
): number {
  const normalizedZ = (-z + footLength / 2) / footLength;
  const archCenter = 0.42;
  const archWidth = 0.18;
  const archDist = Math.abs(normalizedZ - archCenter) / archWidth;
  const archProfile = archDist < 1 ? Math.cos(archDist * Math.PI / 2) ** 2 : 0;

  const halfWidth = footLength * 0.2;
  const normalizedX = Math.max(-1, Math.min(1, x / halfWidth));
  const rawInner = foot === 'left' ?
    (1 + normalizedX) / 2 :
    (1 - normalizedX) / 2;
  const innerFactor = Math.max(0, Math.min(1, rawInner));

  const archHeight = (archCorrection / 10) * archProfile * (0.3 + 0.7 * innerFactor);
  const heelNorm = normalizedZ;
  const heelCup = heelNorm < 0.15 ? (1 - heelNorm / 0.15) * 0.15 : 0;

  const heelThickCm = heelThickness / 10;
  const heelCushionZone = 0.35;
  const heelCushion = normalizedZ < heelCushionZone
    ? heelThickCm * Math.cos(normalizedZ / heelCushionZone * Math.PI / 2) ** 2
    : 0;

  const baseHeight = baseThickness + archHeight + heelCup + heelCushion;
  const localCompensation = getLocalCompensationCm(x, z, footLength, foot, compensation);
  const minThickness = Math.max(0.12, baseThickness * 0.55);
  const adjustedHeight = baseHeight + localCompensation;

  return localCompensation >= 0 ? adjustedHeight : Math.max(minThickness, adjustedHeight);
}

// ============ 晶格体几何生成 ============

/** 创建一根从start到end的圆柱杆件几何体 */
function createStrutGeometry(
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  segments: number = 6
): THREE.BufferGeometry | null {
  const length = start.distanceTo(end);
  if (length < 0.01) return null;
  
  const cyl = new THREE.CylinderGeometry(radius, radius, length, segments, 1);
  
  // 计算旋转和位移
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(end, start).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  
  const matrix = new THREE.Matrix4();
  matrix.compose(mid, quat, new THREE.Vector3(1, 1, 1));
  cyl.applyMatrix4(matrix);
  
  return cyl;
}

/** 创建一个球节点几何体 */
function createJointGeometry(
  position: THREE.Vector3,
  radius: number,
  segments: number = 6
): THREE.BufferGeometry {
  const sphere = new THREE.SphereGeometry(radius, segments, segments);
  sphere.translate(position.x, position.y, position.z);
  return sphere;
}

// ============ 晶格体数据生成（复用LatticeInsole3D逻辑） ============

interface LatticeData {
  struts: Array<{ start: THREE.Vector3; end: THREE.Vector3 }>;
  joints: THREE.Vector3[];
}

function generateLatticeData(
  foot: 'left' | 'right',
  footLength: number,
  footWidth: number,
  archCorrection: number,
  baseThickness: number,
  heelThickness: number = 0,
  latticeDensity: number = 3,
  compensation: ZoneSupportCompensation = { forefoot: 0, arch: 0, heel: 0 }
): LatticeData {
  const outerRaw = foot === 'left' ? INSOLE_CONTOURS.leftOuter : INSOLE_CONTOURS.rightOuter;
  const outerContour = scaleContour(outerRaw, footLength, footWidth, foot);
  const bounds = getBounds(outerContour);
  
  // 晶格体密度档位到cellSize的映射
  const densityMap: Record<number, number> = { 1: 1.0, 2: 0.85, 3: 0.65, 4: 0.5, 5: 0.4 };
  const cellSize = densityMap[latticeDensity] ?? 0.65;
  const struts: Array<{ start: THREE.Vector3; end: THREE.Vector3 }> = [];
  const joints: THREE.Vector3[] = [];
  
  const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
  
  type GridPoint = { pos: THREE.Vector3; valid: boolean };
  
  const makeGrid = (heightFactor: number): GridPoint[][] => {
    const grid: GridPoint[][] = [];
    for (let r = 0; r <= rows; r++) {
      const row: GridPoint[] = [];
      for (let c = 0; c <= cols; c++) {
        const x = bounds.minX + c * cellSize;
        const z = bounds.minY + r * cellSize;
        if (pointInPolygon(x, z, outerContour)) {
          const h = getInsoleHeight(x, z, footLength, archCorrection, baseThickness, foot, heelThickness, compensation) * heightFactor;
          row.push({ pos: new THREE.Vector3(x, h, z), valid: true });
        } else {
          row.push({ pos: new THREE.Vector3(0, 0, 0), valid: false });
        }
      }
      grid.push(row);
    }
    return grid;
  };
  
  const topGrid = makeGrid(1.0);
  const botGrid = makeGrid(0.0);
  
  // 中间层（偏移半格）
  const midGrid: GridPoint[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: GridPoint[] = [];
    for (let c = 0; c < cols; c++) {
      const x = bounds.minX + (c + 0.5) * cellSize;
      const z = bounds.minY + (r + 0.5) * cellSize;
      if (pointInPolygon(x, z, outerContour)) {
        const h = getInsoleHeight(x, z, footLength, archCorrection, baseThickness, foot, heelThickness, compensation) * 0.5;
        row.push({ pos: new THREE.Vector3(x, h, z), valid: true });
      } else {
        row.push({ pos: new THREE.Vector3(0, 0, 0), valid: false });
      }
    }
    midGrid.push(row);
  }
  
  const addStrut = (a: THREE.Vector3, b: THREE.Vector3) => {
    if (a.distanceTo(b) >= 0.01) {
      struts.push({ start: a.clone(), end: b.clone() });
    }
  };
  
  // 顶面水平连接
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (!topGrid[r][c].valid) continue;
      const p = topGrid[r][c].pos;
      joints.push(p.clone());
      if (c < cols && topGrid[r][c + 1].valid) addStrut(p, topGrid[r][c + 1].pos);
      if (r < rows && topGrid[r + 1][c].valid) addStrut(p, topGrid[r + 1][c].pos);
    }
  }
  
  // 底面水平连接
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (!botGrid[r][c].valid) continue;
      const p = botGrid[r][c].pos;
      joints.push(p.clone());
      if (c < cols && botGrid[r][c + 1].valid) addStrut(p, botGrid[r][c + 1].pos);
      if (r < rows && botGrid[r + 1][c].valid) addStrut(p, botGrid[r + 1][c].pos);
    }
  }
  
  // 垂直连接
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (topGrid[r][c].valid && botGrid[r][c].valid) {
        addStrut(topGrid[r][c].pos, botGrid[r][c].pos);
      }
    }
  }
  
  // 对角线连接（通过中间层）
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!midGrid[r][c].valid) continue;
      const mid = midGrid[r][c].pos;
      joints.push(mid.clone());
      
      const corners = [
        { r, c }, { r, c: c + 1 }, { r: r + 1, c }, { r: r + 1, c: c + 1 }
      ];
      
      for (const cr of corners) {
        if (topGrid[cr.r]?.[cr.c]?.valid) addStrut(mid, topGrid[cr.r][cr.c].pos);
        if (botGrid[cr.r]?.[cr.c]?.valid) addStrut(mid, botGrid[cr.r][cr.c].pos);
      }
    }
  }
  
  // 轮廓边缘壁 — 使用所有轮廓点（光滑边缘）
  // 每隔2个点取一个，保证光滑度同时控制面数
  const edgeStep = Math.max(1, Math.floor(outerContour.length / 160));
  for (let i = 0; i < outerContour.length; i += edgeStep) {
    const [x1, z1] = outerContour[i];
    const ni = (i + edgeStep) % outerContour.length;
    const [x2, z2] = outerContour[ni];
    
    const h1 = getInsoleHeight(x1, z1, footLength, archCorrection, baseThickness, foot, heelThickness);
    const h2 = getInsoleHeight(x2, z2, footLength, archCorrection, baseThickness, foot, heelThickness);
    
    // 顶边
    addStrut(new THREE.Vector3(x1, h1, z1), new THREE.Vector3(x2, h2, z2));
    // 底边
    addStrut(new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x2, 0, z2));
    // 垂直连接（每隔一个点加一根）
    if (i % (edgeStep * 2) === 0) {
      addStrut(new THREE.Vector3(x1, h1, z1), new THREE.Vector3(x1, 0, z1));
      joints.push(new THREE.Vector3(x1, h1, z1));
      joints.push(new THREE.Vector3(x1, 0, z1));
    }
  }
  
  return { struts, joints };
}

// ============ 晶格体Mesh生成 ============

function generateLatticeMesh(
  foot: 'left' | 'right',
  footLength: number,
  footWidth: number,
  archCorrection: number,
  baseThickness: number,
  heelThickness: number,
  latticeDensity: number,
  compensation: ZoneSupportCompensation,
  color: string
): THREE.Mesh {
  const lattice = generateLatticeData(foot, footLength, footWidth, archCorrection, baseThickness, heelThickness, latticeDensity, compensation);
  
  // 杆件和节点半径根据密度自适应
  const strutRadius = latticeDensity <= 2 ? 0.05 : latticeDensity >= 4 ? 0.03 : 0.04;
  const jointRadius = latticeDensity <= 2 ? 0.08 : latticeDensity >= 4 ? 0.05 : 0.07;
  const strutSegments = 6; // 圆柱截面段数（6边形近似圆柱）
  const jointSegments = 5; // 球体段数
  
  const geometries: THREE.BufferGeometry[] = [];
  
  // 生成所有杆件几何体
  for (const strut of lattice.struts) {
    const geo = createStrutGeometry(strut.start, strut.end, strutRadius, strutSegments);
    if (geo) geometries.push(geo);
  }
  
  // 生成所有节点几何体
  for (const joint of lattice.joints) {
    geometries.push(createJointGeometry(joint, jointRadius, jointSegments));
  }
  
  // 合并所有几何体为一个
  if (geometries.length === 0) {
    throw new Error('No geometry generated');
  }
  
  const mergedGeometry = mergeGeometries(geometries, false);
  
  // 清理临时几何体
  for (const geo of geometries) {
    geo.dispose();
  }
  
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.35,
    metalness: 0.15,
  });
  
  // 将坐标从cm转为mm（×10），STL文件无单位信息，切片软件默认按mm解读
  mergedGeometry.scale(10, 10, 10);
  
  const mesh = new THREE.Mesh(mergedGeometry, material);
  mesh.name = `lattice_insole_${foot}`;
  
  return mesh;
}

// ============ 导出函数 ============

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 导出鞋垫为STL格式（晶格体结构，适合3D打印）
 */
export function exportInsoleSTL(
  foot: 'left' | 'right',
  footLength: number,
  footWidth: number,
  archCorrection: number,
  baseThickness: number,
  heelThickness: number = 0,
  latticeDensity: number = 3,
  forefootCompensation: number = 0,
  archCompensation: number = 0,
  heelCompensation: number = 0,
  color: string = '#B0B0B0',
  userName?: string
): void {
  const mesh = generateLatticeMesh(
    foot,
    footLength,
    footWidth,
    archCorrection,
    baseThickness,
    heelThickness,
    latticeDensity,
    { forefoot: forefootCompensation, arch: archCompensation, heel: heelCompensation },
    color
  );
  
  const exporter = new STLExporter();
  const stlData = exporter.parse(mesh, { binary: true });
  
  const blob = new Blob([stlData], { type: 'application/octet-stream' });
  const footLabel = foot === 'left' ? '左脚' : '右脚';
  const prefix = userName ? `${userName}_` : '';
  const filename = `${prefix}${footLabel}_晶格体鞋垫_L${footLength}xW${footWidth}_矫正${archCorrection}mm.stl`;
  
  downloadBlob(blob, filename);
  
  // 清理
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
}

/**
 * 导出鞋垫为GLTF/GLB格式（晶格体结构）
 */
export async function exportInsoleGLTF(
  foot: 'left' | 'right',
  footLength: number,
  footWidth: number,
  archCorrection: number,
  baseThickness: number,
  heelThickness: number = 0,
  latticeDensity: number = 3,
  forefootCompensation: number = 0,
  archCompensation: number = 0,
  heelCompensation: number = 0,
  color: string = '#B0B0B0',
  userName?: string
): Promise<void> {
  const mesh = generateLatticeMesh(
    foot,
    footLength,
    footWidth,
    archCorrection,
    baseThickness,
    heelThickness,
    latticeDensity,
    { forefoot: forefootCompensation, arch: archCompensation, heel: heelCompensation },
    color
  );
  
  const scene = new THREE.Scene();
  scene.add(mesh);
  
  const exporter = new GLTFExporter();
  
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        let blob: Blob;
        if (result instanceof ArrayBuffer) {
          blob = new Blob([result], { type: 'application/octet-stream' });
        } else {
          const jsonStr = JSON.stringify(result, null, 2);
          blob = new Blob([jsonStr], { type: 'application/json' });
        }
        
        const footLabel = foot === 'left' ? '左脚' : '右脚';
        const prefix = userName ? `${userName}_` : '';
        const ext = result instanceof ArrayBuffer ? 'glb' : 'gltf';
        const filename = `${prefix}${footLabel}_晶格体鞋垫_L${footLength}xW${footWidth}_矫正${archCorrection}mm.${ext}`;
        
        downloadBlob(blob, filename);
        
        // 清理
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        
        resolve();
      },
      (error) => {
        console.error('GLTF导出失败:', error);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        reject(error);
      },
      { binary: true }
    );
  });
}

/**
 * 同时导出左右脚的STL文件
 */
export function exportBothInsoleSTL(
  leftParams: { footLength: number; footWidth: number; archCorrection: number; baseThickness: number },
  rightParams: { footLength: number; footWidth: number; archCorrection: number; baseThickness: number },
  color: string = '#B0B0B0',
  userName?: string
): void {
  exportInsoleSTL('left', leftParams.footLength, leftParams.footWidth, leftParams.archCorrection, leftParams.baseThickness, 0, 3, 0, 0, 0, color, userName);
  setTimeout(() => {
    exportInsoleSTL('right', rightParams.footLength, rightParams.footWidth, rightParams.archCorrection, rightParams.baseThickness, 0, 3, 0, 0, 0, color, userName);
  }, 500);
}

/**
 * 同时导出左右脚的GLTF文件
 */
export async function exportBothInsoleGLTF(
  leftParams: { footLength: number; footWidth: number; archCorrection: number; baseThickness: number },
  rightParams: { footLength: number; footWidth: number; archCorrection: number; baseThickness: number },
  color: string = '#B0B0B0',
  userName?: string
): Promise<void> {
  await exportInsoleGLTF('left', leftParams.footLength, leftParams.footWidth, leftParams.archCorrection, leftParams.baseThickness, 0, 3, 0, 0, 0, color, userName);
  await exportInsoleGLTF('right', rightParams.footLength, rightParams.footWidth, rightParams.archCorrection, rightParams.baseThickness, 0, 3, 0, 0, 0, color, userName);
}
