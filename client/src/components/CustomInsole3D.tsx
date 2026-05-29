/**
 * 3D定制鞋垫组件
 * 支持360度旋转查看
 * 基于压力数据生成定制鞋垫形状
 */

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows, Html } from '@react-three/drei';
import { Suspense, useMemo, useRef, useEffect, useState } from 'react';
import * as THREE from 'three';

// 顶点着色器
const vertexShader = `
varying vec2 vUv;
varying float vHeight;
varying vec3 vNormal;
varying vec3 vViewPosition;

uniform sampler2D uHeightMap;
uniform float uDepthScale;
uniform float uMaxDepth;

void main() {
  vUv = uv;
  
  // 获取高度值
  float height = texture2D(uHeightMap, uv).r;
  vHeight = height;
  
  // 计算位移
  vec3 newPosition = position;
  float displacement = height * uDepthScale * uMaxDepth;
  
  // 只在顶面应用位移（法线朝上的面）
  if (normal.y > 0.5) {
    newPosition.y += displacement;
  }
  
  // 计算法线
  float offset = 1.0 / 64.0;
  float hL = texture2D(uHeightMap, uv + vec2(-offset, 0.0)).r;
  float hR = texture2D(uHeightMap, uv + vec2(offset, 0.0)).r;
  float hD = texture2D(uHeightMap, uv + vec2(0.0, -offset)).r;
  float hU = texture2D(uHeightMap, uv + vec2(0.0, offset)).r;
  
  vec3 tangent = normalize(vec3(2.0 * offset, (hR - hL) * uDepthScale * uMaxDepth, 0.0));
  vec3 bitangent = normalize(vec3(0.0, (hU - hD) * uDepthScale * uMaxDepth, 2.0 * offset));
  vNormal = normalize(cross(tangent, bitangent));
  
  vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
  vViewPosition = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

// 片段着色器
const fragmentShader = `
varying vec2 vUv;
varying float vHeight;
varying vec3 vNormal;
varying vec3 vViewPosition;

uniform bool uShowHeatmap;
uniform vec3 uBaseColor;
uniform vec3 uAccentColor;

// 热力图颜色映射
vec3 getHeatmapColor(float t) {
  t = clamp(t, 0.0, 1.0);
  
  // 蓝-青-绿-黄-橙-红 渐变
  vec3 blue = vec3(0.0, 0.4, 1.0);
  vec3 cyan = vec3(0.0, 0.8, 0.8);
  vec3 green = vec3(0.0, 0.9, 0.3);
  vec3 yellow = vec3(1.0, 0.95, 0.0);
  vec3 orange = vec3(1.0, 0.6, 0.0);
  vec3 red = vec3(1.0, 0.0, 0.0);
  
  if (t < 0.2) {
    return mix(blue, cyan, t / 0.2);
  } else if (t < 0.4) {
    return mix(cyan, green, (t - 0.2) / 0.2);
  } else if (t < 0.6) {
    return mix(green, yellow, (t - 0.4) / 0.2);
  } else if (t < 0.8) {
    return mix(yellow, orange, (t - 0.6) / 0.2);
  } else {
    return mix(orange, red, (t - 0.8) / 0.2);
  }
}

void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  
  // 光照
  vec3 lightDir1 = normalize(vec3(0.5, 1.0, 0.5));
  vec3 lightDir2 = normalize(vec3(-0.5, 0.5, -0.5));
  
  float diff1 = max(dot(normal, lightDir1), 0.0);
  float diff2 = max(dot(normal, lightDir2), 0.0) * 0.3;
  
  vec3 viewDir = normalize(vViewPosition);
  vec3 reflectDir = reflect(-lightDir1, normal);
  float spec = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);
  
  // 基础颜色
  vec3 surfaceColor = uBaseColor;
  
  // 热力图叠加
  if (uShowHeatmap && vHeight > 0.01) {
    vec3 heatColor = getHeatmapColor(vHeight);
    surfaceColor = mix(surfaceColor, heatColor, 0.85);
  }
  
  // 边缘高光
  float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
  vec3 fresnelColor = uAccentColor * fresnel * 0.3;
  
  // 最终颜色
  vec3 ambient = vec3(0.25);
  vec3 diffuse = (diff1 + diff2) * vec3(0.75);
  vec3 specular = spec * vec3(0.2);
  
  vec3 finalColor = (ambient + diffuse) * surfaceColor + specular + fresnelColor;
  
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

interface InsoleGeometryProps {
  heightData: number[][];
  showHeatmap: boolean;
  depthScale: number;
  foot: 'left' | 'right';
  autoRotate: boolean;
}

