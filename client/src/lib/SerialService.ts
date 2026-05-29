export type BaudRate = 3000000 | 6000000;

export class SerialService {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private isConnected: boolean = false;
  private onDataCallback: ((data: number[][]) => void) | null = null;
  private onLogCallback: ((log: string, type?: 'info' | 'error' | 'data') => void) | null = null;
  
  // New property to control mirroring
  public enableMirroring: boolean = true;
  
  // 滤波阈值，小于等于此值的数据置为0（默认25：过滤初始底噪）
  public filterThreshold: number = 25;

  // 波特率，默认3000000，可切换为6000000
  public baudRate: BaudRate = 3000000;

  // 64x64 matrix size (updated from 32x32)
  private readonly ROWS = 64;
  private readonly COLS = 64;
  private readonly DATA_SIZE = 64 * 64; // 4096 bytes
  
  // Frame Footer: AA 55 03 99
  private readonly FOOTER = new Uint8Array([0xAA, 0x55, 0x03, 0x99]);
  private readonly FRAME_SIZE = 4096 + 4; // Data + Footer (4100 bytes total)
  
  private buffer: Uint8Array = new Uint8Array(0);
  private frameCount = 0;
  private lastBufferLogTime = 0;

  constructor() {
    if (!('serial' in navigator)) {
      console.error('Web Serial API not supported in this browser.');
    }
  }

  async connect() {
    try {
      this.port = await navigator.serial.requestPort();
      this.log(`Port selected, opening with baudRate ${this.baudRate}...`);
      await this.port.open({ baudRate: this.baudRate }); 
      this.isConnected = true;
      this.frameCount = 0;
      this.buffer = new Uint8Array(0);
      this.log(`Port opened successfully at ${this.baudRate} baud.`);
      this.readLoop();
      return true;
    } catch (error) {
      this.log(`Error connecting: ${error}`, 'error');
      return false;
    }
  }

