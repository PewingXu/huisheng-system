import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import processedUnified from '@/assets/processed_unified.json';

// Vertex Shader - Updated for 64x64 texture
const vertexShader = `
varying vec2 vUv;
varying float vPressure;
varying vec3 vViewPosition;
varying vec3 vNormal;
varying vec3 vWorldPosition;

uniform sampler2D uPressureMap;
uniform float uDisplacementScale;
uniform float uThickness;
uniform float uSmoothness; // 0.0 to 1.0

// Simple Gaussian Blur function in shader
float getSmoothedPressure(vec2 uv) {
    float offset = 1.0 / 64.0; // Updated for 64x64 texture
    // Kernel size depends on uSmoothness
    // If uSmoothness is high, we sample wider area
    // But for performance, let's stick to 3x3 or 5x5 kernel with weighted average
    
    // Base sample
    float p = texture2D(uPressureMap, uv).r;
    
    if (uSmoothness < 0.01) return p;
    
    // 3x3 Kernel
    float pL = texture2D(uPressureMap, uv + vec2(-offset, 0.0)).r;
    float pR = texture2D(uPressureMap, uv + vec2(offset, 0.0)).r;
    float pD = texture2D(uPressureMap, uv + vec2(0.0, -offset)).r;
    float pU = texture2D(uPressureMap, uv + vec2(0.0, offset)).r;
    
    float pTL = texture2D(uPressureMap, uv + vec2(-offset, offset)).r;
    float pTR = texture2D(uPressureMap, uv + vec2(offset, offset)).r;
    float pDL = texture2D(uPressureMap, uv + vec2(-offset, -offset)).r;
    float pDR = texture2D(uPressureMap, uv + vec2(offset, -offset)).r;
    
    // Mix based on smoothness
    // Simple average
    float avg = (p + pL + pR + pD + pU + pTL + pTR + pDL + pDR) / 9.0;
    
    // For stronger smoothing, we can iterate or mix
    // Let's just mix original with average based on uSmoothness
    return mix(p, avg, uSmoothness);
}

void main() {
  vUv = uv;
  vec3 objectNormal = normal;
  
  if (objectNormal.z > 0.5) {
      float pressure = getSmoothedPressure(uv);
      vPressure = pressure;
      
      vec3 newPosition = position;
      
      float maxDisplacement = uThickness * 0.95;
      float displacement = min(pressure * uDisplacementScale, maxDisplacement);
      
      newPosition.z -= displacement;
      
      // Recompute Normal with smoothed values
      float offset = 1.0 / 64.0; // Updated for 64x64 texture
      
      float pL = getSmoothedPressure(uv + vec2(-offset, 0.0));
      float pR = getSmoothedPressure(uv + vec2(offset, 0.0));
      float pD = getSmoothedPressure(uv + vec2(0.0, -offset));
      float pU = getSmoothedPressure(uv + vec2(0.0, offset));
      
      float hL = min(pL * uDisplacementScale, maxDisplacement);
      float hR = min(pR * uDisplacementScale, maxDisplacement);
      float hD = min(pD * uDisplacementScale, maxDisplacement);
      float hU = min(pU * uDisplacementScale, maxDisplacement);
      
      vec3 vT = normalize(vec3(2.0 * offset, 0.0, hL - hR));
      vec3 vB = normalize(vec3(0.0, 2.0 * offset, hD - hU));
      vNormal = normalize(cross(vT, vB));
      
      vec4 worldPos = modelMatrix * vec4(newPosition, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
  } else {
      vPressure = 0.0;
      vNormal = normal;
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
  }

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
}
`;

