'use client';
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

interface Server {
  id: string;
  name: string;
  ip: string;
  port: number;
  username: string;
  auth_type: string;
  tag: string;
  status: string;
}

interface Props {
  server: Server;
  isActive: boolean;
  onReady?: (send: (data: string) => void) => void;
}

export default function TerminalTab({ server, isActive, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  useEffect(() => {
    if (!containerRef.current) return;

    const token = typeof window !== 'undefined' ? localStorage.getItem('serverhub_token') : null;
    if (!token) return;

    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const wsBase = apiBase.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/ws/servers/${server.id}/terminal?token=${encodeURIComponent(token)}`;

    const term = new Terminal({
      theme: {
        background: '#080a0e',
        foreground: '#e2e6f0',
        cursor: '#4f7cff',
        cursorAccent: '#080a0e',
        selectionBackground: '#2a3a5e',
        black: '#0d0f14',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#4f7cff',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e2e6f0',
        brightBlack: '#4e5668',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#818cf8',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc',
      },
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: false,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    const sendData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    };

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      onReady?.(sendData);
    };

    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) term.write(new Uint8Array(evt.data));
      else term.write(evt.data);
    };

    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    });

    term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const buf = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i) & 0xff;
        ws.send(buf);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!fitRef.current || !termRef.current) return;
      try {
        fitRef.current.fit();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
        }
      } catch {}
    });
    if (containerRef.current) resizeObserver.observe(containerRef.current);

    term.focus();

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  // When tab becomes visible again: re-fit and re-focus
  useEffect(() => {
    if (!isActive) return;
    // Let the browser paint first so the container has dimensions
    const id = setTimeout(() => {
      try { fitRef.current?.fit(); } catch {}
      termRef.current?.focus();
      if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
      }
    }, 50);
    return () => clearTimeout(id);
  }, [isActive]);

  const reconnect = () => {
    if (wsRef.current) wsRef.current.close();
    setStatus('connecting');

    const token = typeof window !== 'undefined' ? localStorage.getItem('serverhub_token') : null;
    if (!token || !termRef.current) return;

    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    const wsBase = apiBase.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/ws/servers/${server.id}/terminal?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    const term = termRef.current;

    const sendData = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
    };

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      term.write('\r\n\x1b[33m─── reconnected ───\x1b[0m\r\n');
      onReady?.(sendData);
    };
    ws.onmessage = (evt) => {
      if (evt.data instanceof ArrayBuffer) term.write(new Uint8Array(evt.data));
      else term.write(evt.data);
    };
    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');
  };

  const statusColor = status === 'connected' ? '#22c55e' : status === 'connecting' ? '#f59e0b' : '#ef4444';
  const statusLabel = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting…' : 'disconnected';

  return (
    <div style={{ flex: 1, background: '#080a0e', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', background: '#13161e', borderBottom: '1px solid #2a2f3f', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['#ef4444', '#f59e0b', '#22c55e'].map(c => (
            <div key={c} style={{ width: 10, height: 10, borderRadius: '50%', background: c }} />
          ))}
        </div>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#4e5668', fontFamily: "'JetBrains Mono',monospace" }}>
          {server.username}@{server.name}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: statusColor }} />
          <span style={{ fontSize: 10, color: statusColor }}>{statusLabel}</span>
          {status === 'disconnected' && (
            <button onClick={reconnect} style={{ marginLeft: 6, background: '#1a1e28', border: '1px solid #2a2f3f', color: '#8892a4', borderRadius: 5, padding: '2px 8px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
              Reconnect
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: 'hidden', padding: '4px 2px' }}
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
}
