import { useState, useEffect, useRef } from "react";

// 後端 API（Render 部署）
const API_BASE = "https://crypto-scanner-02sp.onrender.com";

const DEFAULT_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","LTCUSDT","ATOMUSDT","NEARUSDT","APTUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","TIAUSDT",
];

const INTERVALS = [
  { label: "15分", value: "15m" },
  { label: "1小時", value: "1h" },
  { label: "4小時", value: "4h" },
  { label: "日線",  value: "1d" },
];

export default function App() {
  const [interval, setIntervalVal] = useState("4h");
  const [symbolInput, setSymbolInput] = useState(DEFAULT_SYMBOLS.join(","));
  const [results,  setResults]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [filter,   setFilter]   = useState("all");
  const [lastScan, setLastScan] = useState(null);
  const [error,    setError]    = useState(null);
  const [showCfg,  setShowCfg]  = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);
  const firstLoad = useRef(true);

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runScan(iv = interval, syms = symbolInput, attempt = 1) {
    setLoading(true);
    setError(null);
    setStatusMsg(attempt === 1 ? "連線後端中…（免費方案可能需要喚醒，請耐心等候）" : `重試中（第 ${attempt} 次）…`);
    try {
      const url = `${API_BASE}/scan?symbols=${encodeURIComponent(syms)}&interval=${iv}`;
      const res = await fetchWithTimeout(url, 60000); // 60秒逾時，喚醒+掃描都算進去
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResults(data.results || []);
      setLastScan(new Date().toLocaleTimeString("zh-TW"));
      setStatusMsg(null);
    } catch (e) {
      const isAbort = e.name === "AbortError";
      const isNetwork = e.message.includes("Failed to fetch") || e.message.includes("NetworkError");

      if ((isAbort || isNetwork) && attempt < 3) {
        // 自動重試，通常第一次是在喚醒 Render 休眠的容器
        setStatusMsg(`後端可能正在喚醒，10 秒後自動重試（第 ${attempt + 1}/3 次）…`);
        setTimeout(() => runScan(iv, syms, attempt + 1), 10000);
        return;
      }

      setError(
        isAbort ? "連線逾時（超過60秒），後端可能無回應，請稍後再按「重新掃描」"
        : isNetwork ? "無法連線到後端，請確認網址正確、Render 服務狀態為 Live"
        : e.message
      );
      setStatusMsg(null);
    } finally {
      setLoading(false);
    }
  }

  // ── 一打開就自動掃描 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      runScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = results.filter(r => {
    if (filter === "strong") return r.score >= 65;
    if (filter === "above")  return r.aboveAll;
    return true;
  });

  const okIcon = ok => ok === true ? "✅" : ok === "warn" ? "⚠️" : "❌";

  const S = {
    page: { minHeight:"100vh", background:"#07090f", color:"#dde1f0",
      fontFamily:"'SF Mono','Fira Code',ui-monospace,monospace", padding:"20px 14px" },
    card: (score) => ({ background:"#0c111e", borderRadius:10,
      border:`1px solid ${score>=85?"#3949ab":score>=65?"#2e3a5e":score>=45?"#1c2d35":"#111827"}`,
      cursor:"pointer", overflow:"hidden",
      boxShadow: score>=85?"0 0 22px #3949ab44":score>=65?"0 0 10px #1a237e22":"none" }),
    btn: (primary) => ({ padding:"7px 16px", borderRadius:6,
      border: primary?"none":"1px solid #1a2035",
      background: primary?"linear-gradient(135deg,#283593,#00695c)":"transparent",
      color: primary?"#fff":"#546e7a", cursor:"pointer", fontSize:12,
      fontWeight:700, fontFamily:"inherit" }),
  };

  return (
    <div style={S.page}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* Header */}
      <div style={{ textAlign:"center", marginBottom:20 }}>
        <div style={{ fontSize:10, letterSpacing:5, color:"#3d5afe", textTransform:"uppercase", marginBottom:6 }}>
          FUTURES BREAKOUT SCANNER
        </div>
        <h1 style={{ margin:0, fontSize:22, fontWeight:800,
          background:"linear-gradient(90deg,#7986cb,#4dd0e1)",
          WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
          合約橫盤縮量爆發偵測器
        </h1>
        <p style={{ margin:"6px 0 0", color:"#455a64", fontSize:11 }}>
          開啟即自動掃描 · 幣安合約即時數據
        </p>
      </div>

      {/* Controls */}
      <div style={{ display:"flex", flexWrap:"wrap", gap:8, justifyContent:"center", marginBottom:14 }}>
        {INTERVALS.map(iv => (
          <button key={iv.value}
            onClick={() => { setIntervalVal(iv.value); runScan(iv.value, symbolInput); }}
            style={{ padding:"7px 16px", borderRadius:6,
              border:`1px solid ${interval===iv.value?"#5c6bc0":"#1a2035"}`,
              background: interval===iv.value?"#1a2040":"transparent",
              color: interval===iv.value?"#9fa8da":"#455a64",
              cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>
            {iv.label}
          </button>
        ))}
        <button onClick={() => runScan()} disabled={loading} style={S.btn(true)}>
          {loading ? (
            <span style={{ display:"flex", alignItems:"center", gap:7 }}>
              <span style={{ display:"inline-block", width:11, height:11,
                border:"2px solid #546e7a", borderTopColor:"#fff",
                borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
              掃描中…
            </span>
          ) : "🔄 重新掃描"}
        </button>
        <button onClick={() => setShowCfg(!showCfg)} style={S.btn(false)}>⚙️ 幣種設定</button>
      </div>

      {/* Config panel */}
      {showCfg && (
        <div style={{ maxWidth:680, margin:"0 auto 16px", background:"#0c111e",
          border:"1px solid #1a2035", borderRadius:10, padding:"14px 16px" }}>
          <div style={{ fontSize:11, color:"#546e7a", marginBottom:8 }}>
            自訂幣種（逗號分隔，需含 USDT）
          </div>
          <textarea value={symbolInput} onChange={e => setSymbolInput(e.target.value)}
            style={{ width:"100%", minHeight:70, background:"#060810", border:"1px solid #1a2035",
              borderRadius:6, color:"#90a4ae", fontSize:12, padding:"8px 10px",
              fontFamily:"inherit", resize:"vertical", boxSizing:"border-box" }}/>
          <button onClick={() => runScan(interval, symbolInput)}
            style={{ ...S.btn(true), marginTop:8 }}>套用並重新掃描</button>
        </div>
      )}

      {lastScan && !loading && (
        <div style={{ textAlign:"center", fontSize:10, color:"#263238", marginBottom:14 }}>
          上次掃描 {lastScan} · {INTERVALS.find(i=>i.value===interval)?.label} · 共 {results.length} 個結果
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ maxWidth:600, margin:"0 auto 20px", background:"#1a0a0a",
          border:"1px solid #c62828", borderRadius:8, padding:"14px 16px", color:"#ef9a9a", fontSize:12 }}>
          ⚠️ {error}
          <div style={{ marginTop:8, fontSize:11, color:"#795548" }}>
            目前後端網址：{API_BASE}
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && results.length === 0 && (
        <div style={{ textAlign:"center", color:"#37474f", marginTop:60, fontSize:13 }}>
          {statusMsg || "正在連線後端並分析數據…"}
        </div>
      )}

      {/* Filter */}
      {results.length > 0 && (
        <div style={{ display:"flex", gap:6, justifyContent:"center", marginBottom:14 }}>
          {[["all","全部"],["strong","強訊號≥65"],["above","站上三均線"]].map(([v,l]) => (
            <button key={v} onClick={() => setFilter(v)}
              style={{ padding:"4px 12px", borderRadius:20,
                border:`1px solid ${filter===v?"#5c6bc0":"#1a2035"}`,
                background: filter===v?"#1a2040":"transparent",
                color: filter===v?"#9fa8da":"#37474f",
                cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
              {l}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      <div style={{ maxWidth:780, margin:"0 auto", display:"flex", flexDirection:"column", gap:8 }}>
        {filtered.map((r, idx) => (
          <div key={r.symbol} style={S.card(r.score)}
            onClick={() => setExpanded(expanded === r.symbol ? null : r.symbol)}>

            <div style={{ display:"flex", alignItems:"center", padding:"12px 16px", gap:12 }}>
              <div style={{ minWidth:22, color:"#263238", fontSize:10, textAlign:"center" }}>#{idx+1}</div>

              <div style={{ position:"relative", minWidth:48, height:48 }}>
                <svg width="48" height="48" style={{ transform:"rotate(-90deg)" }}>
                  <circle cx="24" cy="24" r="18" fill="none" stroke="#111827" strokeWidth="4"/>
                  <circle cx="24" cy="24" r="18" fill="none" stroke={r.gradeColor} strokeWidth="4"
                    strokeDasharray={`${(r.score/100)*113} 113`} strokeLinecap="round"/>
                </svg>
                <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:12, fontWeight:800, color:r.gradeColor }}>
                  {r.score}
                </div>
              </div>

              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap", marginBottom:4 }}>
                  <span style={{ fontSize:14, fontWeight:700, color:"#dde1f0" }}>
                    {r.symbol.replace("USDT","")}<span style={{ color:"#1e293b", fontSize:10 }}>/USDT.PERP</span>
                  </span>
                  <span style={{ fontSize:10, color:r.gradeColor, background:`${r.gradeColor}1a`, padding:"2px 7px", borderRadius:4 }}>{r.grade}</span>
                  {r.maFan && <span style={{ fontSize:10, color:"#4dd0e1", background:"#00695c18", padding:"2px 6px", borderRadius:4 }}>多頭排列</span>}
                </div>
                <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
                  <span style={{ fontSize:10, color:"#37474f" }}>現價 <span style={{ color:"#90a4ae" }}>{r.price}</span></span>
                  <span style={{ fontSize:10, color:"#37474f" }}>MA30 <span style={{ color:"#7986cb" }}>{r.ma30}</span></span>
                  <span style={{ fontSize:10, color:"#37474f" }}>MA45 <span style={{ color:"#9575cd" }}>{r.ma45}</span></span>
                  <span style={{ fontSize:10, color:"#37474f" }}>MA60 <span style={{ color:"#26c6da" }}>{r.ma60}</span></span>
                </div>
              </div>

              <div style={{ display:"flex", gap:3 }}>
                {r.signals.map(s => (
                  <div key={s.key} style={{ width:6, height:6, borderRadius:"50%",
                    background: s.ok===true?"#00897b":s.ok==="warn"?"#ff9500":"#1e293b" }} />
                ))}
              </div>
              <span style={{ color:"#263238", fontSize:12 }}>{expanded===r.symbol?"▲":"▼"}</span>
            </div>

            {expanded === r.symbol && (
              <div style={{ borderTop:"1px solid #111827", padding:"14px 18px" }}>
                <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:14 }}>
                  {r.signals.map(s => (
                    <div key={s.key} style={{ display:"flex", gap:10 }}>
                      <span style={{ minWidth:20 }}>{okIcon(s.ok)}</span>
                      <div>
                        <span style={{ fontSize:11, fontWeight:700,
                          color: s.ok===true?"#4dd0e1":s.ok==="warn"?"#ffb74d":"#455a64" }}>
                          {s.label}
                        </span>
                        <span style={{ fontSize:10, color:"#263238", marginLeft:6 }}>{s.score}/{s.weight}pt</span>
                        <div style={{ fontSize:11, color:"#546e7a", lineHeight:1.6, marginTop:2 }}>{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {r.extras?.length > 0 && (
                  <div style={{ borderTop:"1px solid #111827", paddingTop:12, marginBottom:12 }}>
                    <div style={{ fontSize:10, color:"#3d5afe", letterSpacing:2, marginBottom:8 }}>FUTURES DATA</div>
                    <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                      {r.extras.map(ex => (
                        <div key={ex.label} style={{ background:"#060810", borderRadius:6, padding:"8px 12px",
                          border:`1px solid ${ex.color}33` }}>
                          <div style={{ fontSize:10, color:"#455a64", marginBottom:2 }}>{ex.label}</div>
                          <div style={{ fontSize:13, fontWeight:700, color:ex.color }}>{ex.value}</div>
                          <div style={{ fontSize:10, color:"#37474f", marginTop:2 }}>{ex.note}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#37474f", marginBottom:4 }}>
                    <span>綜合評分</span>
                    <span style={{ color:r.gradeColor, fontWeight:700 }}>{r.score}/100</span>
                  </div>
                  <div style={{ height:4, background:"#111827", borderRadius:3 }}>
                    <div style={{ width:`${r.score}%`, height:"100%",
                      background:`linear-gradient(90deg,#283593,${r.gradeColor})`, borderRadius:3 }} />
                  </div>
                </div>
                <div style={{ marginTop:10, fontSize:10, color:"#1e293b" }}>
                  ⚠️ 技術指標僅供參考，不構成投資建議，合約交易風險極高。
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {!loading && results.length > 0 && filtered.length === 0 && (
        <div style={{ textAlign:"center", color:"#263238", marginTop:30, fontSize:12 }}>
          沒有符合此篩選條件的標的
        </div>
      )}

      <div style={{ textAlign:"center", marginTop:28, fontSize:10, color:"#111827" }}>
        FUTURES BREAKOUT SCANNER · Render Backend
      </div>
    </div>
  );
}
