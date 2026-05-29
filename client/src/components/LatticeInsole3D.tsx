/**
 * 晶格体3D鞋垫组件 v8 - 支持分区支撑补偿
 *
 * EPS矢量图坐标系分析：
 * - leftOuter: 正Y=脚趾端（宽端），负Y=脚跟端（窄端）
 * - rightOuter: 正Y=脚跟端（窄端），负Y=脚趾端（宽端）——与左脚Y方向相反！
 * 
 * Three.js坐标系（俯视图，从上往下看）：
 * - X轴：左脚在负X（左侧），右脚在正X（右侧）
 * - Z轴：负Z=脚趾端（向前），正Z=脚跟端
 * - Y轴：向上=鞋垫高度
 * 
 * 转换规则：
 * - 左脚：EPS正Y(脚趾) → Three.js负Z(前方)，直接映射
 * - 右脚：EPS负Y(脚趾) → Three.js负Z(前方)，需要翻转Y轴
 * - X轴：两只脚都做镜像翻转
 */

import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows } from '@react-three/drei';
import { Suspense, useMemo, useRef, useEffect, memo } from 'react';
import * as THREE from 'three';
import { INSOLE_CONTOURS } from '@/lib/insoleContours';

// ============ 轮廓工具函数 ============

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
  
  // 右脚EPS轮廓的Y轴方向与左脚相反：
  // 左脚：正Y=脚趾（宽端），负Y=脚跟（窄端）
  // 右脚：正Y=脚跟（窄端），负Y=脚趾（宽端）
  // 需要翻转右脚的Y轴使两只脚的脚趾都映射到Three.js的负Z方向
  const maxY = Math.max(...ys);
  
  return points.map(([x, y]) => {
    const sx = -(x - centerX) * scaleX;
    
    let sz: number;
    if (foot === 'left') {
      // 左脚：正Y=脚趾 → 负Z=前方
      sz = -((y - minY) * scaleY - footLength / 2);
    } else {
      // 右脚：翻转Y轴，使负Y(脚趾)映射到负Z(前方)
      // 翻转：用 maxY - (y - minY) = maxY - y + minY 来反转Y
      sz = -(((maxY - y + minY) - minY) * scaleY - footLength / 2);
      // 简化为: sz = -((maxY - y) * scaleY - footLength / 2)
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

/**
 * 计算鞋垫在某个位置的高度（足弓区域隆起）
 * 
 * z坐标：正值=脚跟端，负值=脚趾端
 * 足弓隆起在内侧更高
 */
export interface ZoneSupportCompensation {
  forefoot: number;
  arch: number;
  heel: number;
}

function createSmoothZoneWeight(value: number, start: number, end: number): number {
  if (value <= start || value >= end) return 0;
  const t = (value - start) / (end - start);
  return Math.sin(t * Math.PI) ** 2;
}

function getCompensationZoneWeights(
  x: number,
  z: number,
  footLength: number,
  foot: 'left' | 'right'
): ZoneSupportCompensation {
  const normalizedZ = (-z + footLength / 2) / footLength;
  const halfWidth = footLength * 0.2;
  const normalizedX = Math.max(-1, Math.min(1, x / halfWidth));
  const innerSide = foot === 'left' ? normalizedX : -normalizedX;

  return {
    forefoot:
      createSmoothZoneWeight(normalizedZ, 0.58, 0.92) *
      (0.75 + 0.25 * (1 - Math.abs(normalizedX))),
    arch:
      createSmoothZoneWeight(normalizedZ, 0.28, 0.56) *
      (0.4 + 0.6 * Math.max(0, innerSide)),
    heel:
      createSmoothZoneWeight(normalizedZ, 0.02, 0.32) *
      (0.8 + 0.2 * (1 - Math.abs(normalizedX))),
  };
}

function getLocalCompensationCm(
  x: number,
  z: number,
  footLength: number,
  foot: 'left' | 'right',
  compensation: ZoneSupportCompensation
): number {
  const weights = getCompensationZoneWeights(x, z, footLength, foot);

  return (
    (compensation.forefoot / 10) * weights.forefoot +
    (compensation.arch / 10) * weights.arch +
    (compensation.heel / 10) * weights.heel
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
  // normalizedZ: 0=heel(脚跟), 1=toe(脚趾)
  const normalizedZ = (-z + footLength / 2) / footLength;

  // 足弓隆起曲线 - 位于30%-55%位置（从脚跟算起）
  const archCenter = 0.42;
  const archWidth = 0.18;
  const archDist = Math.abs(normalizedZ - archCenter) / archWidth;
  const archProfile = archDist < 1 ? Math.cos(archDist * Math.PI / 2) ** 2 : 0;

  // 足弓在内侧更高（内侧隆起，外侧平缓）
  // normalizedX 映射到 [-1, 1]，内侧为正，外侧为负
  const halfWidth = footLength * 0.2; // 近似半足宽
  const normalizedX = Math.max(-1, Math.min(1, x / halfWidth));
  // innerFactor: 0（外侧边缘）→ 1（内侧边缘），clamp到[0,1]
  const rawInner = foot === 'left' ?
    (1 + normalizedX) / 2 :
    (1 - normalizedX) / 2;
  const innerFactor = Math.max(0, Math.min(1, rawInner));

  // 足弓矫正高度：archCorrection(mm) → cm
  // 外侧最低为矫正量的30%，内侧最高为矫正量的100%
  const archHeight = (archCorrection / 10) * archProfile * (0.3 + 0.7 * innerFactor);

  // 脚跟杯状（侧向包裹）
  const heelNorm = normalizedZ;
  const heelCup = heelNorm < 0.15 ? (1 - heelNorm / 0.15) * 0.15 : 0;

  // 足跟缓冲厚度：heelThickness(mm) → cm
  // 足跟缓冲区域：0%~35%（从脚跟算起），使用余弦平滑过渡
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

// ============ Strut数据结构 ============

interface StrutData {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

function computeStrutTransform(start: THREE.Vector3, end: THREE.Vector3): StrutData | null {
  const length = start.distanceTo(end);
  if (length < 0.01) return null;
  
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(end, start).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  
  return {
    position: mid,
    quaternion: quat,
    scale: new THREE.Vector3(1, length, 1),
  };
}

// ============ 单只鞋垫3D网格 ============

const maxInstances = 30000;

type CompensationZoneName = keyof ZoneSupportCompensation;

interface RegionOverlayMeshData {
  zone: CompensationZoneName;
  geometry: THREE.BufferGeometry;
}

const COMPENSATION_DISPLAY_MAX_MM = 1.5;

function getCompensationDisplayColor(localCompensationMm: number): THREE.Color {
  const normalizedMagnitude = Math.min(1, Math.abs(localCompensationMm) / COMPENSATION_DISPLAY_MAX_MM);
  const boostedMagnitude = normalizedMagnitude ** 0.65;
  const baseBlend = 0.18;
  const blend = Math.min(1, baseBlend + boostedMagnitude * 0.82);
  const positiveBase = new THREE.Color('#FDB4B4');
  const positiveStrong = new THREE.Color('#991B1B');
  const negativeBase = new THREE.Color('#A9CCFF');
  const negativeStrong = new THREE.Color('#1E40AF');

  const start = localCompensationMm >= 0 ? positiveBase : negativeBase;
  const end = localCompensationMm >= 0 ? positiveStrong : negativeStrong;
  return start.clone().lerp(end, blend);
}

function getCompensationOverlayLift(localCompensationMm: number): number {
  const normalizedMagnitude = Math.min(1, Math.abs(localCompensationMm) / COMPENSATION_DISPLAY_MAX_MM);
  const boostedMagnitude = normalizedMagnitude ** 0.62;
  if (localCompensationMm >= 0) {
    return 0.01 + boostedMagnitude * 0.026;
  }
  return 0.004 + boostedMagnitude * 0.012;
}

function InsoleRegionOverlay({
  foot,
  footLength,
  footWidth,
  archCorrection,
  baseThickness,
  heelThickness = 0,
  compensation,
}: {
  foot: 'left' | 'right';
  footLength: number;
  footWidth: number;
  archCorrection: number;
  baseThickness: number;
  heelThickness?: number;
  compensation: ZoneSupportCompensation;
}) {
  const overlayMeshes = useMemo(() => {
    const outerRaw = foot === 'left' ? INSOLE_CONTOURS.leftOuter : INSOLE_CONTOURS.rightOuter;
    const outerContour = scaleContour(outerRaw, footLength, footWidth, foot);
    const bounds = getBounds(outerContour);
    const cellSize = 0.22;
    const rows = Math.ceil((bounds.maxY - bounds.minY) / cellSize);
    const cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize);
    const zoneNames: CompensationZoneName[] = ['forefoot', 'arch', 'heel'];

    return zoneNames.flatMap((zone): RegionOverlayMeshData[] => {
      const positions: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      let vertexIndex = 0;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x0 = bounds.minX + c * cellSize;
          const x1 = bounds.minX + (c + 1) * cellSize;
          const z0 = bounds.minY + r * cellSize;
          const z1 = bounds.minY + (r + 1) * cellSize;
          const centerX = (x0 + x1) / 2;
          const centerZ = (z0 + z1) / 2;

          if (!pointInPolygon(centerX, centerZ, outerContour)) continue;

          const weights = getCompensationZoneWeights(centerX, centerZ, footLength, foot);
          const weight = weights[zone];
          const zoneCompensationMm = compensation[zone];
          const localCompensationMm = zoneCompensationMm * weight;
          if (Math.abs(localCompensationMm) < 0.08) continue;

          const color = getCompensationDisplayColor(localCompensationMm);
          const overlayLift = getCompensationOverlayLift(localCompensationMm);
          const height = (x: number, z: number) =>
            getInsoleHeight(x, z, footLength, archCorrection, baseThickness, foot, heelThickness, compensation) +
            overlayLift;

          const corners = [
            [x0, height(x0, z0), z0],
            [x1, height(x1, z0), z0],
            [x0, height(x0, z1), z1],
            [x1, height(x1, z1), z1],
          ];

          for (const [x, y, z] of corners) {
            positions.push(x, y, z);
            colors.push(color.r, color.g, color.b);
          }

          indices.push(
            vertexIndex,
            vertexIndex + 2,
            vertexIndex + 1,
            vertexIndex + 1,
            vertexIndex + 2,
            vertexIndex + 3
          );
          vertexIndex += 4;
        }
      }

      if (positions.length === 0) return [];

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      return [{ zone, geometry }];
    });
  }, [foot, footLength, footWidth, archCorrection, baseThickness, heelThickness, compensation]);

  useEffect(() => {
    return () => {
      overlayMeshes.forEach(({ geometry }) => geometry.dispose());
    };
  }, [overlayMeshes]);

  return (
    <group renderOrder={2}>
      {overlayMeshes.map(({ zone, geometry }) => (
        <mesh key={zone} geometry={geometry} renderOrder={2}>
          <meshBasicMaterial
            color="#ffffff"
            vertexColors
            transparent
            opacity={1}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

function SingleInsole({
  foot,
  footLength,
  footWidth,
  archCorrection,
  baseThickness,
  heelThickness = 0,
  latticeDensity = 3,
  compensation,
  showCompensationRegions = false,
  color,
  positionX,
}: {
  foot: 'left' | 'right';
  footLength: number;
  footWidth: number;
  archCorrection: number;
  baseThickness: number;
  heelThickness?: number;
  latticeDensity?: number;
  compensation?: ZoneSupportCompensation;
  showCompensationRegions?: boolean;
  color: string;
  positionX: number;
}) {
  const strutsRef = useRef<THREE.InstancedMesh>(null);
  const jointsRef = useRef<THREE.InstancedMesh>(null);

  const { strutTransforms, jointPositions } = useMemo(() => {
    const outerRaw = foot === 'left' ? INSOLE_CONTOURS.leftOuter : INSOLE_CONTOURS.rightOuter;
    const outerContour = scaleContour(outerRaw, footLength, footWidth, foot);
    const bounds = getBounds(outerContour);
    
    // 晶格体密度档位到cellSize的映射：1=稀疏(1.0cm), 2=较稀(0.85cm), 3=标准(0.65cm), 4=较密(0.5cm), 5=密集(0.4cm)
    const densityMap: Record<number, number> = { 1: 1.0, 2: 0.85, 3: 0.65, 4: 0.5, 5: 0.4 };
    const cellSize = densityMap[latticeDensity] ?? 0.65;
    
    const struts: StrutData[] = [];
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
      const t = computeStrutTransform(a, b);
      if (t) struts.push(t);
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
    
    // 轮廓边缘壁
    const step = Math.max(1, Math.floor(outerContour.length / 80));
    for (let i = 0; i < outerContour.length; i += step) {
      const [x1, z1] = outerContour[i];
      const ni = (i + step) % outerContour.length;
      const [x2, z2] = outerContour[ni];
      
      const h1 = getInsoleHeight(x1, z1, footLength, archCorrection, baseThickness, foot, heelThickness, compensation);
      const h2 = getInsoleHeight(x2, z2, footLength, archCorrection, baseThickness, foot, heelThickness, compensation);
      
      addStrut(new THREE.Vector3(x1, h1, z1), new THREE.Vector3(x2, h2, z2));
      addStrut(new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x2, 0, z2));
      if (i % (step * 2) === 0) {
        addStrut(new THREE.Vector3(x1, h1, z1), new THREE.Vector3(x1, 0, z1));
      }
    }
    
    return { strutTransforms: struts, jointPositions: joints };
  }, [foot, footLength, footWidth, archCorrection, baseThickness, heelThickness, latticeDensity, compensation]);

  // 杆件和节点半径根据密度自适应：密度越高杆件越细
  const strutRadius = latticeDensity <= 2 ? 0.05 : latticeDensity >= 4 ? 0.03 : 0.04;
  const jointRadius = latticeDensity <= 2 ? 0.08 : latticeDensity >= 4 ? 0.05 : 0.07;

  useEffect(() => {
    if (strutsRef.current) {
      const mesh = strutsRef.current;
      const dummy = new THREE.Object3D();
      
      for (let i = 0; i < strutTransforms.length; i++) {
        const t = strutTransforms[i];
        dummy.position.copy(t.position);
        dummy.quaternion.copy(t.quaternion);
        dummy.scale.copy(t.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = strutTransforms.length;
    }
  }, [strutTransforms]);

  useEffect(() => {
    if (jointsRef.current) {
      const mesh = jointsRef.current;
      const dummy = new THREE.Object3D();
      
      for (let i = 0; i < jointPositions.length; i++) {
        dummy.position.copy(jointPositions[i]);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = jointPositions.length;
    }
  }, [jointPositions]);

  const strutGeo = useMemo(() => new THREE.CylinderGeometry(strutRadius, strutRadius, 1, 5, 1), [strutRadius]);
  const jointGeo = useMemo(() => new THREE.SphereGeometry(jointRadius, 5, 5), [jointRadius]);
  
  // 创建材质一次，通过useEffect动态更新颜色，避免重建材质导致instancedMesh丢失引用
  const mat = useMemo(() => new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: 0.35,
    metalness: 0.15,
  }), []); // 注意：移除color依赖，不再重建材质

  // 动态更新材质颜色
  useEffect(() => {
    mat.color.set(color);
    mat.needsUpdate = true;
  }, [color, mat]);

  const scale = 0.08;

  return (
    <group position={[positionX, 0, 0]} scale={[scale, scale, scale]}>
      <instancedMesh
        ref={strutsRef}
        args={[strutGeo, mat, maxInstances]}
        castShadow
        receiveShadow
      />
      <instancedMesh
        ref={jointsRef}
        args={[jointGeo, mat, maxInstances]}
        castShadow
      />
      {showCompensationRegions && compensation && (
        <InsoleRegionOverlay
          foot={foot}
          footLength={footLength}
          footWidth={footWidth}
          archCorrection={archCorrection}
          baseThickness={baseThickness}
          heelThickness={heelThickness}
          compensation={compensation}
        />
      )}
    </group>
  );
}

// ============ 主组件 ============

export interface InsoleParams {
  footLength: number;   // cm
  footWidth: number;    // cm
  archCorrection: number; // mm (矫正厚度 ΔHS)
  archLevel: number;    // 1-7级
  archType: string;     // 足型描述
  baseThickness: number; // cm 基础厚度（根据压力调整）
  pressureRatio: number; // 该脚的压力占比 (0-1)
  heelThickness: number; // mm 足跟缓冲厚度 (0-30mm)
  latticeDensity: number; // 晶格体密度档位 (1-5, 1=稀疏, 5=密集)
  forefootCompensation: number; // mm 前掌支撑补偿
  archCompensation: number; // mm 足弓支撑补偿
  heelCompensation: number; // mm 后跟支撑补偿
}

interface LatticeInsoleViewerProps {
  activeFoot: 'left' | 'right' | 'both';
  autoRotate?: boolean;
  color?: string;
  showCompensationRegions?: boolean;
  leftParams: InsoleParams;
  rightParams: InsoleParams;
}

export const LatticeInsoleViewer = memo(function LatticeInsoleViewerInner({
  activeFoot,
  autoRotate = false,
  color = '#B0B0B0',
  showCompensationRegions = true,
  leftParams,
  rightParams,
}: LatticeInsoleViewerProps) {
  const spacing = 1.2;

  return (
    <div className="w-full h-full relative">
      <Canvas shadows dpr={[1, 1.5]}>
        <PerspectiveCamera makeDefault position={[0, 3.0, 3.5]} fov={35} />
        <OrbitControls
          enablePan enableZoom enableRotate
          autoRotate={autoRotate}
          autoRotateSpeed={1.5}
          minPolarAngle={0.2}
          maxPolarAngle={Math.PI / 2.1}
          minDistance={2}
          maxDistance={10}
        />

        <ambientLight intensity={0.5} />
        <directionalLight
          position={[5, 8, 5]}
          intensity={1.2}
          castShadow
          shadow-mapSize-width={512}
          shadow-mapSize-height={512}
        />
        <directionalLight position={[-3, 5, -3]} intensity={0.4} />

        <Suspense fallback={null}>
          <Environment files="/hdri/studio_small_03_1k.hdr" />

          {/* 左脚在右侧（正X方向） */}
          {(activeFoot === 'left' || activeFoot === 'both') && (
            <SingleInsole
              foot="left"
              footLength={leftParams.footLength}
              footWidth={leftParams.footWidth}
              archCorrection={leftParams.archCorrection}
              baseThickness={leftParams.baseThickness}
              heelThickness={leftParams.heelThickness}
              latticeDensity={leftParams.latticeDensity}
              compensation={{
                forefoot: leftParams.forefootCompensation,
                arch: leftParams.archCompensation,
                heel: leftParams.heelCompensation,
              }}
              showCompensationRegions={showCompensationRegions}
              color={color}
              positionX={activeFoot === 'both' ? spacing / 2 : 0}
            />
          )}

          {/* 右脚在左侧（负X方向） */}
          {(activeFoot === 'right' || activeFoot === 'both') && (
            <SingleInsole
              foot="right"
              footLength={rightParams.footLength}
              footWidth={rightParams.footWidth}
              archCorrection={rightParams.archCorrection}
              baseThickness={rightParams.baseThickness}
              heelThickness={rightParams.heelThickness}
              latticeDensity={rightParams.latticeDensity}
              compensation={{
                forefoot: rightParams.forefootCompensation,
                arch: rightParams.archCompensation,
                heel: rightParams.heelCompensation,
              }}
              showCompensationRegions={showCompensationRegions}
              color={color}
              positionX={activeFoot === 'both' ? -spacing / 2 : 0}
            />
          )}

          <ContactShadows
            position={[0, -0.01, 0]}
            opacity={0.4}
            scale={10}
            blur={2}
            far={4}
          />
        </Suspense>
      </Canvas>

      <div className="absolute bottom-2 left-2 text-xs text-muted-foreground bg-background/80 px-2 py-1 rounded">
        ◆ 左键: 旋转 · 右键: 平移 · 滚轮: 缩放
      </div>
    </div>
  );
});

/** 根据足弓指数(AI)返回足弓等级(1-7)及相关信息 */
export function getArchLevelFromAI(archIndex: number): { level: number; type: string; correction: number } {
  if (archIndex <= 0.10) return { level: 1, type: '重度高弓足', correction: 10.0 };
  if (archIndex <= 0.15) return { level: 2, type: '中度高弓足', correction: 8.0 };
  if (archIndex <= 0.20) return { level: 3, type: '轻度高弓足', correction: 6.0 };
  if (archIndex <= 0.26) return { level: 4, type: '正常足', correction: 2.5 };
  if (archIndex <= 0.31) return { level: 5, type: '轻度扁平足', correction: 4.0 };
  if (archIndex <= 0.36) return { level: 6, type: '中度扁平足', correction: 6.0 };
  return { level: 7, type: '重度扁平足', correction: 8.0 };
}

/** 根据足弓等级返回对应颜色 */
export function getArchLevelColor(level: number): string {
  const colors: Record<number, string> = {
    1: '#EF4444', 2: '#F97316', 3: '#EAB308', 4: '#22C55E',
    5: '#EAB308', 6: '#F97316', 7: '#EF4444',
  };
  return colors[level] || colors[4];
}

/** 根据足弓等级、基础厚度与足跟缓冲返回分区支撑补偿(mm) */
export function getZoneSupportCompensation(
  level: number,
  baseThickness: number,
  heelThickness: number,
  pressureRatio: number = 0.5
): ZoneSupportCompensation {
  const pressureBias = Math.max(-1, Math.min(1, (pressureRatio - 0.5) / 0.08));
  const clampCompensation = (value: number) => Number(Math.max(-1.5, Math.min(1.5, value)).toFixed(1));

  const forefoot = clampCompensation(
    -0.3 - Math.max(0, pressureBias) * 0.9 + Math.max(0, level - 4) * 0.1
  );
  const arch = clampCompensation(
    (level - 4) * 0.45 - Math.max(0, pressureBias) * 0.15
  );
  const heel = clampCompensation(
    (heelThickness >= 20 ? -0.2 : 0.2) - Math.max(0, pressureBias) * 0.85 + (level <= 3 ? 0.25 : level >= 6 ? -0.15 : 0)
  );

  return {
    forefoot,
    arch,
    heel,
  };
}

/** 根据足弓等级返回矫正设计逻辑描述 */
export function getArchDesignLogic(level: number): string {
  const logic: Record<number, string> = {
    1: '重度矫正：显著抬高足弓，增加内侧支撑，限制过度旋前，重建足弓结构',
    2: '中度矫正：适度抬高足弓，加强内侧支撑，引导正常步态力线',
    3: '轻度矫正：轻微抬高足弓，提供温和支撑，预防足弓进一步塌陷',
    4: '生理维持：不改变足弓形态，仅提供动态反馈，维持现有健康状态',
    5: '轻度缓冲：增加足底缓冲，分散高弓集中压力，改善舒适度',
    6: '中度缓冲：显著增加缓冲层，降低跖骨头和足跟集中压力',
    7: '重度缓冲：最大化缓冲与减压，全面分散异常集中的足底压力',
  };
  return logic[level] || logic[4];
}

/** 根据足弓等级返回矫正厚度ΔHS(mm) */
export function getArchCorrectionFromLevel(level: number): number {
  const corrections: Record<number, number> = {
    1: 8.0, 2: 6.0, 3: 4.0, 4: 2.5,
    5: 1.5, 6: 0.5, 7: 0.0,
  };
  return corrections[level] ?? 2.5;
}

/** 根据左右脚压力占比计算基础厚度调整 */
export function calculatePressureAdaptiveThickness(
  leftPressureRatio: number,
  rightPressureRatio: number,
  baseThickness: number = 0.3
): { leftThickness: number; rightThickness: number } {
  // 安全clamp输入值到0-1范围
  const lr = Math.max(0, Math.min(1, leftPressureRatio));
  const rr = Math.max(0, Math.min(1, rightPressureRatio));
  
  const idealRatio = 0.5;
  const leftDeviation = lr - idealRatio;
  const rightDeviation = rr - idealRatio;
  const maxAdjust = baseThickness * 0.4; // 最大调整量为基厚的40%
  const leftAdjust = leftDeviation * maxAdjust * 2;
  const rightAdjust = rightDeviation * maxAdjust * 2;
  
  // clamp输出到0.15cm(1.5mm) - 0.6cm(6mm)范围
  return {
    leftThickness: Math.max(0.15, Math.min(0.6, baseThickness + leftAdjust)),
    rightThickness: Math.max(0.15, Math.min(0.6, baseThickness + rightAdjust)),
  };
}

export default LatticeInsoleViewer;