function InsoleGeometry({ heightData, showHeatmap, depthScale, foot, autoRotate }: InsoleGeometryProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  
  // 创建高度纹理
  const heightTexture = useMemo(() => {
    const size = 64;
    const data = new Float32Array(size * size);
    
    // 找最大值
    let maxVal = 0;
    for (const row of heightData) {
      for (const val of row) {
        if (val > maxVal) maxVal = val;
      }
    }
    if (maxVal === 0) maxVal = 1;
    
    // 填充数据
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const srcR = Math.min(r, heightData.length - 1);
        const srcC = Math.min(c, (heightData[0]?.length || 1) - 1);
        const val = heightData[srcR]?.[srcC] || 0;
        // 反转Y轴以匹配鞋垫方向
        data[(size - 1 - r) * size + c] = val / maxVal;
      }
    }
    
    const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.FloatType);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }, [heightData]);
  
  // 创建鞋垫几何体
  const geometry = useMemo(() => {
    const width = 1.2;
    const height = 2.4;
    const segments = 64;
    
    // 创建平面几何体
    const geo = new THREE.PlaneGeometry(width, height, segments, segments);
    
    // 旋转使其水平
    geo.rotateX(-Math.PI / 2);
    
    // 根据左右脚镜像
    if (foot === 'right') {
      geo.scale(-1, 1, 1);
    }
    
    return geo;
  }, [foot]);
  
  // 着色器材质
  const uniforms = useMemo(() => ({
    uHeightMap: { value: heightTexture },
    uDepthScale: { value: depthScale },
    uMaxDepth: { value: 0.3 },
    uShowHeatmap: { value: showHeatmap },
    uBaseColor: { value: new THREE.Color(0.9, 0.92, 0.95) },
    uAccentColor: { value: new THREE.Color(0.3, 0.5, 0.9) },
  }), [heightTexture, depthScale, showHeatmap]);
  
  // 更新uniforms
  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.uniforms.uShowHeatmap.value = showHeatmap;
      materialRef.current.uniforms.uDepthScale.value = depthScale;
    }
  }, [showHeatmap, depthScale]);
  
  // 自动旋转
  useFrame((_, delta) => {
    if (meshRef.current && autoRotate) {
      meshRef.current.rotation.y += delta * 0.3;
    }
  });
  
  return (
    <mesh ref={meshRef} geometry={geometry} position={[foot === 'left' ? -0.7 : 0.7, 0, 0]}>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

interface CustomInsole3DProps {
  leftFootData: number[][];
  rightFootData: number[][];
  showHeatmap: boolean;
  depthScale: number;
  activeFoot: 'left' | 'right' | 'both';
  autoRotate?: boolean;
}

export function CustomInsole3D({ 
  leftFootData, 
  rightFootData, 
  showHeatmap, 
  depthScale, 
  activeFoot,
  autoRotate = false 
}: CustomInsole3DProps) {
  return (
    <div className="w-full h-full relative">
      <Canvas shadows dpr={[1, 2]}>
        <PerspectiveCamera makeDefault position={[0, 3, 4]} fov={45} />
        <OrbitControls 
          enablePan={true}
          enableZoom={true}
          enableRotate={true}
          minDistance={2}
          maxDistance={10}
          minPolarAngle={0}
          maxPolarAngle={Math.PI / 2}
          autoRotate={autoRotate}
          autoRotateSpeed={1}
        />
        
        {/* 光照 */}
        <ambientLight intensity={0.5} />
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
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
            <planeGeometry args={[4, 4]} />
            <meshStandardMaterial color="#f0f0f0" />
          </mesh>
          
          {/* 鞋垫模型 */}
          <group position={[0, 0.1, 0]}>
            {(activeFoot === 'left' || activeFoot === 'both') && (
              <InsoleGeometry 
                heightData={leftFootData}
                showHeatmap={showHeatmap}
                depthScale={depthScale}
                foot="left"
                autoRotate={false}
              />
            )}
            {(activeFoot === 'right' || activeFoot === 'both') && (
              <InsoleGeometry 
                heightData={rightFootData}
                showHeatmap={showHeatmap}
                depthScale={depthScale}
                foot="right"
                autoRotate={false}
              />
            )}
          </group>
          
          <ContactShadows position={[0, -0.04, 0]} opacity={0.4} scale={5} blur={2} far={4} />
        </Suspense>
      </Canvas>
      
      {/* 操作提示 */}
      <div className="absolute bottom-4 left-4 text-xs text-gray-500 bg-white/80 backdrop-blur px-3 py-2 rounded-lg">
        <p>🖱️ 左键拖动: 旋转视角</p>
        <p>🖱️ 右键拖动: 平移</p>
        <p>🖱️ 滚轮: 缩放</p>
      </div>
      
      {/* 颜色图例 */}
      {showHeatmap && (
        <div className="absolute top-4 right-4 bg-white/90 backdrop-blur px-3 py-2 rounded-lg">
          <p className="text-xs text-gray-600 mb-1">压力分布</p>
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-500">低</span>
            <div className="flex h-3 rounded overflow-hidden">
              <div className="w-4" style={{ backgroundColor: '#0066ff' }} />
              <div className="w-4" style={{ backgroundColor: '#00cccc' }} />
              <div className="w-4" style={{ backgroundColor: '#00e64d' }} />
              <div className="w-4" style={{ backgroundColor: '#fff200' }} />
              <div className="w-4" style={{ backgroundColor: '#ff9900' }} />
              <div className="w-4" style={{ backgroundColor: '#ff0000' }} />
            </div>
            <span className="text-xs text-gray-500">高</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default CustomInsole3D;
