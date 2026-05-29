import { useState, useEffect, useRef } from 'react';
import { Terminal, X, ChevronUp, ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { serialService } from '@/lib/SerialService';

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  type: 'info' | 'error' | 'data';
}

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState({ frames: 0, lastMax: 0, lastMin: 0 });

  useEffect(() => {
    // Subscribe to serial logs
    serialService.setOnLog((message, type = 'info') => {
      addLog(message, type);
    });

    // Also hook into data callback to update stats (without overriding the main data callback)
    // Note: This is a bit tricky since SerialService only supports one data callback currently.
    // Ideally SerialService should support multiple listeners or an event emitter.
    // For now, we'll rely on the logs for errors and connection status.
    
    return () => {
      serialService.setOnLog(() => {});
    };
  }, []);

  const addLog = (message: string, type: 'info' | 'error' | 'data') => {
    setLogs(prev => {
      const newLog = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toLocaleTimeString(),
        message,
        type
      };
      // Keep last 100 logs
      const newLogs = [...prev, newLog];
      if (newLogs.length > 100) newLogs.shift();
      return newLogs;
    });
  };

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isOpen]);

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="fixed bottom-4 left-4 z-50 bg-background/80 backdrop-blur shadow-lg border-border"
        onClick={() => setIsOpen(true)}
      >
        <Terminal className="w-4 h-4 mr-2" />
        Debug Console
      </Button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 w-96 h-64 bg-black/90 text-green-400 font-mono text-xs rounded-lg shadow-2xl border border-green-900 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-green-900/20 border-b border-green-900">
        <div className="flex items-center gap-2">
          <Terminal className="w-3 h-3" />
          <span className="font-bold">Serial Debugger</span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-5 w-5 hover:bg-green-900/40 text-green-400" onClick={() => setLogs([])}>
            <Trash2 className="w-3 h-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-5 w-5 hover:bg-green-900/40 text-green-400" onClick={() => setIsOpen(false)}>
            <ChevronDown className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Logs Area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1" ref={scrollRef}>
        {logs.length === 0 && (
          <div className="text-green-400/50 italic">Waiting for logs...</div>
        )}
        {logs.map(log => (
          <div key={log.id} className={`break-all ${log.type === 'error' ? 'text-red-400 bg-red-900/20' : ''}`}>
            <span className="opacity-50">[{log.timestamp}]</span>{' '}
            {log.message}
          </div>
        ))}
      </div>
    </div>
  );
}
