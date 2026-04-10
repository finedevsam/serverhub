'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { servers as serverApi, auth } from '@/lib/api';
import dynamic from 'next/dynamic';

const TerminalTab = dynamic(() => import('./TerminalTab'), { ssr: false, loading: () => (
  <div style={{ flex:1, background:'#080a0e', display:'flex', alignItems:'center', justifyContent:'center', color:'#4e5668', fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>Initialising terminal…</div>
) });

interface Server { id: string; name: string; ip: string; port: number; username: string; auth_type: string; tag: string; status: string; }
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

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState('');
  const [serverList, setServerList] = useState<Server[]>([]);
  const [activeServerId, setActiveServerId] = useState<string|null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('Overview');
  const [showAddModal, setShowAddModal] = useState(false);
  const [termEverShown, setTermEverShown] = useState(false);
  const termSendRef = useRef<((s: string) => void) | null>(null);

  useEffect(()=>{
    const token=localStorage.getItem('serverhub_token');
    if(!token){router.push('/login');return;}
    auth.me().then(r=>setUser(r.data.username)).catch(()=>{localStorage.removeItem('serverhub_token');router.push('/login');});
    loadServers();
  },[]);

  // Reset terminal mount state when active server changes
  useEffect(()=>{ setTermEverShown(false); termSendRef.current = null; },[activeServerId]);

  const loadServers=async()=>{
    try{const r=await serverApi.list();setServerList(r.data);if(r.data.length>0)setActiveServerId(r.data[0].id);}catch{}
  };

  const activeServer=serverList.find(s=>s.id===activeServerId);

  const handleLogout=()=>{ localStorage.removeItem('serverhub_token'); router.push('/login'); };

  const handleRunCmd=(cmd:string)=>{
    setActiveTab('Terminal');
    setTermEverShown(true);
    // Send to live terminal if already connected, else it will be picked up via initialCmd on first mount
    if(termSendRef.current) { setTimeout(()=>termSendRef.current?.(cmd+'\n'), 100); }
  };

  const handleServerAdded=(s:Server)=>{ setServerList(p=>[...p,s]); setActiveServerId(s.id); };

  const handleDeleteServer=async(id:string)=>{
    if(!confirm('Remove this server?')) return;
    try{await serverApi.delete(id);setServerList(p=>p.filter(s=>s.id!==id));if(activeServerId===id)setActiveServerId(serverList.find(s=>s.id!==id)?.id||null);}
    catch(e:any){alert(e.response?.data?.detail||'Failed');}
  };

  return (
    <div style={{ height:'100vh', display:'flex', flexDirection:'column', background:'#0d0f14', fontFamily:"'Sora',sans-serif", fontSize:13 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Sora:wght@300;400;500;600&display=swap');`}</style>
      {/* TOP BAR */}
      <div style={{ height:44, background:'#13161e', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', padding:'0 16px', gap:12, flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:7 }}>
          <div style={{ width:8, height:8, borderRadius:'50%', background:'#4f7cff' }}/>
          <span style={{ fontSize:14, fontWeight:600, color:'#e2e6f0', letterSpacing:'-0.02em' }}>ServerHub</span>
        </div>
        <div style={{ fontSize:11, color:'#4e5668' }}>{serverList.filter(s=>s.status==='online').length} online · {serverList.length} total</div>
        <div style={{ flex:1 }}/>
        <div style={{ fontSize:11, color:'#4e5668', display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ width:6, height:6, borderRadius:'50%', background:'#22c55e' }}/>{user}
        </div>
        <button onClick={handleLogout} style={{ ...btnGhost, padding:'4px 12px', fontSize:11 }}>Sign out</button>
        <button onClick={()=>setShowAddModal(true)} style={{ ...btnPrimary, padding:'5px 14px', fontSize:12, display:'flex', alignItems:'center', gap:5 }}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          Add server
        </button>
      </div>
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
        {/* SIDEBAR */}
        <div style={{ width:220, background:'#13161e', borderRight:'1px solid #2a2f3f', display:'flex', flexDirection:'column', flexShrink:0, overflowY:'auto' }}>
          <div style={{ padding:'12px 12px 4px', fontSize:10, fontWeight:600, color:'#2a2f3f', letterSpacing:'0.08em', textTransform:'uppercase' as const }}>Servers</div>
          {serverList.length===0&&(
            <div style={{ padding:'16px 14px', fontSize:12, color:'#4e5668', textAlign:'center' as const, lineHeight:1.6 }}>
              No servers yet.<br/>
              <span style={{ color:'#4f7cff', cursor:'pointer' }} onClick={()=>setShowAddModal(true)}>Add your first server →</span>
            </div>
          )}
          {serverList.map(s=>(
            <div key={s.id} onClick={()=>setActiveServerId(s.id)}
              style={{ display:'flex', alignItems:'center', gap:9, padding:'8px 12px', cursor:'pointer', position:'relative', background:s.id===activeServerId?'#1a1e28':'transparent', transition:'background 0.15s' }}
              onMouseOver={e=>{if(s.id!==activeServerId)e.currentTarget.style.background='#161920';}} onMouseOut={e=>{if(s.id!==activeServerId)e.currentTarget.style.background='transparent';}}>
              {s.id===activeServerId&&<div style={{ position:'absolute', left:0, top:4, bottom:4, width:2, background:'#4f7cff', borderRadius:'0 2px 2px 0' }}/>}
              <StatusDot status={s.status}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:500, color:'#e2e6f0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }}>{s.name}</div>
                <div style={{ fontSize:10, color:'#4e5668' }}>{s.ip}</div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:9, color:'#4e5668', background:'#1a1e28', padding:'1px 5px', borderRadius:3, border:'1px solid #2a2f3f' }}>{s.tag}</span>
                <button onClick={e=>{e.stopPropagation();handleDeleteServer(s.id);}}
                  style={{ background:'none', border:'none', color:'#2a2f3f', cursor:'pointer', fontSize:13, lineHeight:1, padding:'0 2px' }}
                  onMouseOver={e=>e.currentTarget.style.color='#ef4444'} onMouseOut={e=>e.currentTarget.style.color='#2a2f3f'}>✕</button>
              </div>
            </div>
          ))}
        </div>
        {/* MAIN */}
        {activeServer?(
          <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ padding:'12px 20px', background:'#13161e', borderBottom:'1px solid #2a2f3f', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
              <div>
                <div style={{ fontSize:15, fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
                  {activeServer.name}
                  <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:20, letterSpacing:'0.04em',
                    background:activeServer.status==='online'?'#052e1a':activeServer.status==='offline'?'#2e0505':'#1a1520',
                    border:`1px solid ${activeServer.status==='online'?'#0d4f2a':activeServer.status==='offline'?'#4f0d0d':'#2a1e3f'}`,
                    color:activeServer.status==='online'?'#22c55e':activeServer.status==='offline'?'#ef4444':'#8892a4' }}>
                    {activeServer.status==='online'?'● ONLINE':activeServer.status==='offline'?'✕ OFFLINE':'? UNKNOWN'}
                  </span>
                </div>
                <div style={{ color:'#4e5668', fontSize:11, display:'flex', gap:16, marginTop:3 }}>
                  <span>{activeServer.ip}:{activeServer.port}</span>
                  <span>user: {activeServer.username}</span>
                  <span>auth: {activeServer.auth_type}</span>
                </div>
              </div>
              <div style={{ flex:1 }}/>
              <div style={{ display:'flex', gap:2, background:'#0d0f14', borderRadius:7, padding:3 }}>
                {TABS.map(tab=>(
                  <button key={tab} onClick={()=>setActiveTab(tab)}
                    style={{ padding:'4px 12px', borderRadius:5, cursor:'pointer', fontSize:11, fontWeight:500, border:'none', fontFamily:'inherit', transition:'all 0.15s',
                      background:tab===activeTab?'#13161e':'transparent', color:tab===activeTab?'#e2e6f0':'#4e5668' }}>
                    {tab}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              {activeTab==='Overview'&&<OverviewTab server={activeServer} onRunCmd={handleRunCmd}/>}
              {/* Terminal is always mounted once first visited; hidden with CSS to preserve the SSH session */}
              {(termEverShown||activeTab==='Terminal')&&(
                <div style={{ display:activeTab==='Terminal'?'flex':'none', flex:1, flexDirection:'column', overflow:'hidden' }}
                  ref={()=>{ if(activeTab==='Terminal') setTermEverShown(true); }}>
                  <TerminalTab
                    key={activeServer.id}
                    server={activeServer}
                    isActive={activeTab==='Terminal'}
                    onReady={(fn)=>{ termSendRef.current=fn; }}
                  />
                </div>
              )}
              {activeTab==='Docker'&&<DockerTab server={activeServer}/>}
              {activeTab==='Services'&&<ServicesTab server={activeServer}/>}
              {activeTab==='Files'&&<FilesTab server={activeServer}/>}
              {activeTab==='Logs'&&<LogsTab server={activeServer}/>}
            </div>
          </div>
        ):(
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16, color:'#4e5668' }}>
            <div style={{ width:48, height:48, borderRadius:12, background:'#13161e', border:'1px solid #2a2f3f', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22 }}>🖥</div>
            <div style={{ textAlign:'center' as const }}>
              <div style={{ color:'#8892a4', fontWeight:500, marginBottom:4 }}>No server selected</div>
              <div style={{ fontSize:12 }}>Add a server to get started</div>
            </div>
            <button onClick={()=>setShowAddModal(true)} style={btnPrimary}>Add your first server</button>
          </div>
        )}
      </div>
      {showAddModal&&<AddServerModal onClose={()=>setShowAddModal(false)} onAdded={handleServerAdded}/>}
    </div>
  );
}
