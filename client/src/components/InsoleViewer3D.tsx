/**
 * 3D鞋垫查看器组件
 * 显示正常的3D鞋垫模型，支持360度旋转查看
 */

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows, Html, useGLTF } from '@react-three/drei';
import { Suspense, useRef, useMemo } from 'react';
import * as THREE from 'three';

// 鞋垫几何体 - 使用参数化建模创建真实鞋垫形状
function InsoleGeometry({ foot, color, autoRotate }: { foot: 'left' | 'right'; color: string; autoRotate: boolean }) {
  const meshRef = useRef<THREE.Group>(null);
  
  // 自动旋转
  useFrame((_, delta) => {
    if (meshRef.current && autoRotate) {
      meshRef.current.rotation.y += delta * 0.5;
    }
  });

  // 创建鞋垫形状 - 使用Shape和ExtrudeGeometry
  const insoleShape = useMemo(() => {
    const shape = new THREE.Shape();
    
    // 鞋垫轮廓 - 更真实的足型
    const scale = 0.8;
    const mirror = foot === 'right' ? -1 : 1;
    
    // 从脚跟开始绘制
    shape.moveTo(0 * scale * mirror, -1.2 * scale);
    
    // 脚跟曲线
    shape.bezierCurveTo(
      0.35 * scale * mirror, -1.2 * scale,
      0.45 * scale * mirror, -1.0 * scale,
      0.45 * scale * mirror, -0.8 * scale
    );
    
    // 外侧边缘
    shape.bezierCurveTo(
      0.5 * scale * mirror, -0.4 * scale,
      0.55 * scale * mirror, 0 * scale,
      0.6 * scale * mirror, 0.4 * scale
    );
    
    // 前足外侧
    shape.bezierCurveTo(
      0.65 * scale * mirror, 0.7 * scale,
      0.6 * scale * mirror, 0.95 * scale,
      0.45 * scale * mirror, 1.1 * scale
    );
    
    // 脚趾区域
    shape.bezierCurveTo(
      0.3 * scale * mirror, 1.2 * scale,
      0.1 * scale * mirror, 1.25 * scale,
      0 * scale * mirror, 1.2 * scale
    );
    
    // 大脚趾侧
    shape.bezierCurveTo(
      -0.15 * scale * mirror, 1.15 * scale,
      -0.35 * scale * mirror, 1.0 * scale,
      -0.45 * scale * mirror, 0.7 * scale
    );
    
    // 内侧边缘（足弓）
    shape.bezierCurveTo(
      -0.5 * scale * mirror, 0.3 * scale,
      -0.4 * scale * mirror, -0.2 * scale,
      -0.35 * scale * mirror, -0.6 * scale
    );
    
    // 内侧脚跟
    shape.bezierCurveTo(
      -0.3 * scale * mirror, -0.9 * scale,
      -0.2 * scale * mirror, -1.15 * scale,
      0 * scale * mirror, -1.2 * scale
    );
    
    return shape;
  }, [foot]);

  // 挤出设置
  const extrudeSettings = useMemo(() => ({
    steps: 2,
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelOffset: 0,
    bevelSegments: 3,
  }), []);

  // 创建足弓支撑凸起
  const archSupportGeometry = useMemo(() => {
    const archShape = new THREE.Shape();
    const mirror = foot === 'right' ? -1 : 1;
    const scale = 0.8;
    
    // 足弓支撑区域
    archShape.moveTo(-0.15 * scale * mirror, -0.3 * scale);
    archShape.bezierCurveTo(
      -0.25 * scale * mirror, -0.1 * scale,
      -0.3 * scale * mirror, 0.2 * scale,
      -0.2 * scale * mirror, 0.4 * scale
    );
    archShape.bezierCurveTo(
      -0.1 * scale * mirror, 0.5 * scale,
      0.05 * scale * mirror, 0.3 * scale,
      0.05 * scale * mirror, 0.1 * scale
    );
    archShape.bezierCurveTo(
      0.05 * scale * mirror, -0.1 * scale,
      0 * scale * mirror, -0.25 * scale,
      -0.15 * scale * mirror, -0.3 * scale
    );
    
    return new THREE.ExtrudeGeometry(archShape, {
      steps: 1,
      depth: 0.06,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 5,
    });
  }, [foot]);

  // 创建跟杯凸起
  const heelCupGeometry = useMemo(() => {
    const heelShape = new THREE.Shape();
    const scale = 0.8;
    
    // 跟杯区域 - 圆形
    const radius = 0.25 * scale;
    heelShape.moveTo(radius, -0.9 * scale);
    heelShape.absarc(0, -0.9 * scale, radius, 0, Math.PI * 2, false);
    
    return new THREE.ExtrudeGeometry(heelShape, {
      steps: 1,
      depth: 0.04,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 4,
    });
  }, []);

  const baseGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(insoleShape, extrudeSettings);
  }, [insoleShape, extrudeSettings]);

  // 材质颜色
  const mainColor = new THREE.Color(color);
  const accentColor = new THREE.Color(color).multiplyScalar(0.85);

  return (
    <group 
      ref={meshRef} 
      position={[foot === 'left' ? -0.6 : 0.6, 0, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      {/* 主体 */}
      <mesh geometry={baseGeometry} castShadow receiveShadow>
        <meshStandardMaterial 
          color={mainColor} 
          roughness={0.4} 
          metalness={0.1}
        />
      </mesh>
      
      {/* 足弓支撑 */}
      <mesh 
        geometry={archSupportGeometry} 
        position={[0, 0, 0.08]}
        castShadow
      >
        <meshStandardMaterial 
          color={accentColor} 
          roughness={0.3} 
          metalness={0.15}
        />
      </mesh>
      
      {/* 跟杯 */}
      <mesh 
        geometry={heelCupGeometry} 
        position={[0, 0, 0.08]}
        castShadow
      >
        <meshStandardMaterial 
          color={accentColor} 
          roughness={0.3} 
          metalness={0.15}
        />
      </mesh>
    </group>
  );
}

interface InsoleViewer3DProps {
  activeFoot: 'left' | 'right' | 'both';
  autoRotate?: boolean;
  color?: string;
}

export function InsoleViewer3D({ 
  activeFoot,
  autoRotate = false,
  color = '#4A90D9'
}: InsoleViewer3DProps) {
  return (
    <div className="w-full h-full relative">
      <Canvas shadows dpr={[1, 2]}>
        <PerspectiveCamera makeDefault position={[0, 2.5, 3]} fov={45} />
        <OrbitControls 
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          minDistance={1.5}
          maxDistance={8}
          minPolarAngle={0}
          maxPolarAngle={Math.PI / 2}
          autoRotate={autoRotate}
          autoRotateSpeed={1.5}
        />
        
        {/* 光照 */}
        <ambientLight intensity={0.6} />
        <directionalLight position={[5, 10, 5]} intensity={0.8} castShadow />
        <directionalLight position={[-5, 5, -5]} intensity={0.3} />
        <pointLight position={[0, 5, 0]} intensity={0.4} />
        
        <Suspense fallback={
          <Html center>
            <div className="text-gray-500">加载中...</div>
          </Html>
        }>
          <Environment files="/hdri/studio_small_03_1k.hdr" />
          
          {/* 底座 */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow>
            <planeGeometry args={[4, 4]} />
            <meshStandardMaterial color="#f5f5f5" />
          </mesh>
          
          {/* 鞋垫模型 */}
          <group position={[0, 0.1, 0]}>
            {(activeFoot === 'left' || activeFoot === 'both') && (
              <InsoleGeometry foot="left" color={color} autoRotate={false} />
            )}
            {(activeFoot === 'right' || activeFoot === 'both') && (
              <InsoleGeometry foot="right" color={color} autoRotate={false} />
            )}
          </group>
          
          <ContactShadows position={[0, -0.01, 0]} opacity={0.5} scale={5} blur={2} far={4} />
        </Suspense>
      </Canvas>
      
      {/* 操作提示 */}
      <div className="absolute bottom-4 left-4 text-xs text-gray-500 bg-white/80 backdrop-blur px-3 py-2 rounded-lg">
        <p>🖱️ 左键拖动: 旋转视角</p>
        <p>🖱️ 右键拖动: 平移</p>
        <p>🖱️ 滚轮: 缩放</p>
      </div>
    </div>
  );
}

export default InsoleViewer3D;
