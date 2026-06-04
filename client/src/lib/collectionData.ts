export type CollectionExportPayload = {
  format: 'foot-pressure-collection';
  version: 1;
  exportedAt: string;
  source: 'collection-page';
  frameSize: 4096;
  frameCount: number;
  frames: number[][];
};

export function parseCSVData(csvText: string): number[][] {
  const lines = csvText.trim().split('\n');
  const frames: number[][] = [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const dataIndex = headers.findIndex(h => h === 'data');

  if (dataIndex === -1) {
    throw new Error('CSV文件缺少 "data" 列');
  }

  for (let i = 1; i < lines.length; i++) {
    try {
      const line = lines[i];
      const match = line.match(/\[([^\]]+)\]/);
      if (match) {
        const values = match[1].split(',').map(v => parseFloat(v.trim()));
        if (values.length === 4096) {
          frames.push(values);
        } else {
          console.warn(`第${i}行数据长度不为4096，跳过`);
        }
      }
    } catch {
      console.warn(`第${i}行解析失败，跳过`);
    }
  }

  return frames;
}

export function normalizeFrames(frames: unknown): number[][] {
  if (!Array.isArray(frames)) {
    throw new Error('数据文件缺少有效的帧数组');
  }

  return frames.map((frame, index) => {
    if (!Array.isArray(frame)) {
      throw new Error(`第 ${index + 1} 帧不是数组`);
    }

    const normalizedFrame = frame.map(value => Number(value));
    if (normalizedFrame.length !== 4096) {
      throw new Error(`第 ${index + 1} 帧数据长度为 ${normalizedFrame.length}，应为 4096`);
    }
    if (normalizedFrame.some(value => Number.isNaN(value))) {
      throw new Error(`第 ${index + 1} 帧包含无效数值`);
    }

    return normalizedFrame;
  });
}

export function parseJSONCollectionData(jsonText: string): number[][] {
  const parsed = JSON.parse(jsonText) as CollectionExportPayload | number[][];
  if (Array.isArray(parsed)) {
    return normalizeFrames(parsed);
  }

  if (parsed.format !== 'foot-pressure-collection' || parsed.version !== 1) {
    throw new Error('JSON文件格式无效');
  }

  return normalizeFrames(parsed.frames);
}

function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCollectionCsv(frames: number[][]): string {
  const rows = frames.map((frame, index) => {
    const frameData = `[${frame.join(',')}]`;
    return `${index},${escapeCsvField(frameData)}`;
  });
  return ['frame_index,data', ...rows].join('\n');
}

export function toCollectionJson(frames: number[][]): CollectionExportPayload {
  return {
    format: 'foot-pressure-collection',
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'collection-page',
    frameSize: 4096,
    frameCount: frames.length,
    frames,
  };
}