const fragmentShader = `
varying vec2 vUv;
varying float vPressure;
varying vec3 vNormal;
varying vec3 vViewPosition;
varying vec3 vWorldPosition;

uniform bool uShowHeatmap;
uniform vec3 uBaseColor;
uniform bool uEnableClipping;
uniform float uClipLevel;

vec3 getHeatmapColor(float t) {
  t = clamp(t, 0.0, 1.0);
  float r = clamp(1.5 - abs(2.0 * t - 1.0) * 2.0, 0.0, 1.0);
  float g = clamp(1.5 - abs(2.0 * t - 0.5) * 2.0, 0.0, 1.0);
  float b = clamp(1.5 - abs(2.0 * t - 0.0) * 2.0, 0.0, 1.0);
  return vec3(r, g, b);
}

void main() {
  if (uEnableClipping && vUv.y < uClipLevel) discard;

  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;

  vec3 lightDir = normalize(vec3(0.5, 0.5, 1.0)); 
  
  vec3 ambient = vec3(0.3);
  float diff = max(dot(normal, lightDir), 0.0);
  vec3 diffuse = diff * vec3(0.7);
  
  vec3 viewDir = normalize(vViewPosition);
  vec3 reflectDir = reflect(-lightDir, normal);
  float spec = pow(max(dot(viewDir, reflectDir), 0.0), 32.0);
  vec3 specular = spec * vec3(0.1);

  vec3 surfaceColor = uBaseColor;
  
  if (!gl_FrontFacing) {
      surfaceColor = vec3(0.4, 0.4, 0.4);
  } else if (uShowHeatmap && vPressure > 0.01) {
      vec3 heatColor = getHeatmapColor(vPressure);
      surfaceColor = mix(surfaceColor, heatColor, 0.9);
  }

  if (uEnableClipping && abs(vUv.y - uClipLevel) < 0.005) {
      surfaceColor = vec3(1.0, 0.2, 0.2);
      ambient = vec3(1.0);
  }

  vec3 finalColor = (ambient + diffuse) * surfaceColor + specular;
  gl_FragColor = vec4(finalColor, 1.0);
}
`;

interface InsoleModelProps {
  showHeatmap: boolean;
  enableClipping: boolean;
  clipLevel: number;
  depthScale: number;
  smoothness: number;
  realtimeData?: number[][] | null;
}

