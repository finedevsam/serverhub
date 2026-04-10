'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { servers as serverApi, auth, userMgmt, dashboardStats } from '@/lib/api';
import dynamic from 'next/dynamic';

const TerminalTab = dynamic(() => import('./TerminalTab'), { ssr: false, loading: () => (
  <div style={{ flex:1, background:'#080a0e', display:'flex', alignItems:'center', justifyContent:'center', color:'#4e5668', fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>Initialising terminal…</div>
) });

interface Server { id: string; name: string; ip: string; port: number; username: string; auth_type: string; tag: string; status: string; use_wireguard?: boolean; }
interface Metrics { cpu: number; mem_pct: number; mem_used_mb: number; mem_total_mb: number; disk_pct: number; disk_used_gb: number; disk_total_gb: number; uptime: string; net_rx_mb: number; net_tx_mb: number; }
const TABS = ['Overview', 'Terminal', 'Docker', 'Services', 'Files', 'Logs'] as const;
type Tab = typeof TABS[number];
const inputStyle: React.CSSProperties = { width:'100%', background:'#1a1e28', border:'1px solid #2a2f3f', borderRadius:6, padding:'9px 11px', color:'#e2e6f0', fontSize:13, outline:'none' };
const btnPrimary: React.CSSProperties = { background:'#4f7cff', border:'none', color:'#fff', borderRadius:7, padding:'8px 16px', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit' };
const btnGhost: React.CSSProperties = { background:'none', border:'1px solid #2a2f3f', color:'#8892a4', borderRadius:7, padding:'8px 16px', fontSize:12, cursor:'pointer', fontFamily:'inherit' };
const Label = ({ children }: { children: React.ReactNode }) => <div style={{ fontSize:10, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.07em', marginBottom:5 }}>{children}</div>;
const Input = (props: any) => <input {...props} style={{ ...inputStyle, ...props.style }} />;
const Btn = ({ onClick, loading, children }: { onClick:()=>void; loading?:boolean; children:React.ReactNode }) => (
  <button onClick={onClick} disabled={loading} style={{ background:'#1a1e28', border:'1px solid #2a2f3f', color:'#8892a4', borderRadius:5, padding:'3px 9px', fontSize:10, cursor:'pointer', fontFamily:'inherit', opacity:loading?0.5:1 }}>{children}</button>
);
// ─── SVG Charts ──────────────────────────────────────────────────────
function DonutChart({ data, size = 140 }: { data: {label:string; value:number; color:string}[]; size?: number }) {
  const total = data.reduce((s,d) => s+d.value, 0);
  const cx = size/2, cy = size/2, r = size/2-10, ir = r*0.62;
  const gap = total > 1 ? 0.04 : 0;
  const toXY = (angle: number, rad: number) => ({
    x: cx + rad * Math.cos(angle - Math.PI/2),
    y: cy + rad * Math.sin(angle - Math.PI/2),
  });
  if (total === 0) return (
    <svg width={size} height={size}>
      <circle cx={cx} cy={cy} r={(r+ir)/2} fill="none" stroke="#1a1e28" strokeWidth={r-ir}/>
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" fill="#4e5668" fontSize={size*0.12} fontFamily="'Sora',sans-serif">0</text>
    </svg>
  );
  let cum = 0;
  const paths = data.map(d => {
    const sweep = (d.value/total)*Math.PI*2;
    const s = cum+gap/2, e = cum+sweep-gap/2;
    cum += sweep;
    if (sweep <= gap) return null;
    const lg = sweep > Math.PI ? 1 : 0;
    const A = toXY(s,r), B = toXY(e,r), C = toXY(e,ir), D = toXY(s,ir);
    return { d: `M${A.x},${A.y} A${r},${r} 0 ${lg} 1 ${B.x},${B.y} L${C.x},${C.y} A${ir},${ir} 0 ${lg} 0 ${D.x},${D.y} Z`, color: d.color };
  });
  return (
    <svg width={size} height={size}>
      {paths.map((p,i) => p && <path key={i} d={p.d} fill={p.color}/>)}
      <text x={cx} y={cy-size*0.04} textAnchor="middle" dominantBaseline="middle" fill="#e2e6f0" fontSize={size*0.19} fontWeight="700" fontFamily="'Sora',sans-serif">{total}</text>
      <text x={cx} y={cy+size*0.13} textAnchor="middle" dominantBaseline="middle" fill="#4e5668" fontSize={size*0.09} fontFamily="'Sora',sans-serif">total</text>
    </svg>
  );
}

function BarChart({ data }: { data: {label:string; value:number; color:string}[] }) {
  const max = Math.max(...data.map(d=>d.value), 1);
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10, width:'100%' }}>
      {data.map((d,i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ fontSize:11, color:'#8892a4', width:72, flexShrink:0, textAlign:'right' as const, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{d.label}</div>
          <div style={{ flex:1, height:8, background:'#1a1e28', borderRadius:4, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${(d.value/max)*100}%`, background:d.color, borderRadius:4, transition:'width 0.8s ease', minWidth:d.value>0?4:0 }}/>
          </div>
          <div style={{ fontSize:11, fontWeight:600, color:d.color, width:18, textAlign:'right' as const }}>{d.value}</div>
        </div>
      ))}
    </div>
  );
}

const MetricBar = ({ pct, color }: { pct: number; color: string }) => (
  <div style={{ height:3, background:'#1a1e28', borderRadius:2, marginTop:8, overflow:'hidden' }}>
    <div style={{ height:'100%', width:`${Math.min(pct,100)}%`, background:color, borderRadius:2, transition:'width 0.8s ease' }} />
  </div>
);
const StatusDot = ({ status }: { status: string }) => (
  <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:status==='online'?'#22c55e':status==='warn'?'#f59e0b':'#ef4444', flexShrink:0 }} />
);

function AddServerModal({ onClose, onAdded }: { onClose:()=>void; onAdded:(s:Server)=>void }) {
  const [form, setForm] = useState({ name:'', ip:'', port:'22', username:'', auth_type:'key', password:'', private_key:'', tag:'server', use_wireguard:false, wg_config:'' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try { const res = await serverApi.add({ ...form, port: parseInt(form.port) }); onAdded(res.data); onClose(); }
    catch (err: any) { setError(err.response?.data?.detail || 'Failed to add server'); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:200 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:12, width:480, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', position:'sticky', top:0, background:'#13161e', zIndex:1 }}>
          <span style={{ fontWeight:600, fontSize:14, flex:1 }}>Add server</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#8892a4', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <form onSubmit={submit} style={{ padding:20 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <div><Label>Display name</Label><Input value={form.name} onChange={set('name')} placeholder="prod-uk-01" required /></div>
            <div><Label>Tag</Label>
              <select value={form.tag} onChange={set('tag')} style={inputStyle}>
                {['server','prod','staging','api','db','dev'].map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 100px', gap:12, marginBottom:12 }}>
            <div><Label>IP / Hostname</Label><Input value={form.ip} onChange={set('ip')} placeholder="10.0.0.1" required /></div>
            <div><Label>Port</Label><Input value={form.port} onChange={set('port')} type="number" /></div>
          </div>
          <div style={{ marginBottom:12 }}><Label>SSH Username</Label><Input value={form.username} onChange={set('username')} placeholder="ubuntu" required /></div>
          <div style={{ marginBottom:12 }}>
            <Label>Authentication</Label>
            <div style={{ display:'flex', gap:6, marginBottom:10 }}>
              {['key','password'].map(t=>(
                <button key={t} type="button" onClick={()=>setForm(f=>({...f,auth_type:t}))}
                  style={{ padding:'5px 14px', borderRadius:6, border:'1px solid', fontSize:11, cursor:'pointer', fontFamily:'inherit',
                    borderColor:form.auth_type===t?'#4f7cff':'#2a2f3f', background:form.auth_type===t?'#0d1433':'none', color:form.auth_type===t?'#4f7cff':'#8892a4' }}>
                  {t==='key'?'SSH Key / Certificate':'Password'}
                </button>
              ))}
            </div>
            {form.auth_type==='key'?(
              <>
                <textarea value={form.private_key} onChange={set('private_key')} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"} rows={4} style={{ ...inputStyle, fontFamily:"'JetBrains Mono',monospace", fontSize:11, resize:'vertical' as const }} />
                <p style={{ fontSize:10, color:'#4e5668', marginTop:4 }}>Paste your private key. Encrypted at rest.</p>
              </>
            ):(
              <>
                <Input value={form.password} onChange={set('password')} type="password" placeholder="SSH password" />
                <p style={{ fontSize:10, color:'#4e5668', marginTop:4 }}>Password is encrypted at rest.</p>
              </>
            )}
          </div>
          {/* WireGuard */}
          <div style={{ marginBottom:12, background:'#0d0f14', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden' }}>
            <div style={{ padding:'10px 14px', display:'flex', alignItems:'center', gap:10, cursor:'pointer' }} onClick={()=>setForm(f=>({...f,use_wireguard:!f.use_wireguard}))}>
              <div style={{ width:32, height:18, borderRadius:9, background:form.use_wireguard?'#4f7cff':'#2a2f3f', position:'relative', transition:'background 0.2s', flexShrink:0 }}>
                <div style={{ position:'absolute', top:2, left:form.use_wireguard?14:2, width:14, height:14, borderRadius:'50%', background:'#fff', transition:'left 0.2s' }}/>
              </div>
              <div>
                <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0' }}>WireGuard VPN</div>
                <div style={{ fontSize:10, color:'#4e5668' }}>Connect through a WireGuard tunnel before SSH</div>
              </div>
            </div>
            {form.use_wireguard&&(
              <div style={{ padding:'0 14px 14px' }}>
                <Label>WireGuard Config</Label>
                <textarea value={form.wg_config} onChange={set('wg_config')} rows={7}
                  placeholder={"[Interface]\nPrivateKey = <your-private-key>\nAddress = 10.0.0.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = <server-public-key>\nEndpoint = your-server.com:51820\nAllowedIPs = 10.0.0.0/24"}
                  style={{ ...inputStyle, fontFamily:"'JetBrains Mono',monospace", fontSize:11, resize:'vertical' as const, width:'100%', boxSizing:'border-box' as const }} />
                <p style={{ fontSize:10, color:'#4e5668', marginTop:4 }}>Full wg-quick config. Encrypted at rest. WireGuard tunnel will be established before each SSH connection.</p>
              </div>
            )}
          </div>
          {error&&<div style={{ background:'#2e0505', border:'1px solid #4f0d0d', borderRadius:6, padding:'8px 12px', color:'#ef4444', fontSize:12, marginBottom:12 }}>{error}</div>}
          <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button type="button" onClick={onClose} style={btnGhost}>Cancel</button>
            <button type="submit" disabled={loading} style={{ ...btnPrimary, opacity:loading?0.7:1 }}>{loading?'Connecting…':'Add server'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose:()=>void }) {
  const [form, setForm] = useState({ current:'', next:'', confirm:'' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const set = (k: string) => (e: any) => setForm(f=>({...f,[k]:e.target.value}));
  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault(); setError('');
    if (form.next !== form.confirm) { setError('Passwords do not match'); return; }
    if (form.next.length < 6)       { setError('New password must be at least 6 characters'); return; }
    setLoading(true);
    try { await auth.changePassword(form.current, form.next); setOk(true); }
    catch (e: any) { setError(e.response?.data?.detail || 'Failed'); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:12, width:380 }}>
        <div style={{ padding:'14px 18px', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center' }}>
          <span style={{ fontWeight:600, fontSize:14, flex:1 }}>Change password</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#8892a4', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <div style={{ padding:20 }}>
          {ok ? (
            <div style={{ textAlign:'center' as const, padding:'10px 0 6px' }}>
              <div style={{ fontSize:36, marginBottom:8 }}>✓</div>
              <div style={{ color:'#22c55e', fontWeight:600, marginBottom:4, fontSize:13 }}>Password updated</div>
              <div style={{ color:'#4e5668', fontSize:11, marginBottom:16 }}>Use your new password on next sign-in.</div>
              <button onClick={onClose} style={btnPrimary}>Close</button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div style={{ marginBottom:12 }}><Label>Current password</Label><Input value={form.current} onChange={set('current')} type="password" required /></div>
              <div style={{ marginBottom:12 }}><Label>New password</Label><Input value={form.next} onChange={set('next')} type="password" placeholder="min. 6 characters" required /></div>
              <div style={{ marginBottom:16 }}><Label>Confirm new password</Label><Input value={form.confirm} onChange={set('confirm')} type="password" required /></div>
              {error && <div style={{ background:'#2e0505', border:'1px solid #4f0d0d', borderRadius:6, padding:'7px 12px', color:'#ef4444', fontSize:12, marginBottom:12 }}>{error}</div>}
              <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                <button type="button" onClick={onClose} style={btnGhost}>Cancel</button>
                <button type="submit" disabled={loading} style={{ ...btnPrimary, opacity:loading?0.7:1 }}>{loading?'Saving…':'Update password'}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function AddUserModal({ onClose, onAdded }: { onClose:()=>void; onAdded:(u:any)=>void }) {
  const [form, setForm] = useState({ username:'', password:'', role:'developer' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const set = (k: string) => (e: any) => setForm(f=>({...f,[k]:e.target.value}));
  const submit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault(); setError(''); setLoading(true);
    try { const r = await userMgmt.add(form); onAdded(r.data); }
    catch (e: any) { setError(e.response?.data?.detail || 'Failed'); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:12, width:400 }}>
        <div style={{ padding:'14px 18px', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center' }}>
          <span style={{ fontWeight:600, fontSize:14, flex:1 }}>Add team member</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'#8892a4', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <form onSubmit={submit} style={{ padding:20 }}>
          <div style={{ marginBottom:12 }}><Label>Username</Label><Input value={form.username} onChange={set('username')} placeholder="john" required /></div>
          <div style={{ marginBottom:12 }}><Label>Password</Label><Input value={form.password} onChange={set('password')} type="password" placeholder="min. 6 characters" required /></div>
          <div style={{ marginBottom:16 }}>
            <Label>Role</Label>
            <div style={{ display:'flex', gap:6 }}>
              {(['developer','admin'] as const).map(ro=>(
                <button key={ro} type="button" onClick={()=>setForm(f=>({...f,role:ro}))}
                  style={{ flex:1, padding:'8px', borderRadius:6, border:'1px solid', fontSize:11, cursor:'pointer', fontFamily:'inherit',
                    borderColor:form.role===ro?'#4f7cff':'#2a2f3f', background:form.role===ro?'#0d1433':'#0d0f14', color:form.role===ro?'#4f7cff':'#8892a4' }}>
                  <div style={{ fontWeight:600, marginBottom:2 }}>{ro==='admin'?'Admin':'Developer'}</div>
                  <div style={{ fontSize:10, opacity:0.7 }}>{ro==='admin'?'Full access':'Connect & read'}</div>
                </button>
              ))}
            </div>
          </div>
          {error && <div style={{ background:'#2e0505', border:'1px solid #4f0d0d', borderRadius:6, padding:'7px 12px', color:'#ef4444', fontSize:12, marginBottom:12 }}>{error}</div>}
          <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button type="button" onClick={onClose} style={btnGhost}>Cancel</button>
            <button type="submit" disabled={loading} style={{ ...btnPrimary, opacity:loading?0.7:1 }}>{loading?'Creating…':'Add member'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ManageAccessModal({ username, allServers, onClose }: { username:string; allServers:Server[]; onClose:(saved?:boolean)=>void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    userMgmt.getUserServers(username)
      .then(r => setSelected(new Set(r.data.server_ids)))
      .catch(() => setSelected(new Set()))
      .finally(() => setLoading(false));
  }, [username]);

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const save = async () => {
    setSaving(true); setError('');
    try {
      await userMgmt.setUserServers(username, Array.from(selected));
      onClose(true);
    } catch (e: any) {
      setError(e.response?.data?.detail || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const tagColors: Record<string,string> = { prod:'#ef4444', staging:'#f59e0b', api:'#06b6d4', db:'#a855f7', dev:'#22c55e', server:'#4f7cff' };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300 }} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:12, width:480, maxHeight:'80vh', display:'flex', flexDirection:'column' }}>
        {/* Header */}
        <div style={{ padding:'14px 18px', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', flexShrink:0 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:600, fontSize:14, color:'#e2e6f0' }}>Server access</div>
            <div style={{ fontSize:11, color:'#4e5668', marginTop:1 }}>
              Choose which servers <span style={{ color:'#4f7cff' }}>{username}</span> can see and connect to
            </div>
          </div>
          <button onClick={()=>onClose()} style={{ background:'none', border:'none', color:'#8892a4', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>

        {/* Select all / none bar */}
        {!loading && allServers.length > 0 && (
          <div style={{ padding:'8px 18px', borderBottom:'1px solid #1a1e28', display:'flex', alignItems:'center', gap:10, flexShrink:0, background:'#0d0f14' }}>
            <span style={{ fontSize:11, color:'#4e5668', flex:1 }}>{selected.size} of {allServers.length} selected</span>
            <button onClick={()=>setSelected(new Set(allServers.map(s=>s.id)))} style={{ ...btnGhost, padding:'2px 10px', fontSize:10 }}>All</button>
            <button onClick={()=>setSelected(new Set())} style={{ ...btnGhost, padding:'2px 10px', fontSize:10 }}>None</button>
          </div>
        )}

        {/* Server list */}
        <div style={{ flex:1, overflowY:'auto', padding:'4px 0' }}>
          {loading ? (
            <div style={{ padding:24, textAlign:'center' as const, color:'#4e5668', fontSize:12 }}>Loading…</div>
          ) : allServers.length === 0 ? (
            <div style={{ padding:24, textAlign:'center' as const, color:'#4e5668', fontSize:12 }}>No servers added yet.</div>
          ) : (
            allServers.map(s => {
              const checked = selected.has(s.id);
              return (
                <div key={s.id} onClick={()=>toggle(s.id)}
                  style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 18px', cursor:'pointer', borderBottom:'1px solid #1a1e28',
                    background:checked?'#0d1117':'transparent' }}
                  onMouseOver={e=>{ if(!checked) e.currentTarget.style.background='#0f1117'; }}
                  onMouseOut={e=>{ e.currentTarget.style.background=checked?'#0d1117':'transparent'; }}>
                  {/* Checkbox */}
                  <div style={{ width:16, height:16, borderRadius:4, border:`2px solid ${checked?'#4f7cff':'#2a2f3f'}`, background:checked?'#4f7cff':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 0.15s' }}>
                    {checked && <svg width="9" height="7" viewBox="0 0 9 7" fill="none"><path d="M1 3.5L3.5 6L8 1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  {/* Status dot */}
                  <div style={{ width:7, height:7, borderRadius:'50%', background:s.status==='online'?'#22c55e':s.status==='offline'?'#ef4444':'#4e5668', flexShrink:0 }}/>
                  {/* Info */}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0' }}>{s.name}</div>
                    <div style={{ fontSize:10, color:'#4e5668', fontFamily:"'JetBrains Mono',monospace" }}>{s.ip}:{s.port} · {s.username}</div>
                  </div>
                  {/* Tag */}
                  <span style={{ fontSize:9, color:tagColors[s.tag]||'#4e5668', background:'#0d0f14', padding:'2px 7px', borderRadius:8, border:`1px solid ${tagColors[s.tag]||'#2a2f3f'}33`, flexShrink:0 }}>{s.tag}</span>
                  {s.use_wireguard && <span style={{ fontSize:8, color:'#818cf8', flexShrink:0 }}>WG</span>}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'12px 18px', borderTop:'1px solid #2a2f3f', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          {error && <span style={{ fontSize:11, color:'#ef4444', flex:1 }}>{error}</span>}
          {!error && <span style={{ fontSize:11, color:'#4e5668', flex:1 }}>{selected.size === 0 ? 'No access — member will see an empty server list' : `${selected.size} server${selected.size!==1?'s':''} will be accessible`}</span>}
          <button onClick={()=>onClose()} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={saving||loading} style={{ ...btnPrimary, opacity:saving?0.7:1 }}>{saving?'Saving…':'Save access'}</button>
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ server, onRunCmd }: { server: Server; onRunCmd:(cmd:string)=>void }) {
  const [metrics, setMetrics] = useState<Metrics|null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const res = await serverApi.metrics(server.id); setMetrics(res.data); setErr(''); }
    catch (e: any) { setErr(e.response?.data?.detail||'Cannot fetch metrics'); }
    finally { setLoading(false); }
  }, [server.id]);
  useEffect(() => { setLoading(true); load(); const t=setInterval(load,10000); return ()=>clearInterval(t); }, [load]);
  const actions = [
    {label:'↺ Restart nginx',cmd:'sudo systemctl restart nginx'},
    {label:'📊 Disk usage',cmd:'df -h'},
    {label:'🔍 Processes',cmd:'ps aux --sort=-%cpu | head -15'},
    {label:'⬆ Check updates',cmd:'sudo apt update && sudo apt list --upgradable 2>/dev/null'},
    {label:'🐳 Docker ps',cmd:'docker ps -a'},
    {label:'🔒 Auth log',cmd:'sudo tail -n 30 /var/log/auth.log'},
    {label:'🌐 Network',cmd:'ss -tuln'},
    {label:'📋 System log',cmd:'sudo journalctl -n 30 --no-pager'},
  ];
  if(loading) return <div style={{ padding:24, color:'#4e5668' }}>Loading metrics…</div>;
  if(err) return <div style={{ padding:24, color:'#ef4444', fontSize:12 }}>⚠ {err}<br/><span style={{color:'#4e5668',fontSize:11}}>python3 must be installed on the target server.</span></div>;
  return (
    <div style={{ flex:1, overflowY:'auto', padding:'16px 20px', display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
        {[
          {label:'CPU',val:`${metrics!.cpu}%`,pct:metrics!.cpu,color:'#4f7cff',sub:`${metrics!.cpu>70?'high':'normal'} load`},
          {label:'Memory',val:`${(metrics!.mem_used_mb/1024).toFixed(1)} GB`,pct:metrics!.mem_pct,color:'#a855f7',sub:`${metrics!.mem_pct}% of ${(metrics!.mem_total_mb/1024).toFixed(1)}GB`},
          {label:'Disk',val:`${metrics!.disk_used_gb} GB`,pct:metrics!.disk_pct,color:'#06b6d4',sub:`${metrics!.disk_pct}% of ${metrics!.disk_total_gb}GB`},
          {label:'Network',val:`↓${metrics!.net_rx_mb}MB`,pct:20,color:'#22c55e',sub:`↑${metrics!.net_tx_mb}MB total`},
        ].map(m=>(
          <div key={m.label} style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:8, padding:'12px 14px' }}>
            <div style={{ fontSize:10, color:'#4e5668', textTransform:'uppercase' as const, letterSpacing:'0.06em', fontWeight:600, marginBottom:4 }}>{m.label}</div>
            <div style={{ fontSize:22, fontWeight:600, letterSpacing:'-0.02em', color:'#e2e6f0' }}>{m.val}</div>
            <MetricBar pct={m.pct} color={m.color} />
            <div style={{ fontSize:10, color:'#4e5668', marginTop:4 }}>{m.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ background:'#052e1a', border:'1px solid #0d4f2a', borderRadius:6, padding:'5px 12px', fontSize:11, color:'#22c55e', display:'inline-flex', alignSelf:'flex-start' }}>● Uptime: {metrics!.uptime}</div>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #2a2f3f', fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>Quick actions</div>
        <div style={{ padding:12, display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:7 }}>
          {actions.map(a=>(
            <button key={a.label} onClick={()=>onRunCmd(a.cmd)}
              style={{ background:'#1a1e28', border:'1px solid #2a2f3f', borderRadius:6, padding:'9px 10px', color:'#8892a4', fontSize:11, cursor:'pointer', textAlign:'left' as const }}
              onMouseOver={e=>e.currentTarget.style.borderColor='#333a50'} onMouseOut={e=>e.currentTarget.style.borderColor='#2a2f3f'}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


function DockerTab({ server }: { server: Server }) {
  const [containers, setContainers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [output, setOutput] = useState<{title:string;text:string}|null>(null);
  const load = useCallback(async ()=>{ try{const r=await serverApi.docker(server.id);setContainers(r.data);}catch{setContainers([]);}finally{setLoading(false);} },[server.id]);
  useEffect(()=>{load();},[load]);
  const doAction=async(name:string,action:string)=>{
    setActionLoading(`${name}-${action}`);
    try{const r=await serverApi.dockerAction(server.id,name,action);if(action==='logs')setOutput({title:`Logs: ${name}`,text:r.data.stdout||r.data.stderr||'(empty)'});await load();}
    catch(e:any){alert(e.response?.data?.detail||'Action failed');}
    finally{setActionLoading('');}
  };
  if(loading) return <div style={{ padding:20, color:'#4e5668' }}>Loading containers…</div>;
  return (
    <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden', marginBottom:14 }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>
          Containers <span style={{ marginLeft:'auto', color:'#22c55e', fontSize:10 }}>{containers.filter(c=>c.state==='running').length} running</span>
        </div>
        {containers.length===0&&<div style={{ padding:20, color:'#4e5668', textAlign:'center' as const, fontSize:12 }}>No containers found.</div>}
        {containers.map(c=>(
          <div key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', borderBottom:'1px solid #1a1e28' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:c.state==='running'?'#22c55e':c.state==='exited'?'#f59e0b':'#ef4444', flexShrink:0 }}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontWeight:500, fontSize:12, color:'#e2e6f0' }}>{c.name}</div>
              <div style={{ fontSize:10, color:'#4e5668', fontFamily:"'JetBrains Mono',monospace" }}>{c.image}</div>
            </div>
            <div style={{ fontSize:10, color:'#8892a4', fontFamily:"'JetBrains Mono',monospace", maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{c.ports}</div>
            <div style={{ fontSize:10, fontWeight:500, padding:'2px 8px', borderRadius:4, background:c.state==='running'?'#052e1a':'#2e2005', border:`1px solid ${c.state==='running'?'#0d4f2a':'#4f3a0d'}`, color:c.state==='running'?'#22c55e':'#f59e0b' }}>{c.status?.split(' ').slice(0,2).join(' ')}</div>
            <div style={{ display:'flex', gap:4 }}>
              {c.state!=='running'?<Btn onClick={()=>doAction(c.name,'start')} loading={actionLoading===`${c.name}-start`}>Start</Btn>:<Btn onClick={()=>doAction(c.name,'stop')} loading={actionLoading===`${c.name}-stop`}>Stop</Btn>}
              <Btn onClick={()=>doAction(c.name,'restart')} loading={actionLoading===`${c.name}-restart`}>Restart</Btn>
              <Btn onClick={()=>doAction(c.name,'logs')} loading={actionLoading===`${c.name}-logs`}>Logs</Btn>
            </div>
          </div>
        ))}
      </div>
      {output&&(
        <div style={{ background:'#080a0e', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden' }}>
          <div style={{ padding:'8px 14px', borderBottom:'1px solid #1a1e28', display:'flex', alignItems:'center' }}>
            <span style={{ fontSize:11, color:'#8892a4', flex:1 }}>{output.title}</span>
            <button onClick={()=>setOutput(null)} style={{ background:'none', border:'none', color:'#4e5668', cursor:'pointer' }}>✕</button>
          </div>
          <pre style={{ padding:14, fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'#8892a4', overflowX:'auto', maxHeight:300, overflowY:'auto' }}>{output.text}</pre>
        </div>
      )}
    </div>
  );
}

function ServicesTab({ server }: { server: Server }) {
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const load = useCallback(async ()=>{ try{const r=await serverApi.services(server.id);setServices(r.data);}catch{setServices([]);}finally{setLoading(false);} },[server.id]);
  useEffect(()=>{load();},[load]);
  const doAction=async(name:string,action:string)=>{
    setActionLoading(`${name}-${action}`);
    try{await serverApi.serviceAction(server.id,name,action);await load();}
    catch(e:any){alert(e.response?.data?.detail||'Action failed');}
    finally{setActionLoading('');}
  };
  if(loading) return <div style={{ padding:20, color:'#4e5668' }}>Loading services…</div>;
  return (
    <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden' }}>
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #2a2f3f', fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>Systemd services</div>
        {services.map(s=>(
          <div key={s.name} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 14px', borderBottom:'1px solid #1a1e28' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', flexShrink:0, background:s.sub==='running'?'#22c55e':s.active==='active'?'#f59e0b':'#4e5668' }}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0' }}>{s.name}</div>
              <div style={{ fontSize:10, color:'#4e5668' }}>{s.description?.slice(0,60)}</div>
            </div>
            <div style={{ fontSize:10, padding:'2px 8px', borderRadius:4, fontWeight:500, background:s.sub==='running'?'#052e1a':'#1a1520', border:`1px solid ${s.sub==='running'?'#0d4f2a':'#2a1e3f'}`, color:s.sub==='running'?'#22c55e':s.active==='active'?'#a855f7':'#8892a4' }}>{s.sub}</div>
            <div style={{ display:'flex', gap:4 }}>
              <Btn onClick={()=>doAction(s.name,'restart')} loading={actionLoading===`${s.name}-restart`}>Restart</Btn>
              {s.sub!=='running'?<Btn onClick={()=>doAction(s.name,'start')} loading={actionLoading===`${s.name}-start`}>Start</Btn>:<Btn onClick={()=>doAction(s.name,'stop')} loading={actionLoading===`${s.name}-stop`}>Stop</Btn>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesTab({ server }: { server: Server }) {
  const [path, setPath] = useState('/');
  const [listing, setListing] = useState('');
  const [fileContent, setFileContent] = useState<{path:string;content:string}|null>(null);
  const [loading, setLoading] = useState(false);
  const [inputPath, setInputPath] = useState('/');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<{text:string;ok:boolean}|null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDir = useCallback(async (p: string) => {
    setLoading(true); setFileContent(null);
    try{const r=await serverApi.files(server.id,p);setListing(r.data.output);setPath(p);setInputPath(p);}
    catch(e:any){setListing(e.response?.data?.detail||'Error');}
    finally{setLoading(false);}
  },[server.id]);
  const loadFile=async(p:string)=>{
    setLoading(true);
    try{const r=await serverApi.fileContent(server.id,p);setFileContent({path:p,content:r.data.content});}
    catch(e:any){setFileContent({path:p,content:e.response?.data?.detail||'Error'});}
    finally{setLoading(false);}
  };
  useEffect(()=>{loadDir('/');},[loadDir]);

  const doUpload = async (file: File) => {
    setUploading(true); setUploadMsg(null);
    try {
      await serverApi.upload(server.id, path, file);
      setUploadMsg({text:`Uploaded ${file.name} → ${path}`, ok:true});
      await loadDir(path);
    } catch(e:any) {
      setUploadMsg({text: e.response?.data?.detail || 'Upload failed', ok:false});
    } finally { setUploading(false); }
  };

  const quickPaths=['/','/etc','/var/log','/home','/opt','/tmp'];
  const parsedLines = listing.split('\n').filter(l=>!l.startsWith('total')&&l.trim());
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ padding:'8px 14px', background:'#13161e', borderBottom:'1px solid #2a2f3f', display:'flex', gap:6, alignItems:'center', flexWrap:'wrap' as const }}>
        {quickPaths.map(p=>(
          <button key={p} onClick={()=>loadDir(p)} style={{ ...btnGhost, padding:'3px 10px', fontSize:11, fontFamily:"'JetBrains Mono',monospace", background:path===p?'#1a1e28':'none', borderColor:path===p?'#333a50':'#2a2f3f', color:path===p?'#e2e6f0':'#4e5668' }}>{p}</button>
        ))}
        <div style={{ display:'flex', gap:6, marginLeft:'auto', flex:1, minWidth:200 }}>
          <input value={inputPath} onChange={e=>setInputPath(e.target.value)} onKeyDown={e=>e.key==='Enter'&&loadDir(inputPath)}
            style={{ ...inputStyle, padding:'4px 10px', fontSize:11, fontFamily:"'JetBrains Mono',monospace", flex:1 }} placeholder="/custom/path"/>
          <button onClick={()=>loadDir(inputPath)} style={{ ...btnPrimary, padding:'4px 12px', fontSize:11 }}>Go</button>
          <input ref={fileInputRef} type="file" style={{ display:'none' }} onChange={e=>{ const f=e.target.files?.[0]; if(f) doUpload(f); e.target.value=''; }} />
          <button onClick={()=>fileInputRef.current?.click()} disabled={uploading}
            style={{ ...btnPrimary, padding:'4px 12px', fontSize:11, background:'#0d4f2a', opacity:uploading?0.6:1 }}>
            {uploading?'Uploading…':'↑ Upload'}
          </button>
        </div>
      </div>
      {uploadMsg&&(
        <div style={{ padding:'6px 14px', background:uploadMsg.ok?'#052e1a':'#2e0505', borderBottom:'1px solid #2a2f3f', fontSize:11, color:uploadMsg.ok?'#22c55e':'#ef4444', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span>{uploadMsg.ok?'✓ ':'⚠ '}{uploadMsg.text}</span>
          <button onClick={()=>setUploadMsg(null)} style={{ background:'none', border:'none', color:'inherit', cursor:'pointer', fontSize:13 }}>✕</button>
        </div>
      )}
      <div style={{ flex:1, overflowY:'auto', padding:16, position:'relative' }}
        onDragOver={e=>{e.preventDefault();setDragOver(true);}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={e=>{e.preventDefault();setDragOver(false);const f=e.dataTransfer.files[0];if(f)doUpload(f);}}>
        {dragOver&&(
          <div style={{ position:'absolute', inset:0, background:'rgba(79,124,255,0.08)', border:'2px dashed #4f7cff', borderRadius:8, zIndex:10, display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none' }}>
            <div style={{ color:'#4f7cff', fontSize:13, fontWeight:500 }}>Drop file to upload to {path}</div>
          </div>
        )}
        {fileContent?(
          <div style={{ background:'#080a0e', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden' }}>
            <div style={{ padding:'8px 14px', borderBottom:'1px solid #1a1e28', display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'#8892a4', flex:1 }}>{fileContent.path}</span>
              <button onClick={()=>setFileContent(null)} style={{ ...btnGhost, padding:'3px 10px', fontSize:11 }}>← Back</button>
            </div>
            <pre style={{ padding:16, fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'#8892a4', whiteSpace:'pre-wrap' as const, wordBreak:'break-all' as const }}>{fileContent.content}</pre>
          </div>
        ):(
          <div style={{ background:'#080a0e', border:'1px solid #2a2f3f', borderRadius:8, overflow:'hidden' }}>
            <div style={{ padding:'8px 14px', borderBottom:'1px solid #1a1e28', fontFamily:"'JetBrains Mono',monospace", fontSize:11, color:'#8892a4' }}>{loading?'Loading…':path}</div>
            <div style={{ padding:'8px 0' }}>
              {parsedLines.map((line,i)=>{
                const parts=line.trim().split(/\s+/); const name=parts[parts.length-1];
                const isDir=line.startsWith('d'); const isFile=line.startsWith('-');
                if(!name||name==='.'||name==='..') return null;
                const fullPath=path.endsWith('/')?path+name:path+'/'+name;
                return (
                  <div key={i} onClick={()=>isDir?loadDir(fullPath):isFile?loadFile(fullPath):undefined}
                    style={{ padding:'4px 16px', display:'flex', alignItems:'center', gap:8, cursor:isDir||isFile?'pointer':'default', fontSize:12, fontFamily:"'JetBrains Mono',monospace", color:isDir?'#4f7cff':isFile?'#8892a4':'#4e5668' }}
                    onMouseOver={e=>{if(isDir||isFile)e.currentTarget.style.background='#0f1117';}} onMouseOut={e=>{e.currentTarget.style.background='transparent';}}>
                    <span>{isDir?'📁':'📄'}</span><span>{name}</span>
                    <span style={{ color:'#2a2f3f', fontSize:10 }}>{isDir?'→ open':'→ view'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LogsTab({ server }: { server: Server }) {
  const [logs, setLogs] = useState('');
  const [service, setService] = useState('syslog');
  const [lines, setLines] = useState(100);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async ()=>{
    setLoading(true);
    try{const r=await serverApi.logs(server.id,service,lines);setLogs(r.data.logs);}
    catch(e:any){setLogs(e.response?.data?.detail||'Error');}
    finally{setLoading(false);}
  },[server.id,service,lines]);
  useEffect(()=>{load();},[load]);
  const colorLine=(l:string)=>{
    if(l.match(/error|ERROR|CRIT|crit|Failed|failed/)) return '#ef4444';
    if(l.match(/warn|WARN|Warning/)) return '#f59e0b';
    if(l.match(/info|INFO/)) return '#4f7cff';
    return '#8892a4';
  };
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      <div style={{ padding:'8px 14px', background:'#13161e', borderBottom:'1px solid #2a2f3f', display:'flex', gap:8, alignItems:'center' }}>
        <select value={service} onChange={e=>setService(e.target.value)} style={{ ...inputStyle, width:'auto', padding:'4px 10px', fontSize:11 }}>
          {['syslog','nginx','postgresql','redis','rabbitmq','docker'].map(s=><option key={s}>{s}</option>)}
        </select>
        <select value={lines} onChange={e=>setLines(Number(e.target.value))} style={{ ...inputStyle, width:'auto', padding:'4px 10px', fontSize:11 }}>
          {[50,100,200,500].map(n=><option key={n} value={n}>{n} lines</option>)}
        </select>
        <button onClick={load} style={{ ...btnPrimary, padding:'4px 14px', fontSize:11 }}>↺ Refresh</button>
        {loading&&<span style={{ fontSize:11, color:'#4e5668' }}>Loading…</span>}
      </div>
      <div style={{ flex:1, overflowY:'auto', background:'#080a0e', fontFamily:"'JetBrains Mono',monospace", fontSize:11, lineHeight:1.7 }}>
        {logs.split('\n').map((l,i)=>(
          <div key={i} style={{ padding:'2px 16px', color:colorLine(l), borderBottom:'1px solid #0a0c10' }}>{l}</div>
        ))}
      </div>
    </div>
  );
}

// ─── Per-server connection tab (owns all sub-tab state) ───────────────
function ServerConnection({ server }: { server: Server }) {
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [termEverShown, setTermEverShown] = useState(false);
  const termSendRef = useRef<((s: string) => void) | null>(null);

  const handleRunCmd = (cmd: string) => {
    setActiveTab('Terminal');
    setTermEverShown(true);
    if (termSendRef.current) setTimeout(() => termSendRef.current?.(cmd + '\n'), 100);
  };

  const statusBg   = server.status==='online'?'#052e1a':server.status==='offline'?'#2e0505':'#1a1520';
  const statusBdr  = server.status==='online'?'#0d4f2a':server.status==='offline'?'#4f0d0d':'#2a1e3f';
  const statusClr  = server.status==='online'?'#22c55e':server.status==='offline'?'#ef4444':'#8892a4';
  const statusTxt  = server.status==='online'?'● ONLINE':server.status==='offline'?'✕ OFFLINE':'? UNKNOWN';

  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
      {/* Sub-tab bar */}
      <div style={{ padding:'8px 20px', background:'#13161e', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
            {server.name}
            <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:20, letterSpacing:'0.04em', background:statusBg, border:`1px solid ${statusBdr}`, color:statusClr }}>{statusTxt}</span>
            {server.use_wireguard && <span style={{ fontSize:9, padding:'1px 6px', borderRadius:10, background:'#0d1433', border:'1px solid #1e2d66', color:'#818cf8' }}>WireGuard</span>}
          </div>
          <div style={{ color:'#4e5668', fontSize:10, display:'flex', gap:14, marginTop:2 }}>
            <span>{server.ip}:{server.port}</span><span>{server.username}</span><span>{server.auth_type}</span>
          </div>
        </div>
        <div style={{ flex:1 }}/>
        <div style={{ display:'flex', gap:2, background:'#0d0f14', borderRadius:7, padding:3 }}>
          {TABS.map(tab => (
            <button key={tab} onClick={() => { setActiveTab(tab); if(tab==='Terminal') setTermEverShown(true); }}
              style={{ padding:'4px 12px', borderRadius:5, cursor:'pointer', fontSize:11, fontWeight:500, border:'none', fontFamily:'inherit', transition:'all 0.15s',
                background:tab===activeTab?'#13161e':'transparent', color:tab===activeTab?'#e2e6f0':'#4e5668' }}>
              {tab}
            </button>
          ))}
        </div>
      </div>
      {/* Sub-tab content */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {activeTab==='Overview' && <OverviewTab server={server} onRunCmd={handleRunCmd}/>}
        {(termEverShown || activeTab==='Terminal') && (
          <div style={{ display:activeTab==='Terminal'?'flex':'none', flex:1, flexDirection:'column', overflow:'hidden' }}>
            <TerminalTab key={server.id} server={server} isActive={activeTab==='Terminal'} onReady={fn => { termSendRef.current = fn; }}/>
          </div>
        )}
        {activeTab==='Docker'   && <DockerTab   server={server}/>}
        {activeTab==='Services' && <ServicesTab server={server}/>}
        {activeTab==='Files'    && <FilesTab    server={server}/>}
        {activeTab==='Logs'     && <LogsTab     server={server}/>}
      </div>
    </div>
  );
}

// ─── Home dashboard ────────────────────────────────────────────────────
function HomeDashboard({ servers, onOpen, onAdd, isAdmin }: { servers: Server[]; onOpen:(s:Server)=>void; onAdd:()=>void; isAdmin:boolean }) {
  const online  = servers.filter(s => s.status==='online').length;
  const offline = servers.filter(s => s.status==='offline').length;
  const unknown = servers.filter(s => s.status==='unknown').length;
  const [apiStats, setApiStats] = useState<{users:{total:number;admins:number;developers:number}}|null>(null);

  useEffect(()=>{
    dashboardStats.get().then(r=>setApiStats(r.data)).catch(()=>{});
  },[]);

  const tagCounts = servers.reduce<Record<string,number>>((acc,s)=>{ acc[s.tag]=(acc[s.tag]||0)+1; return acc; },{});
  const tagColors: Record<string,string> = { prod:'#ef4444', staging:'#f59e0b', api:'#06b6d4', db:'#a855f7', dev:'#22c55e', server:'#4f7cff' };

  const statCards = [
    { label:'Total servers', value:servers.length, color:'#4f7cff', bg:'#0d1433', bdr:'#1e2d66', sub:'registered' },
    { label:'Online',        value:online,          color:'#22c55e', bg:'#052e1a', bdr:'#0d4f2a', sub:'reachable' },
    { label:'Offline',       value:offline,         color:'#ef4444', bg:'#2e0505', bdr:'#4f0d0d', sub:'unreachable' },
    { label:'Unknown',       value:unknown,         color:'#8892a4', bg:'#13161e', bdr:'#2a2f3f', sub:'not checked' },
    { label:'Team members',  value:apiStats?.users.total ?? '—', color:'#a855f7', bg:'#1a0533', bdr:'#3b1566', sub:'users' },
    { label:'Admins',        value:apiStats?.users.admins ?? '—', color:'#818cf8', bg:'#0d1433', bdr:'#1e2d66', sub:'full access' },
  ];

  const donutData = [
    { label:'Online',  value:online,  color:'#22c55e' },
    { label:'Offline', value:offline, color:'#ef4444' },
    { label:'Unknown', value:unknown, color:'#4e5668' },
  ];
  const barData = Object.entries(tagCounts).map(([tag, count])=>({ label:tag, value:count, color:tagColors[tag]||'#8892a4' }));

  return (
    <div style={{ flex:1, overflowY:'auto', padding:'24px 28px' }}>
      {/* Stat cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:12, marginBottom:20 }}>
        {statCards.map(s => (
          <div key={s.label} style={{ background:s.bg, border:`1px solid ${s.bdr}`, borderRadius:10, padding:'14px 16px' }}>
            <div style={{ fontSize:9, fontWeight:600, color:s.color, textTransform:'uppercase' as const, letterSpacing:'0.08em', marginBottom:6 }}>{s.label}</div>
            <div style={{ fontSize:30, fontWeight:700, color:s.color, letterSpacing:'-0.03em', lineHeight:1 }}>{s.value}</div>
            <div style={{ fontSize:9, color:'#4e5668', marginTop:5 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Charts row */}
      <div style={{ display:'grid', gridTemplateColumns:'280px 1fr 1fr', gap:14, marginBottom:20 }}>
        {/* Status donut */}
        <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, padding:'16px 18px' }}>
          <div style={{ fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em', marginBottom:14 }}>Status distribution</div>
          <div style={{ display:'flex', alignItems:'center', gap:18 }}>
            <DonutChart data={donutData} size={110}/>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {donutData.map(d=>(
                <div key={d.label} style={{ display:'flex', alignItems:'center', gap:7 }}>
                  <div style={{ width:8, height:8, borderRadius:'50%', background:d.color, flexShrink:0 }}/>
                  <span style={{ fontSize:11, color:'#8892a4', flex:1 }}>{d.label}</span>
                  <span style={{ fontSize:11, fontWeight:600, color:d.color }}>{d.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Tags bar */}
        <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, padding:'16px 18px' }}>
          <div style={{ fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em', marginBottom:14 }}>Servers by tag</div>
          {barData.length > 0
            ? <BarChart data={barData}/>
            : <div style={{ color:'#4e5668', fontSize:12, paddingTop:8 }}>No servers yet</div>}
        </div>

        {/* Team quick stats */}
        <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, padding:'16px 18px' }}>
          <div style={{ fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em', marginBottom:14 }}>Team</div>
          {apiStats ? (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {[
                { label:'Total members', value:apiStats.users.total,      color:'#a855f7' },
                { label:'Admins',        value:apiStats.users.admins,     color:'#818cf8' },
                { label:'Developers',    value:apiStats.users.developers, color:'#22c55e' },
              ].map(r=>(
                <div key={r.label} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'9px 12px', background:'#0d0f14', borderRadius:7 }}>
                  <span style={{ fontSize:11, color:'#8892a4' }}>{r.label}</span>
                  <span style={{ fontSize:16, fontWeight:700, color:r.color }}>{r.value}</span>
                </div>
              ))}
              {isAdmin && (
                <div style={{ fontSize:10, color:'#4f7cff', marginTop:4, cursor:'pointer' }}>Manage team in Team tab →</div>
              )}
            </div>
          ) : (
            <div style={{ color:'#4e5668', fontSize:12 }}>Loading…</div>
          )}
        </div>
      </div>

      {/* Server list + tags grid */}
      <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:14, marginBottom:20 }}>
        <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, overflow:'hidden' }}>
          <div style={{ padding:'12px 16px', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>Recent servers</span>
            {isAdmin && (
              <button onClick={onAdd} style={{ ...btnPrimary, padding:'4px 12px', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                Add
              </button>
            )}
          </div>
          {servers.length === 0 ? (
            <div style={{ padding:'28px 16px', textAlign:'center' as const, color:'#4e5668', fontSize:12 }}>
              No servers yet.{isAdmin && <> <span style={{ color:'#4f7cff', cursor:'pointer' }} onClick={onAdd}>Add your first →</span></>}
            </div>
          ) : (
            servers.slice(0,6).map(s=>(
              <div key={s.id} onClick={()=>onOpen(s)} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderBottom:'1px solid #1a1e28', cursor:'pointer' }}
                onMouseOver={e=>e.currentTarget.style.background='#161920'} onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                <StatusDot status={s.status}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0', whiteSpace:'nowrap' as const, overflow:'hidden', textOverflow:'ellipsis' }}>{s.name}</div>
                  <div style={{ fontSize:10, color:'#4e5668', fontFamily:"'JetBrains Mono',monospace" }}>{s.ip}:{s.port}</div>
                </div>
                <span style={{ fontSize:9, color:tagColors[s.tag]||'#4e5668', background:'#0d0f14', padding:'2px 7px', borderRadius:10, border:`1px solid ${tagColors[s.tag]||'#2a2f3f'}22` }}>{s.tag}</span>
                <span style={{ fontSize:10, color:'#4f7cff' }}>Connect →</span>
              </div>
            ))
          )}
        </div>
        <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, overflow:'hidden' }}>
          <div style={{ padding:'12px 16px', borderBottom:'1px solid #2a2f3f' }}>
            <span style={{ fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>By tag</span>
          </div>
          <div style={{ padding:'12px 0' }}>
            {Object.entries(tagCounts).map(([tag,count])=>(
              <div key={tag} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 16px' }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:tagColors[tag]||'#4e5668', flexShrink:0 }}/>
                <span style={{ fontSize:12, color:'#e2e6f0', flex:1 }}>{tag}</span>
                <span style={{ fontSize:12, fontWeight:600, color:tagColors[tag]||'#8892a4' }}>{count}</span>
              </div>
            ))}
            {Object.keys(tagCounts).length===0 && <div style={{ padding:'16px', color:'#4e5668', fontSize:12 }}>No servers yet</div>}
          </div>
        </div>
      </div>

      {/* All servers grid */}
      {servers.length>0 && (
        <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, overflow:'hidden' }}>
          <div style={{ padding:'12px 16px', borderBottom:'1px solid #2a2f3f' }}>
            <span style={{ fontSize:11, fontWeight:600, color:'#8892a4', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>All servers</span>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))', gap:1, background:'#2a2f3f' }}>
            {servers.map(s=>(
              <div key={s.id} onClick={()=>onOpen(s)} style={{ background:'#13161e', padding:'12px 16px', cursor:'pointer', display:'flex', alignItems:'center', gap:10 }}
                onMouseOver={e=>e.currentTarget.style.background='#161920'} onMouseOut={e=>e.currentTarget.style.background='#13161e'}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:s.status==='online'?'#22c55e':s.status==='offline'?'#ef4444':'#4e5668', flexShrink:0 }}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{s.name}</div>
                  <div style={{ fontSize:10, color:'#4e5668', fontFamily:"'JetBrains Mono',monospace" }}>{s.ip}</div>
                </div>
                {s.use_wireguard && <span style={{ fontSize:8, color:'#818cf8' }}>WG</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Servers table view ────────────────────────────────────────────────
function ServersTable({ servers, onOpen, onDelete, onAdd, isAdmin }: { servers:Server[]; onOpen:(s:Server)=>void; onDelete:(id:string)=>void; onAdd:()=>void; isAdmin:boolean }) {
  const cols = isAdmin ? '28px 1fr 160px 60px 80px 70px 80px 80px 110px' : '28px 1fr 160px 60px 80px 70px 80px 80px 70px';
  return (
    <div style={{ flex:1, overflowY:'auto', padding:'24px 28px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:'#e2e6f0' }}>Server connections</div>
          <div style={{ fontSize:11, color:'#4e5668', marginTop:2 }}>{servers.length} server{servers.length!==1?'s':''} · click a row to connect</div>
        </div>
        {isAdmin && (
          <button onClick={onAdd} style={{ ...btnPrimary, display:'flex', alignItems:'center', gap:6 }}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            Add server
          </button>
        )}
      </div>
      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:cols, gap:0, padding:'8px 16px', borderBottom:'1px solid #2a2f3f', background:'#0d0f14' }}>
          {['','Name','IP','Port','User','Auth','Tag','VPN',''].map((h,i) => (
            <div key={i} style={{ fontSize:10, fontWeight:600, color:'#4e5668', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>{h}</div>
          ))}
        </div>
        {servers.length === 0 && (
          <div style={{ padding:'48px 16px', textAlign:'center' as const, color:'#4e5668', fontSize:12 }}>
            {isAdmin
              ? <><span>No servers yet. </span><span style={{ color:'#4f7cff', cursor:'pointer' }} onClick={onAdd}>Add your first server →</span></>
              : <span>No servers have been shared with you yet. Ask an admin to grant you access.</span>}
          </div>
        )}
        {servers.map((s, i) => (
          <div key={s.id} onClick={() => onOpen(s)}
            style={{ display:'grid', gridTemplateColumns:cols, gap:0, padding:'10px 16px',
              borderBottom: i < servers.length-1 ? '1px solid #1a1e28' : 'none', cursor:'pointer', alignItems:'center' }}
            onMouseOver={e=>e.currentTarget.style.background='#161920'} onMouseOut={e=>e.currentTarget.style.background='transparent'}>
            <div><StatusDot status={s.status}/></div>
            <div>
              <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0' }}>{s.name}</div>
              <div style={{ fontSize:10, color:'#4e5668', marginTop:1 }}>{s.status}</div>
            </div>
            <div style={{ fontSize:11, color:'#8892a4', fontFamily:"'JetBrains Mono',monospace", overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{s.ip}</div>
            <div style={{ fontSize:11, color:'#4e5668', fontFamily:"'JetBrains Mono',monospace" }}>{s.port}</div>
            <div style={{ fontSize:11, color:'#8892a4', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{s.username}</div>
            <div style={{ fontSize:10, color:'#8892a4' }}>{s.auth_type}</div>
            <div><span style={{ fontSize:9, color:'#4e5668', background:'#1a1e28', padding:'2px 7px', borderRadius:10, border:'1px solid #2a2f3f' }}>{s.tag}</span></div>
            <div>{s.use_wireguard && <span style={{ fontSize:9, color:'#818cf8', background:'#0d1433', padding:'2px 7px', borderRadius:10, border:'1px solid #1e2d66' }}>WG</span>}</div>
            <div style={{ display:'flex', gap:6, alignItems:'center' }} onClick={e=>e.stopPropagation()}>
              <button onClick={() => onOpen(s)} style={{ ...btnPrimary, padding:'3px 10px', fontSize:10 }}>Connect</button>
              {isAdmin && (
                <button onClick={() => onDelete(s.id)}
                  style={{ background:'none', border:'1px solid #2a2f3f', color:'#4e5668', borderRadius:5, padding:'3px 7px', fontSize:10, cursor:'pointer', fontFamily:'inherit' }}
                  onMouseOver={e=>{ e.currentTarget.style.borderColor='#4f0d0d'; e.currentTarget.style.color='#ef4444'; }}
                  onMouseOut={e=>{ e.currentTarget.style.borderColor='#2a2f3f'; e.currentTarget.style.color='#4e5668'; }}>Delete</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Team page ─────────────────────────────────────────────────────────
// Small badge that lazily loads a developer's actual access count
function ServerAccessBadge({ username, totalServers, refreshKey }: { username:string; totalServers:number; refreshKey:number }) {
  const [count, setCount] = useState<number|null>(null);
  useEffect(()=>{
    setCount(null);
    userMgmt.getUserServers(username).then(r=>setCount(r.data.server_ids.length)).catch(()=>setCount(0));
  },[username, refreshKey]);
  if (count === null) return <span style={{ fontSize:10, color:'#4e5668' }}>…</span>;
  const none = count === 0;
  return (
    <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:6,
      background:none?'#2e0505':count===totalServers?'#052e1a':'#1a1e28',
      border:`1px solid ${none?'#4f0d0d':count===totalServers?'#0d4f2a':'#2a2f3f'}`,
      color:none?'#ef4444':count===totalServers?'#22c55e':'#8892a4' }}>
      {none ? 'No access' : `${count} / ${totalServers} server${totalServers!==1?'s':''}`}
    </span>
  );
}

function TeamPage({ currentUser, isAdmin, allServers }: { currentUser:string; isAdmin:boolean; allServers:Server[] }) {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [managingAccess, setManagingAccess] = useState<string|null>(null);
  const [accessRefreshKey, setAccessRefreshKey] = useState(0);

  const load = useCallback(async () => {
    try { const r = await userMgmt.list(); setUsers(r.data); }
    catch {}
    finally { setLoading(false); }
  }, []);
  useEffect(()=>{ load(); },[load]);

  const handleDelete = async (username: string) => {
    if (!confirm(`Remove "${username}" from the team?`)) return;
    try { await userMgmt.delete(username); setUsers(p=>p.filter(u=>u.username!==username)); }
    catch (e: any) { alert(e.response?.data?.detail||'Failed'); }
  };

  const handleRoleChange = async (username: string, role: string) => {
    try { await userMgmt.changeRole(username, role); setUsers(p=>p.map(u=>u.username===username?{...u,role}:u)); }
    catch (e: any) { alert(e.response?.data?.detail||'Failed'); }
  };

  if (loading) return <div style={{ padding:24, color:'#4e5668', fontSize:12 }}>Loading…</div>;

  const COLS = '1fr 160px 140px 140px 120px';

  return (
    <div style={{ flex:1, overflowY:'auto', padding:'24px 28px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600, color:'#e2e6f0' }}>Team</div>
          <div style={{ fontSize:11, color:'#4e5668', marginTop:2 }}>{users.length} member{users.length!==1?'s':''} · manage roles and server access</div>
        </div>
        {isAdmin && (
          <button onClick={()=>setShowAdd(true)} style={{ ...btnPrimary, display:'flex', alignItems:'center', gap:6 }}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            Add member
          </button>
        )}
      </div>

      {/* Role legend */}
      <div style={{ display:'flex', gap:10, marginBottom:16 }}>
        {[{role:'admin',color:'#818cf8',bg:'#0d1433',bdr:'#1e2d66',desc:'Full access to all servers, users & settings'},
          {role:'developer',color:'#22c55e',bg:'#052e1a',bdr:'#0d4f2a',desc:'Can only access servers explicitly granted by admin'}].map(r=>(
          <div key={r.role} style={{ background:r.bg, border:`1px solid ${r.bdr}`, borderRadius:8, padding:'8px 14px', display:'flex', gap:10, alignItems:'center' }}>
            <span style={{ fontSize:10, fontWeight:700, color:r.color, textTransform:'uppercase' as const, letterSpacing:'0.05em' }}>{r.role}</span>
            <span style={{ fontSize:10, color:'#4e5668' }}>{r.desc}</span>
          </div>
        ))}
      </div>

      <div style={{ background:'#13161e', border:'1px solid #2a2f3f', borderRadius:10, overflow:'hidden' }}>
        {/* Table header */}
        <div style={{ display:'grid', gridTemplateColumns:COLS, padding:'8px 16px', borderBottom:'1px solid #2a2f3f', background:'#0d0f14' }}>
          {['Member','Role','Server access','Added','Actions'].map((h,i)=>(
            <div key={i} style={{ fontSize:10, fontWeight:600, color:'#4e5668', textTransform:'uppercase' as const, letterSpacing:'0.06em' }}>{h}</div>
          ))}
        </div>

        {users.length === 0 && (
          <div style={{ padding:'32px 16px', textAlign:'center' as const, color:'#4e5668', fontSize:12 }}>No team members yet.</div>
        )}

        {users.map((u, i)=>(
          <div key={u.username} style={{ display:'grid', gridTemplateColumns:COLS, padding:'12px 16px', borderBottom:i<users.length-1?'1px solid #1a1e28':'none', alignItems:'center' }}>
            {/* Member */}
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div style={{ width:30, height:30, borderRadius:'50%', background:'#1a1e28', border:'1px solid #2a2f3f', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:600, color:u.role==='admin'?'#818cf8':'#22c55e', flexShrink:0 }}>
                {u.username[0].toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0' }}>{u.username}</div>
                {u.username===currentUser && <div style={{ fontSize:9, color:'#4f7cff', marginTop:1 }}>you</div>}
              </div>
            </div>

            {/* Role */}
            <div>
              {isAdmin && u.username!==currentUser ? (
                <select value={u.role} onChange={e=>handleRoleChange(u.username,e.target.value)}
                  style={{ background:'#0d0f14', border:`1px solid ${u.role==='admin'?'#1e2d66':'#0d4f2a'}`, color:u.role==='admin'?'#818cf8':'#22c55e', borderRadius:6, padding:'4px 10px', fontSize:11, cursor:'pointer', fontFamily:'inherit', outline:'none' }}>
                  <option value="admin">Admin</option>
                  <option value="developer">Developer</option>
                </select>
              ) : (
                <span style={{ fontSize:11, fontWeight:600, padding:'3px 10px', borderRadius:6, background:u.role==='admin'?'#0d1433':'#052e1a', border:`1px solid ${u.role==='admin'?'#1e2d66':'#0d4f2a'}`, color:u.role==='admin'?'#818cf8':'#22c55e' }}>{u.role}</span>
              )}
            </div>

            {/* Server access summary */}
            <div>
              {u.role === 'admin' ? (
                <span style={{ fontSize:10, color:'#818cf8', background:'#0d1433', border:'1px solid #1e2d66', borderRadius:6, padding:'2px 8px' }}>All servers</span>
              ) : (
                <ServerAccessBadge username={u.username} totalServers={allServers.length} refreshKey={accessRefreshKey} />
              )}
            </div>

            {/* Added */}
            <div style={{ fontSize:11, color:'#4e5668' }}>{u.created_at?new Date(u.created_at).toLocaleDateString():'—'}</div>

            {/* Actions */}
            <div style={{ display:'flex', gap:6 }}>
              {isAdmin && u.role !== 'admin' && (
                <button onClick={()=>setManagingAccess(u.username)}
                  style={{ background:'none', border:'1px solid #2a2f3f', color:'#4f7cff', borderRadius:5, padding:'3px 8px', fontSize:10, cursor:'pointer', fontFamily:'inherit' }}
                  onMouseOver={e=>{e.currentTarget.style.borderColor='#4f7cff';}}
                  onMouseOut={e=>{e.currentTarget.style.borderColor='#2a2f3f';}}>
                  Access
                </button>
              )}
              {isAdmin && u.username!==currentUser && (
                <button onClick={()=>handleDelete(u.username)}
                  style={{ background:'none', border:'1px solid #2a2f3f', color:'#4e5668', borderRadius:5, padding:'3px 8px', fontSize:10, cursor:'pointer', fontFamily:'inherit' }}
                  onMouseOver={e=>{e.currentTarget.style.borderColor='#4f0d0d';e.currentTarget.style.color='#ef4444';}}
                  onMouseOut={e=>{e.currentTarget.style.borderColor='#2a2f3f';e.currentTarget.style.color='#4e5668';}}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showAdd && <AddUserModal onClose={()=>setShowAdd(false)} onAdded={u=>{setUsers(p=>[...p,u]);setShowAdd(false);}}/>}
      {managingAccess && (
        <ManageAccessModal
          username={managingAccess}
          allServers={allServers}
          onClose={(saved)=>{ setManagingAccess(null); if(saved) setAccessRefreshKey(k=>k+1); }}
        />
      )}
    </div>
  );
}

// ─── Main app ──────────────────────────────────────────────────────────
export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState('');
  const [role, setRole] = useState('developer');
  const [serverList, setServerList] = useState<Server[]>([]);
  const [activeTopTab, setActiveTopTab] = useState<'dashboard'|'servers'|'team'|string>('dashboard');
  const [openConnections, setOpenConnections] = useState<string[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showChangePwd, setShowChangePwd] = useState(false);

  const isAdmin = role === 'admin';

  useEffect(() => {
    const token = localStorage.getItem('serverhub_token');
    if (!token) { router.push('/login'); return; }
    auth.me()
      .then(r => { setUser(r.data.username); setRole(r.data.role ?? 'developer'); })
      .catch(() => { localStorage.removeItem('serverhub_token'); router.push('/login'); });
    loadServers();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadServers = async () => {
    try { const r = await serverApi.list(); setServerList(r.data); } catch {}
  };

  const openConnection = (s: Server) => {
    if (!openConnections.includes(s.id)) setOpenConnections(p => [...p, s.id]);
    setActiveTopTab(s.id);
  };

  const closeConnection = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenConnections(p => p.filter(x => x !== id));
    if (activeTopTab === id) setActiveTopTab('servers');
  };

  const handleLogout = () => { localStorage.removeItem('serverhub_token'); router.push('/login'); };

  const handleServerAdded = (s: Server) => {
    setServerList(p => [...p, s]);
    openConnection(s);
  };

  const handleDeleteServer = async (id: string) => {
    if (!confirm('Remove this server?')) return;
    try {
      await serverApi.delete(id);
      setServerList(p => p.filter(s => s.id !== id));
      setOpenConnections(p => p.filter(x => x !== id));
      if (activeTopTab === id) setActiveTopTab('servers');
    } catch (e: any) { alert(e.response?.data?.detail || 'Failed'); }
  };

  const online = serverList.filter(s => s.status === 'online').length;

  const navTab = (id: string, label: React.ReactNode) => (
    <button key={id} onClick={() => setActiveTopTab(id)}
      style={{ padding:'0 14px', background:'none', border:'none', borderBottom:`2px solid ${activeTopTab===id?'#4f7cff':'transparent'}`,
        color:activeTopTab===id?'#e2e6f0':'#4e5668', fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:'inherit', transition:'color 0.15s', whiteSpace:'nowrap' as const }}>
      {label}
    </button>
  );

  return (
    <div style={{ height:'100vh', display:'flex', flexDirection:'column', background:'#0d0f14', fontFamily:"'Sora',sans-serif", fontSize:13 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Sora:wght@300;400;500;600&display=swap');`}</style>

      {/* ── Top bar ─────────────────────────────────── */}
      <div style={{ height:44, background:'#13161e', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'stretch', padding:'0 16px', gap:0, flexShrink:0 }}>
        {/* Logo */}
        <div style={{ display:'flex', alignItems:'center', gap:7, paddingRight:20, borderRight:'1px solid #2a2f3f', marginRight:2 }}>
          <div style={{ width:8, height:8, borderRadius:'50%', background:'#4f7cff' }}/>
          <span style={{ fontSize:14, fontWeight:600, color:'#e2e6f0', letterSpacing:'-0.02em' }}>ServerHub</span>
        </div>

        {/* Static nav tabs */}
        {navTab('dashboard', 'Dashboard')}
        {navTab('servers', <>Servers{serverList.length>0&&<span style={{ fontSize:9, color:'#4e5668', background:'#1a1e28', borderRadius:8, padding:'1px 5px', marginLeft:4 }}>{serverList.length}</span>}</>)}
        {navTab('team', 'Team')}

        {/* Separator */}
        {openConnections.length > 0 && <div style={{ width:1, background:'#2a2f3f', margin:'8px 6px' }}/>}

        {/* Open connection tabs */}
        <div style={{ display:'flex', alignItems:'stretch', overflowX:'auto', flex:1 }}>
          {openConnections.map(id => {
            const s = serverList.find(x => x.id === id);
            if (!s) return null;
            const isActive = activeTopTab === id;
            return (
              <button key={id} onClick={() => setActiveTopTab(id)}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'0 12px', background:isActive?'#1a1e28':'none', border:'none',
                  borderBottom:`2px solid ${isActive?'#4f7cff':'transparent'}`, color:isActive?'#e2e6f0':'#8892a4',
                  fontSize:11, cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap' as const, flexShrink:0, transition:'all 0.15s' }}>
                <div style={{ width:5, height:5, borderRadius:'50%', background:s.status==='online'?'#22c55e':s.status==='offline'?'#ef4444':'#4e5668', flexShrink:0 }}/>
                {s.name}
                <span onClick={e => closeConnection(id, e)}
                  style={{ marginLeft:2, color:'#4e5668', fontSize:14, lineHeight:1, padding:'0 2px', borderRadius:3 }}
                  onMouseOver={e=>e.currentTarget.style.color='#ef4444'} onMouseOut={e=>e.currentTarget.style.color='#4e5668'}>×</span>
              </button>
            );
          })}
        </div>

        {/* Right side */}
        <div style={{ display:'flex', alignItems:'center', gap:8, paddingLeft:12, borderLeft:'1px solid #2a2f3f', flexShrink:0 }}>
          <div style={{ fontSize:11, color:'#4e5668', display:'flex', alignItems:'center', gap:5 }}>
            <div style={{ width:5, height:5, borderRadius:'50%', background:'#22c55e' }}/>{online}/{serverList.length}
          </div>
          {/* User badge */}
          <div style={{ display:'flex', alignItems:'center', gap:6, background:'#0d0f14', border:'1px solid #2a2f3f', borderRadius:7, padding:'4px 10px' }}>
            <div style={{ width:18, height:18, borderRadius:'50%', background:isAdmin?'#0d1433':'#052e1a', border:`1px solid ${isAdmin?'#1e2d66':'#0d4f2a'}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:700, color:isAdmin?'#818cf8':'#22c55e' }}>
              {user[0]?.toUpperCase()}
            </div>
            <span style={{ fontSize:11, color:'#e2e6f0' }}>{user}</span>
            <span style={{ fontSize:9, fontWeight:600, color:isAdmin?'#818cf8':'#22c55e', background:isAdmin?'#0d1433':'#052e1a', padding:'1px 5px', borderRadius:4 }}>{role}</span>
          </div>
          <button onClick={()=>setShowChangePwd(true)} title="Change password"
            style={{ background:'#1a1e28', border:'1px solid #2a2f3f', color:'#8892a4', borderRadius:6, padding:'5px 8px', cursor:'pointer', fontSize:12 }}
            onMouseOver={e=>e.currentTarget.style.borderColor='#4f7cff'} onMouseOut={e=>e.currentTarget.style.borderColor='#2a2f3f'}>⚙</button>
          <button onClick={handleLogout} style={{ ...btnGhost, padding:'4px 10px', fontSize:11 }}>Sign out</button>
          {isAdmin && (
            <button onClick={() => setShowAddModal(true)} style={{ ...btnPrimary, padding:'5px 12px', fontSize:11, display:'flex', alignItems:'center', gap:4 }}>
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              Add server
            </button>
          )}
        </div>
      </div>

      {/* ── Content ─────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {activeTopTab === 'dashboard' && (
          <HomeDashboard servers={serverList} onOpen={openConnection} onAdd={()=>setShowAddModal(true)} isAdmin={isAdmin}/>
        )}
        {activeTopTab === 'servers' && (
          <ServersTable servers={serverList} onOpen={openConnection} onDelete={handleDeleteServer} onAdd={()=>setShowAddModal(true)} isAdmin={isAdmin}/>
        )}
        {activeTopTab === 'team' && (
          <TeamPage currentUser={user} isAdmin={isAdmin} allServers={serverList}/>
        )}
        {/* Connection tabs — all rendered but hidden when inactive to preserve SSH sessions */}
        {openConnections.map(id => {
          const s = serverList.find(x => x.id === id);
          if (!s) return null;
          return (
            <div key={id} style={{ display:activeTopTab===id?'flex':'none', flex:1, flexDirection:'column', overflow:'hidden' }}>
              <ServerConnection server={s}/>
            </div>
          );
        })}
      </div>

      {showAddModal   && <AddServerModal      onClose={()=>setShowAddModal(false)}  onAdded={handleServerAdded}/>}
      {showChangePwd  && <ChangePasswordModal onClose={()=>setShowChangePwd(false)}/>}

      {/* ── Footer ──────────────────────────────────── */}
      <div style={{ height:28, background:'#13161e', borderTop:'1px solid #1a1e28', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
        <span style={{ fontSize:10, color:'#4e5668' }}>
          Powered by{' '}
          <a href="https://github.com/finedevsam" target="_blank" rel="noopener noreferrer"
            style={{ color:'#4f7cff', textDecoration:'none', fontWeight:600 }}
            onMouseOver={e=>e.currentTarget.style.textDecoration='underline'}
            onMouseOut={e=>e.currentTarget.style.textDecoration='none'}>
            finedevsam
          </a>
        </span>
      </div>
    </div>
  );
}
