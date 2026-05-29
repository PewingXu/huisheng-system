/**
 * 3D足部模型查看器
 * 支持根据压力数据动态调整模型形态和颜色映射
 */
import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';

interface FootModel3DProps {
  pressureData?: number[][]; // 64x64 压力矩阵
  showWireframe?: boolean;
  showPressureMap?: boolean;
  className?: string;
}

/**
 * 生成足部网格几何体
 */
function createFootGeometry(pressureData?: number[][]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  
  // 足部轮廓参数（简化的足部形状）
  const length = 25; // 足长 (cm)
  const width = 10;  // 足宽 (cm)
  const height = 5;  // 足高 (cm)
  
  const segmentsX = 64; // X方向分段（对应压力矩阵）
  const segmentsY = 64; // Y方向分段
  
  const vertices: number[] = [];
  const indices: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  
  // 生成顶点
  for (let y = 0; y <= segmentsY; y++) {
    for (let x = 0; x <= segmentsX; x++) {
      const u = x / segmentsX;
      const v = y / segmentsY;
      
      // 基础足部形状（椭圆形底面）
      const px = (u - 0.5) * length;
      const py = (v - 0.5) * width;
      
      // 足部轮廓函数（前窄后宽）
      const widthFactor = 0.3 + 0.7 * (1 - Math.pow(u - 0.7, 2) * 2);
      const footShape = Math.sqrt(Math.max(0, 1 - Math.pow(py / (width * widthFactor / 2), 2)));
      
      // 足弓曲线（中间凹陷）
      const archDepth = 0.3 * Math.sin(u * Math.PI) * (1 - Math.abs(py / width) * 2);
      
      // 根据压力数据调整高度
      let pressureHeight = 0;
      if (pressureData && x < 64 && y < 64) {
        const pressure = pressureData[y][x];
        pressureHeight = pressure > 0 ? pressure / 100 * 0.5 : 0; // 压力越大，凹陷越深
      }
      
      const pz = footShape * height - archDepth - pressureHeight;
      
      vertices.push(px, py, pz);
      uvs.push(u, v);
      
      // 根据压力数据设置颜色
      if (pressureData && x < 64 && y < 64) {
        const pressure = pressureData[y][x];
        const normalized = Math.min(pressure / 50, 1); // 归一化到0-1
        
        // 热力图配色：蓝->绿->黄->红
        let r, g, b;
        if (normalized < 0.25) {
          r = 0;
          g = normalized * 4;
          b = 1;
        } else if (normalized < 0.5) {
          r = 0;
          g = 1;
          b = 1 - (normalized - 0.25) * 4;
        } else if (normalized < 0.75) {
          r = (normalized - 0.5) * 4;
          g = 1;
          b = 0;
        } else {
          r = 1;
          g = 1 - (normalized - 0.75) * 4;
          b = 0;
        }
        
        colors.push(r, g, b);
      } else {
        colors.push(0.8, 0.8, 0.8); // 默认灰色
      }
    }
  }
  
  // 生成三角形索引
  for (let y = 0; y < segmentsY; y++) {
    for (let x = 0; x < segmentsX; x++) {
      const a = y * (segmentsX + 1) + x;
      const b = a + 1;
      const c = a + (segmentsX + 1);
      const d = c + 1;
      
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }
  
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  
  return geometry;
}

/**
 * 足部网格组件
 */
function FootMesh({ pressureData, showWireframe, showPressureMap }: FootModel3DProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  
  // 生成几何体
  const geometry = useMemo(() => {
    return createFootGeometry(pressureData);
  }, [pressureData]);
  
  // 自动旋转
  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.3) * 0.3;
    }
  });
  
  return (
    <mesh ref={meshRef} geometry={geometry} rotation={[-Math.PI / 2, 0, 0]}>
      {showPressureMap ? (
        <meshStandardMaterial
          vertexColors
          wireframe={showWireframe}
          side={THREE.DoubleSide}
          metalness={0.1}
          roughness={0.8}
        />
      ) : (
        <meshStandardMaterial
          color="#e0e0e0"
          wireframe={showWireframe}
          side={THREE.DoubleSide}
          metalness={0.2}
          roughness={0.7}
        />
      )}
    </mesh>
  );
}

/**
 * 3D场景组件
 */
export default function FootModel3D({
  pressureData,
  showWireframe = true,
  showPressureMap = true,
  className = '',
}: FootModel3DProps) {
  return (
    <div className={`w-full h-full ${className}`}>
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, 15, 30]} fov={50} />
        <OrbitControls
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          minDistance={10}
          maxDistance={100}
        />
        
        {/* 灯光 */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 10, 5]} intensity={1} />
        <directionalLight position={[-10, -10, -5]} intensity={0.3} />
        <pointLight position={[0, 10, 0]} intensity={0.5} />
        
        {/* 足部模型 */}
        <FootMesh
          pressureData={pressureData}
          showWireframe={showWireframe}
          showPressureMap={showPressureMap}
        />
        
        {/* 网格地面 */}
        <gridHelper args={[50, 20, '#444444', '#222222']} position={[0, -5, 0]} />
      </Canvas>
    </div>
  );
}
