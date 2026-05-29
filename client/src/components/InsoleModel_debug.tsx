// 调试版本 - 添加控制台日志
// 在 useEffect 中添加以下代码来调试数据更新

useEffect(() => {
    const texture = textureRef.current;
    if (!texture) return;

    if (realtimeData) {
        console.log('[InsoleModel] Realtime data received:', {
            rows: realtimeData.length,
            cols: realtimeData[0]?.length || 0,
            sampleValue: realtimeData[0]?.[0],
            maxValue: Math.max(...realtimeData.flat()),
            minValue: Math.min(...realtimeData.flat().filter(v => v > 0))
        });
        
        // ... 原有的数据处理代码 ...
        
        console.log('[InsoleModel] Texture updated');
    }
}, [realtimeData]);
