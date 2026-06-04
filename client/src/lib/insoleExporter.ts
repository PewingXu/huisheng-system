/**
 * 鞋垫3D模型导出工具 v2
 * 导出真正的晶格体结构（strut杆件 + joint球节点），与3D预览一致
 * 支持 STL（3D打印标准格式）和 GLTF/GLB（通用3D交换格式）
 */

import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { generateLatticeData, getLatticeSpec, type ZoneSupportCompensation } from '@/lib/latticeGeometry';

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
  const { strutRadiusCm: strutRadius, jointRadiusCm: jointRadius } = getLatticeSpec(latticeDensity);
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

export function downloadBlob(blob: Blob, filename: string) {
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
