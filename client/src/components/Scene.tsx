import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, ContactShadows } from '@react-three/drei';
import { InsoleModel } from './InsoleModel';
import { Suspense } from 'react';

interface SceneProps {
  showHeatmap: boolean;
  enableClipping: boolean;
  clipLevel: number;
  depthScale: number;
  smoothness: number;
  realtimeData?: number[][] | null;
}

export function Scene({ showHeatmap, enableClipping, clipLevel, depthScale, smoothness, realtimeData }: SceneProps) {
  return (
    <div className="w-full h-full relative bg-gradient-to-b from-gray-50 to-gray-200 dark:from-gray-900 dark:to-gray-800">
      <Canvas shadows dpr={[1, 2]}>
        <PerspectiveCamera makeDefault position={[0, 4, 4]} fov={50} />
        <OrbitControls 
          enablePan={true} 
          minPolarAngle={0} 
          maxPolarAngle={Math.PI / 2}
          target={[0, 0, 0]}
        />
        
        <ambientLight intensity={0.4} />
        <spotLight position={[10, 10, 10]} angle={0.15} penumbra={1} intensity={0.8} castShadow />
        <pointLight position={[-10, 5, -10]} intensity={0.5} />
        
        <Suspense fallback={null}>
           <Environment files="/hdri/studio_small_03_1k.hdr" />
           <group position={[0, 0, 0]}>
             <InsoleModel 
                showHeatmap={showHeatmap} 
                enableClipping={enableClipping}
                clipLevel={clipLevel}
                depthScale={depthScale}
                smoothness={smoothness}
                realtimeData={realtimeData}
             />
           </group>
           <ContactShadows position={[0, -0.1, 0]} opacity={0.4} scale={10} blur={2} far={4} />
        </Suspense>
      </Canvas>
      
      <div className="absolute bottom-4 left-4 text-xs text-gray-400 pointer-events-none">
        <p>Left Click: Rotate</p>
        <p>Right Click: Pan</p>
        <p>Scroll: Zoom</p>
      </div>
    </div>
  );
}