  async disconnect() {
    if (this.reader) {
      await this.reader.cancel();
      this.reader = null;
    }
    if (this.port) {
      await this.port.close();
      this.port = null;
    }
    this.isConnected = false;
    this.buffer = new Uint8Array(0);
    this.frameCount = 0;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  setBaudRate(rate: BaudRate) {
    this.baudRate = rate;
    this.log(`Baud rate set to ${rate}. Reconnect to apply.`);
  }

  getBaudRate(): BaudRate {
    return this.baudRate;
  }

  setOnData(callback: (data: number[][]) => void) {
    this.onDataCallback = callback;
  }

  setOnLog(callback: (log: string, type?: 'info' | 'error' | 'data') => void) {
    this.onLogCallback = callback;
  }

  // New method to toggle mirroring
  setMirroring(enabled: boolean) {
      this.enableMirroring = enabled;
      this.log(`Sensor reordering ${enabled ? 'enabled' : 'disabled'}`);
  }

  // 设置滤波阈值
  setFilterThreshold(threshold: number) {
      this.filterThreshold = Math.max(0, Math.min(255, threshold));
      this.log(`Filter threshold set to ${this.filterThreshold}`);
  }

  // 获取当前滤波阈值
  getFilterThreshold(): number {
      return this.filterThreshold;
  }

  private log(message: string, type: 'info' | 'error' | 'data' = 'info') {
    if (this.onLogCallback) {
      this.onLogCallback(message, type);
    }
    console.log(`[Serial] ${message}`);
  }

  private async readLoop() {
    if (!this.port || !this.port.readable) return;

    this.reader = this.port.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    this.log('Starting read loop for 64x64 sensor...');

    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) {
          this.log('Read loop done signal received.');
          break;
        }
        if (value) {
          // Debug: Log first 8 bytes of every chunk to verify protocol
          const hex = Array.from(value.slice(0, 8))
            .map(b => b.toString(16).padStart(2, '0').toUpperCase())
            .join(' ');
          this.log(`Rx ${value.length}B: ${hex}...`, 'data');
          
          this.processData(value);
        }
      }
    } catch (error) {
      this.log(`Error reading: ${error}`, 'error');
    } finally {
      this.reader?.releaseLock();
      this.log('Reader lock released.');
    }
  }

  private processData(chunk: Uint8Array) {
    // Append new chunk to buffer
    const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
    newBuffer.set(this.buffer);
    newBuffer.set(chunk, this.buffer.length);
    this.buffer = newBuffer;

    // Periodically log buffer status for debugging
    const now = Date.now();
    if (now - this.lastBufferLogTime > 2000) {
      this.lastBufferLogTime = now;
      // Scan buffer for any occurrence of footer bytes
      let footerFound = false;
      let footerPositions: number[] = [];
      for (let i = 0; i <= this.buffer.length - 4; i++) {
        if (this.buffer[i] === 0xAA && this.buffer[i+1] === 0x55 &&
            this.buffer[i+2] === 0x03 && this.buffer[i+3] === 0x99) {
          footerFound = true;
          footerPositions.push(i);
        }
      }
      this.log(`[BUF] size=${this.buffer.length}, footers=${footerFound ? footerPositions.join(',') : 'NONE'}, frames=${this.frameCount}`, 'info');
    }

    // Search for frame footer and process
    while (this.buffer.length >= this.FRAME_SIZE) {
      // Look for footer
      let footerIndex = -1;
      
      for (let i = 0; i <= this.buffer.length - 4; i++) {
        if (this.buffer[i] === this.FOOTER[0] &&
            this.buffer[i+1] === this.FOOTER[1] &&
            this.buffer[i+2] === this.FOOTER[2] &&
            this.buffer[i+3] === this.FOOTER[3]) {
          
          // Found a footer candidate
          if (i >= this.DATA_SIZE) {
             footerIndex = i;
             break;
          } else {
            this.log(`[FRAME] Footer at pos ${i} but only ${i} bytes before (need ${this.DATA_SIZE}), skipping`, 'info');
          }
        }
      }

      if (footerIndex === -1) {
        if (this.buffer.length > this.FRAME_SIZE * 3) {
           const trimTo = this.FRAME_SIZE * 2;
           this.log(`[BUF] Trimming buffer from ${this.buffer.length} to ${trimTo}`, 'info');
           this.buffer = this.buffer.slice(this.buffer.length - trimTo);
        }
        break;
      }

      // Extract data payload (4096 bytes before footer)
      const frameStartIndex = footerIndex - this.DATA_SIZE;
      const dataPayload = this.buffer.slice(frameStartIndex, footerIndex);
      
      let wsPointData = Array.from(dataPayload);

      // Convert to 64x64 matrix for output with noise filtering
      const matrix: number[][] = [];
      let maxVal = 0;
      let minVal = 255;
      let nonZeroCount = 0;
      
      for (let r = 0; r < this.ROWS; r++) {
        const row: number[] = [];
        for (let c = 0; c < this.COLS; c++) {
          let val = wsPointData[r * this.COLS + c];
          
          // 滤波：小于等于阈值的数据置为0（去除底噪，例如默认 ADC≤25 视为噪声）
          if (val <= this.filterThreshold) {
            val = 0;
          }
          
          row.push(val);
          
          if (val > maxVal) maxVal = val;
          if (val < minVal && val > 0) minVal = val;
          if (val > 0) nonZeroCount++;
        }
        matrix.push(row);
      }

      this.frameCount++;
      
      if (nonZeroCount > 0) {
         this.log(`[FRAME #${this.frameCount}] 64x64: Max=${maxVal}, Min=${minVal}, NonZero=${nonZeroCount}`, 'data');
      } else {
         if (this.frameCount % 20 === 0) {
            this.log(`[FRAME #${this.frameCount}] 64x64: Empty (all zeros)`, 'data');
         }
      }

      // Emit data
      if (this.onDataCallback) {
        this.onDataCallback(matrix);
      }

      // Remove processed frame from buffer
      this.buffer = this.buffer.slice(footerIndex + 4);
    }
  }
}

export const serialService = new SerialService();
