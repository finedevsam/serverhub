'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('serverhub_token')) router.push('/');
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await auth.login(username, password);
      localStorage.setItem('serverhub_token', res.data.token);
      router.push('/');
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', background: '#0d0f14', display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontFamily: "'Sora', sans-serif"
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Sora:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pulse { 0%,100%{opacity:0.4} 50%{opacity:0.8} }
        .login-card { animation: fadeUp 0.5s ease forwards; }
        .inp:focus { outline: none; border-color: #4f7cff !important; background: #1a1e28 !important; }
        .inp { transition: border-color 0.2s, background 0.2s; }
        .login-btn:hover:not(:disabled) { background: #3a5fd6 !important; }
        .login-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .bg-grid {
          position: fixed; inset: 0; pointer-events: none;
          background-image: linear-gradient(rgba(79,124,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(79,124,255,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
        }
        .glow { position:fixed; width:600px; height:600px; border-radius:50%;
          background:radial-gradient(circle, rgba(79,124,255,0.06) 0%, transparent 70%);
          top:50%; left:50%; transform:translate(-50%,-50%); pointer-events:none; animation:pulse 4s ease infinite; }
      `}</style>

      <div className="bg-grid" />
      <div className="glow" />

      <div className="login-card" style={{ width: 380, position: 'relative', zIndex: 1 }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: '#4f7cff',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="3" width="20" height="14" rx="2" stroke="white" strokeWidth="1.5"/>
                <path d="M8 21h8M12 17v4" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                <path d="M6 7h4M6 11h6" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
                <circle cx="16" cy="9" r="2" stroke="white" strokeWidth="1.5"/>
              </svg>
            </div>
            <span style={{ fontSize: 22, fontWeight: 600, color: '#e2e6f0', letterSpacing: '-0.03em' }}>ServerHub</span>
          </div>
          <p style={{ color: '#4e5668', fontSize: 13 }}>Infrastructure management console</p>
        </div>

        {/* Card */}
        <div style={{
          background: '#13161e', border: '1px solid #2a2f3f', borderRadius: 12, padding: '32px 28px'
        }}>
          <h2 style={{ color: '#e2e6f0', fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Sign in</h2>
          <p style={{ color: '#4e5668', fontSize: 12, marginBottom: 24 }}>Enter your credentials to access the console</p>

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Username</label>
              <input
                className="inp"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="admin"
                required
                style={{
                  width: '100%', background: '#13161e', border: '1px solid #2a2f3f',
                  borderRadius: 7, padding: '10px 12px', color: '#e2e6f0',
                  fontSize: 13, fontFamily: "'Sora', sans-serif"
                }}
              />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>Password</label>
              <input
                className="inp"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: '100%', background: '#13161e', border: '1px solid #2a2f3f',
                  borderRadius: 7, padding: '10px 12px', color: '#e2e6f0',
                  fontSize: 13, fontFamily: "'Sora', sans-serif"
                }}
              />
            </div>

            {error && (
              <div style={{
                background: '#2e0505', border: '1px solid #4f0d0d', borderRadius: 7,
                padding: '9px 12px', color: '#ef4444', fontSize: 12, marginBottom: 16
              }}>{error}</div>
            )}

            <button
              className="login-btn"
              type="submit"
              disabled={loading}
              style={{
                width: '100%', background: '#4f7cff', border: 'none', borderRadius: 7,
                padding: '11px', color: '#fff', fontSize: 13, fontWeight: 600,
                fontFamily: "'Sora', sans-serif", cursor: 'pointer', transition: 'background 0.2s'
              }}
            >
              {loading ? 'Signing in…' : 'Sign in →'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', marginTop: 20, color: '#2a2f3f', fontSize: 11 }}>
          Default: admin / admin123 — change in .env
        </p>
      </div>
    </div>
  );
}