export function InsoleModel({ showHeatmap, enableClipping, clipLevel, depthScale, smoothness, realtimeData }: InsoleModelProps) {
  const thickness = 0.15;
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  
  // Create a persistent texture object that we reuse
  // We initialize it with 64x64 static data first
  const textureRef = useRef<THREE.DataTexture | null>(null);

  // Initialize texture once - always 64x64 now
  if (!textureRef.current) {
      const width = 64;
      const height = 64;
      const size = width * height;
      const data = new Float32Array(size);
      
      // Load static data initially
      const rawData = processedUnified.data;
      const max_val = processedUnified.max_val;
      
      for (let r = 0; r < height; r++) {
          for (let c = 0; c < width; c++) {
              const row = rawData[height - 1 - r];
              const val = row ? row[c] : 0;
              data[r * width + c] = val / max_val;
          }
      }
      
      const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearFilter;
      texture.needsUpdate = true;
      textureRef.current = texture;
  }

  // Update texture data when realtimeData changes
  useEffect(() => {
      const texture = textureRef.current;
      if (!texture) return;

      if (realtimeData) {
          // Realtime mode: Now supports 64x64 directly
          const inputRows = realtimeData.length;
          const inputCols = realtimeData[0]?.length || 0;
          
          // Debug logging
          const flatData = realtimeData.flat();
          const maxVal = Math.max(...flatData);
          const nonZeroCount = flatData.filter(v => v > 0).length;
          console.log('[InsoleModel] Data update:', {
              dimensions: `${inputRows}x${inputCols}`,
              maxValue: maxVal,
              nonZeroCount: nonZeroCount,
              sampleValues: realtimeData[0]?.slice(0, 5)
          });
          
          // Always use 64x64 texture
          const width = 64;
          const height = 64;
          
          if (texture.image.width !== width || texture.image.height !== height) {
              // Dimension mismatch, recreate texture
              const size = width * height;
              const data = new Float32Array(size);
              
              // Fill data - handle both 32x32 and 64x64 input
              for (let r = 0; r < height; r++) {
                  for (let c = 0; c < width; c++) {
                      let val = 0;
                      
                      if (inputRows === 64 && inputCols === 64) {
                          // Direct 64x64 mapping
                          const row = realtimeData[height - 1 - r];
                          val = row ? row[c] : 0;
                      } else if (inputRows === 32 && inputCols === 32) {
                          // Upscale 32x32 to 64x64 with bilinear interpolation
                          const srcR = (height - 1 - r) * 31 / 63;
                          const srcC = c * 31 / 63;
                          const r0 = Math.floor(srcR);
                          const r1 = Math.min(r0 + 1, 31);
                          const c0 = Math.floor(srcC);
                          const c1 = Math.min(c0 + 1, 31);
                          const rFrac = srcR - r0;
                          const cFrac = srcC - c0;
                          
                          const v00 = realtimeData[r0]?.[c0] || 0;
                          const v01 = realtimeData[r0]?.[c1] || 0;
                          const v10 = realtimeData[r1]?.[c0] || 0;
                          const v11 = realtimeData[r1]?.[c1] || 0;
                          
                          val = v00 * (1 - rFrac) * (1 - cFrac) +
                                v01 * (1 - rFrac) * cFrac +
                                v10 * rFrac * (1 - cFrac) +
                                v11 * rFrac * cFrac;
                      }
                      
                      // High sensitivity: divide by 50 for better visualization
                      // Clamp to ensure values stay in 0-1 range
                      data[r * width + c] = Math.min(val / 50.0, 1.0);
                  }
              }
              
              texture.dispose(); // Cleanup old
              const newTexture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
              newTexture.magFilter = THREE.LinearFilter;
              newTexture.minFilter = THREE.LinearFilter;
              newTexture.needsUpdate = true;
              textureRef.current = newTexture;
              
              // Update material uniform
              if (materialRef.current) {
                  materialRef.current.uniforms.uPressureMap.value = newTexture;
              }
          } else {
              // Dimensions match (64x64), just update data
              const data = texture.image.data as Float32Array;
              
              for (let r = 0; r < height; r++) {
                  for (let c = 0; c < width; c++) {
                      let val = 0;
                      
                      if (inputRows === 64 && inputCols === 64) {
                          // Direct 64x64 mapping
                          const row = realtimeData[height - 1 - r];
                          val = row ? row[c] : 0;
                      } else if (inputRows === 32 && inputCols === 32) {
                          // Upscale 32x32 to 64x64 with bilinear interpolation
                          const srcR = (height - 1 - r) * 31 / 63;
                          const srcC = c * 31 / 63;
                          const r0 = Math.floor(srcR);
                          const r1 = Math.min(r0 + 1, 31);
                          const c0 = Math.floor(srcC);
                          const c1 = Math.min(c0 + 1, 31);
                          const rFrac = srcR - r0;
                          const cFrac = srcC - c0;
                          
                          const v00 = realtimeData[r0]?.[c0] || 0;
                          const v01 = realtimeData[r0]?.[c1] || 0;
                          const v10 = realtimeData[r1]?.[c0] || 0;
                          const v11 = realtimeData[r1]?.[c1] || 0;
                          
                          val = v00 * (1 - rFrac) * (1 - cFrac) +
                                v01 * (1 - rFrac) * cFrac +
                                v10 * rFrac * (1 - cFrac) +
                                v11 * rFrac * cFrac;
                      }
                      
                      // High sensitivity: divide by 50 for better visualization
                      data[r * width + c] = Math.min(val / 50.0, 1.0);
                  }
              }
              texture.needsUpdate = true;
          }
      } else {
          // Static mode: 64x64
          // Check if we need to revert to static texture
          const width = 64;
          const height = 64;
          
          if (texture.image.width !== width || texture.image.height !== height) {
               // Recreate static texture
               const size = width * height;
               const data = new Float32Array(size);
               const rawData = processedUnified.data;
               const max_val = processedUnified.max_val;
               
               for (let r = 0; r < height; r++) {
                   for (let c = 0; c < width; c++) {
                       const row = rawData[height - 1 - r];
                       const val = row ? row[c] : 0;
                       data[r * width + c] = val / max_val;
                   }
               }
               
               texture.dispose();
               const newTexture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
               newTexture.magFilter = THREE.LinearFilter;
               newTexture.minFilter = THREE.LinearFilter;
               newTexture.needsUpdate = true;
               textureRef.current = newTexture;
               
               if (materialRef.current) {
                   materialRef.current.uniforms.uPressureMap.value = newTexture;
               }
          }
      }
  }, [realtimeData]);

  // Stable uniforms object (initial)
  const uniforms = useMemo(() => ({
    uPressureMap: { value: textureRef.current },
    uDisplacementScale: { value: depthScale },
    uThickness: { value: thickness },
    uShowHeatmap: { value: showHeatmap },
    uBaseColor: { value: new THREE.Color('#eeeeee') },
    uEnableClipping: { value: enableClipping },
    uClipLevel: { value: clipLevel },
    uSmoothness: { value: smoothness }
  }), []); 

  // Update uniforms when props change
  useFrame(() => {
      if (materialRef.current) {
          materialRef.current.uniforms.uShowHeatmap.value = showHeatmap;
          materialRef.current.uniforms.uEnableClipping.value = enableClipping;
          materialRef.current.uniforms.uClipLevel.value = clipLevel;
          materialRef.current.uniforms.uDisplacementScale.value = depthScale;
          materialRef.current.uniforms.uSmoothness.value = smoothness;
          // Ensure texture is always up to date in uniform
          if (textureRef.current) {
              materialRef.current.uniforms.uPressureMap.value = textureRef.current;
          }
      }
  });

  return (
    <mesh 
      rotation={[-Math.PI / 2, 0, 0]} 
      position={[0, 0, 0]}
    >
      <boxGeometry args={[2, 2, thickness, 128, 128, 1]} /> 
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
