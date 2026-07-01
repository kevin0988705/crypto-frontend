import { useState, useEffect, useRef } from "react";

const API_BASE = "https://crypto-scanner-02sp.onrender.com";

const DEFAULT_SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT",
  "MATICUSDT","LTCUSDT","ATOMUSDT","NEARUSDT","APTUSDT",
  "ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","TIAUSDT",
];

const INTERVALS = [
  { label: "15分鐘", value: "15m" },
  { label: "1小時",  value: "1h"  },
  { label: "4小時",  value: "4h"  },
  { label: "日線",   value: "1d"  },
];

const GRADE_ORDER = { "🔥 極強訊號": 0, "⚡ 強訊號": 1, "👀 留意觀察": 2, "😴 無明顯": 3 };

export default function App() {
  const [interval,     setIntervalVal]  = useState("4h");
  const [symbolInput,  setSymbolInput]  = useState(DEFAULT_SYMBOLS.join(","));
  const [mode,         setMode]         = useState("top100");
  const [results,      setResults]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [expanded,     setExpanded]     = useState(null);
  const [filter,       setFilter]       = useState("all");
  const [sortKey,      setSortKey]      = useState("score");
  const [lastScan,     setLastScan]     = useState(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [error,        setError]        = useState(null);
  const [statusMsg,    setStatusMsg]    = useState(null);
  const [showCustom,   setShowCustom]   = useState(false);
  const firstLoad = useRef(true);

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try { return await fetch(url, { signal: controller.signal }); }
    finally { clearTimeout(t); }
  }

  async function runScan(iv = interval, syms = symbolInput, scanMode = mode, attempt = 1) {
    setLoading(true); setError(null);
    setStatusMsg(attempt === 1
      ? (scanMode === "top100" ? "連線後端中…首次掃描可能需要 30-90 秒喚醒 Render 服務" : "連線後端中…")
      : `後端喚醒中，第 ${attempt}/3 次重試…`);
    try {
      const url = scanMode === "top100"
        ? `${API_BASE}/scan?top=100&interval=${iv}`
        : `${API_BASE}/scan?symbols=${encodeURIComponent(syms)}&interval=${iv}`;
      const res = await fetchWithTimeout(url, 90000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results || []);
      setScannedCount(data.scanned || 0);
      setLastScan(new Date().toLocaleTimeString("zh-TW"));
      setStatusMsg(null);
    } catch (e) {
      const isAbort   = e.name === "AbortError";
      const isNetwork = e.message.includes("Failed to fetch") || e.message.includes("NetworkError");
      if ((isAbort || isNetwork) && attempt < 3) {
        setStatusMsg(`後端休眠中，10 秒後自動重試（${attempt + 1}/3）…`);
        setTimeout(() => runScan(iv, syms, scanMode, attempt + 1), 10000);
        return;
      }
      setError(isAbort ? "連線逾時，請稍後重新掃描" : isNetwork ? "無法連線後端" : e.message);
      setStatusMsg(null);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; runScan("4h", symbolInput, "top100"); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = results
    .filter(r => {
      if (filter === "strong") return r.score >= 65;
      if (filter === "above")  return r.aboveAll;
      if (filter === "fan")    return r.maFan;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "score")  return b.score  - a.score;
      if (sortKey === "grade")  return (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9);
      if (sortKey === "symbol") return a.symbol.localeCompare(b.symbol);
      return 0;
    });

  const okIcon = ok => ok === true ? "✅" : ok === "warn" ? "⚠️" : "❌";

  const C = {
    sidebar:  { width:240, minWidth:240, background:"#0b0f1c", borderRight:"1px solid #0f1629",
                height:"100vh", overflowY:"auto", padding:"20px 16px", boxSizing:"border-box",
                display:"flex", flexDirection:"column", gap:20 },
    main:     { flex:1, overflowY:"auto", height:"100vh", background:"#07090f", padding:"20px 24px", boxSizing:"border-box" },
    sideLabel:{ fontSize:9, letterSpacing:3, color:"#1e3a5f", textTransform:"uppercase", marginBottom:8 },
    ivBtn:    (active) => ({ width:"100%", padding:"8px 12px", borderRadius:6, textAlign:"left",
                border:`1px solid ${active?"#3949ab":"#0f1629"}`,
                background: active?"#1a2040":"transparent",
                color: active?"#9fa8da":"#37474f",
                cursor:"pointer", fontSize:12, fontFamily:"inherit", marginBottom:4 }),
    modeBtn:  (active) => ({ width:"100%", padding:"9px 12px", borderRadius:7, textAlign:"left",
                border:`1px solid ${active?"#00897b":"#0f1629"}`,
                background: active?"#00695c22":"transparent",
                color: active?"#4dd0e1":"#37474f",
                cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600, marginBottom:4 }),
    filterBtn:(active) => ({ padding:"5px 12px", borderRadius:4,
                border:`1px solid ${active?"#3949ab":"#1a2035"}`,
                background: active?"#1a2040":"transparent",
                color: active?"#9fa8da":"#37474f",
                cursor:"pointer", fontSize:11, fontFamily:"inherit" }),
    scanBtn:  { width:"100%", padding:"10px", borderRadius:7, border:"none",
                background:"linear-gradient(135deg,#283593,#00695c)",
                color:"#fff", cursor:"pointer", fontSize:13, fontWeight:700, fontFamily:"inherit" },
    card:     (score, active) => ({
                background: active?"#0f1729":"#0c111e",
                border:`1px solid ${score>=85?"#3949ab":score>=65?"#2e3a5e":score>=45?"#1c2d35":"#111827"}`,
                borderRadius:8, marginBottom:6, cursor:"pointer", overflow:"hidden",
                boxShadow: active?"0 0 0 1px #3949ab44":score>=85?"0 0 16px #3949ab33":"none",
                transition:"background .15s" }),
  };

  const strong   = results.filter(r => r.score >= 65).length;
  const fanCount = results.filter(r => r.maFan).length;

  return (
    <div style={{ display:"flex", height:"100vh", overflow:"hidden",
      fontFamily:"'SF Mono','Fira Code',ui-monospace,monospace", color:"#dde1f0" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        ::-webkit-scrollbar { width: 4px }
        ::-webkit-scrollbar-track { background: #07090f }
        ::-webkit-scrollbar-thumb { background: #1a2035; border-radius: 2px }
        * { box-sizing: border-box }
      `}</style>

      {/* ── 左側面板 ── */}
      <div style={C.sidebar}>
        {/* Logo */}
        <div>
          <div style={{ fontSize:9, letterSpacing:4, color:"#3d5afe", textTransform:"uppercase", marginBottom:6 }}>
            FUTURES BREAKOUT
          </div>
          <div style={{ fontSize:16, fontWeight:800,
            background:"linear-gradient(90deg,#7986cb,#4dd0e1)",
            WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", lineHeight:1.3 }}>
            合約橫盤縮量<br/>爆發偵測器
          </div>
        </div>

        {/* 掃描模式 */}
        <div>
          <div style={C.sideLabel}>掃描模式</div>
          <button style={C.modeBtn(mode==="top100")}
            onClick={() => { setMode("top100"); runScan(interval, symbolInput, "top100"); }}>
            🏆 交易量前100名
          </button>
          <button style={C.modeBtn(mode==="custom")}
            onClick={() => { setMode("custom"); setShowCustom(true); }}>
            ✏️ 自訂幣種
          </button>
          {showCustom && mode === "custom" && (
            <div style={{ marginTop:8 }}>
              <textarea value={symbolInput} onChange={e => setSymbolInput(e.target.value)}
                placeholder="BTCUSDT,ETHUSDT,..."
                style={{ width:"100%", height:90, background:"#060810", border:"1px solid #1a2035",
                  borderRadius:6, color:"#90a4ae", fontSize:11, padding:"6px 8px",
                  fontFamily:"inherit", resize:"vertical" }}/>
              <button onClick={() => runScan(interval, symbolInput, "custom")}
                style={{ ...C.scanBtn, marginTop:6, fontSize:11 }}>套用並掃描</button>
            </div>
          )}
        </div>

        {/* 時間週期 */}
        <div>
          <div style={C.sideLabel}>時間週期</div>
          {INTERVALS.map(iv => (
            <button key={iv.value} style={C.ivBtn(interval===iv.value)}
              onClick={() => { setIntervalVal(iv.value); runScan(iv.value, symbolInput, mode); }}>
              {iv.label}
            </button>
          ))}
        </div>

        {/* 重新掃描 */}
        <button onClick={() => runScan(interval, symbolInput, mode)} disabled={loading} style={C.scanBtn}>
          {loading
            ? <span style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                <span style={{ width:12, height:12, border:"2px solid #546e7a", borderTopColor:"#fff",
                  borderRadius:"50%", display:"inline-block", animation:"spin 1s linear infinite" }}/>
                掃描中…
              </span>
            : "🔄 重新掃描"}
        </button>

        {/* 統計 */}
        {results.length > 0 && !loading && (
          <div style={{ background:"#060810", borderRadius:8, padding:"12px 14px",
            border:"1px solid #0f1629", fontSize:11 }}>
            <div style={C.sideLabel}>本次掃描統計</div>
            {[
              ["掃描幣種", scannedCount],
              ["有效結果", results.length],
              ["強訊號 ≥65", strong],
              ["多頭排列", fanCount],
            ].map(([k, v]) => (
              <div key={k} style={{ display:"flex", justifyContent:"space-between",
                color:"#455a64", marginBottom:5 }}>
                <span>{k}</span>
                <span style={{ color:"#7986cb", fontWeight:700 }}>{v}</span>
              </div>
            ))}
            <div style={{ color:"#263238", fontSize:10, marginTop:6 }}>上次 {lastScan}</div>
          </div>
        )}

        {/* Status */}
        {(statusMsg || error) && (
          <div style={{ fontSize:10, lineHeight:1.6, borderRadius:6, padding:"8px 10px",
            background: error?"#1a0a0a":"#060c1a",
            border:`1px solid ${error?"#c62828":"#1a2035"}`,
            color: error?"#ef9a9a":"#546e7a" }}>
            {error ? `⚠️ ${error}` : statusMsg}
          </div>
        )}

        <div style={{ fontSize:9, color:"#111827", marginTop:"auto" }}>
          BREAKOUT SCANNER · Render Backend
        </div>
      </div>

      {/* ── 主內容區 ── */}
      <div style={C.main}>
        {/* 頂部工具列 */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          marginBottom:16, flexWrap:"wrap", gap:8 }}>
          <div style={{ display:"flex", gap:6 }}>
            {[["all","全部"],["strong","強訊號 ≥65"],["above","站上三均線"],["fan","多頭排列"]].map(([v,l]) => (
              <button key={v} onClick={() => setFilter(v)} style={C.filterBtn(filter===v)}>{l}</button>
            ))}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:11, color:"#263238" }}>排序：</span>
            {[["score","評分"],["grade","等級"],["symbol","名稱"]].map(([k,l]) => (
              <button key={k} onClick={() => setSortKey(k)} style={C.filterBtn(sortKey===k)}>{l}</button>
            ))}
            <span style={{ fontSize:11, color:"#263238", marginLeft:8 }}>
              顯示 <span style={{ color:"#7986cb" }}>{filtered.length}</span> / {results.length}
            </span>
          </div>
        </div>

        {/* 表頭 */}
        {filtered.length > 0 && (
          <div style={{ display:"grid",
            gridTemplateColumns:"36px 48px 1fr 90px 90px 90px 90px 80px 60px",
            gap:"0 12px", padding:"0 12px 8px", fontSize:9, color:"#263238",
            letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #0f1629", marginBottom:8 }}>
            <span>#</span><span>分數</span><span>幣種</span>
            <span>現價</span><span>MA30</span><span>MA45</span><span>MA60</span>
            <span>訊號</span><span></span>
          </div>
        )}

        {/* Loading */}
        {loading && results.length === 0 && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
            justifyContent:"center", height:"60vh", gap:16 }}>
            <div style={{ width:40, height:40, border:"3px solid #1a2035",
              borderTopColor:"#7986cb", borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
            <div style={{ color:"#37474f", fontSize:13 }}>{statusMsg || "連線中…"}</div>
          </div>
        )}

        {/* 結果卡片（電腦版寬欄表格式） */}
        {filtered.map((r, idx) => (
          <div key={r.symbol} style={C.card(r.score, expanded===r.symbol)}>
            {/* 主列 */}
            <div style={{ display:"grid",
              gridTemplateColumns:"36px 48px 1fr 90px 90px 90px 90px 80px 60px",
              gap:"0 12px", padding:"10px 12px", alignItems:"center",
              cursor:"pointer" }}
              onClick={() => setExpanded(expanded===r.symbol ? null : r.symbol)}>

              {/* # */}
              <span style={{ color:"#1e293b", fontSize:10 }}>#{idx+1}</span>

              {/* Score ring */}
              <div style={{ position:"relative", width:44, height:44 }}>
                <svg width="44" height="44" style={{ transform:"rotate(-90deg)" }}>
                  <circle cx="22" cy="22" r="16" fill="none" stroke="#111827" strokeWidth="3.5"/>
                  <circle cx="22" cy="22" r="16" fill="none" stroke={r.gradeColor} strokeWidth="3.5"
                    strokeDasharray={`${(r.score/100)*100.5} 100.5`} strokeLinecap="round"/>
                </svg>
                <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:11, fontWeight:800, color:r.gradeColor }}>
                  {r.score}
                </div>
              </div>

              {/* Symbol + badges */}
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                  <span style={{ fontSize:14, fontWeight:700, color:"#e8eaf6" }}>
                    {r.symbol.replace("USDT","")}
                  </span>
                  <span style={{ fontSize:9, color:"#263238" }}>/USDT.PERP</span>
                  <span style={{ fontSize:9, color:r.gradeColor, background:`${r.gradeColor}18`,
                    padding:"1px 6px", borderRadius:3 }}>{r.grade}</span>
                  {r.maFan && <span style={{ fontSize:9, color:"#4dd0e1", background:"#00695c18",
                    padding:"1px 6px", borderRadius:3 }}>多頭排列</span>}
                </div>
              </div>

              {/* Price & MAs */}
              {[
                [r.price,  "#90a4ae"],
                [r.ma30,   "#7986cb"],
                [r.ma45,   "#9575cd"],
                [r.ma60,   "#26c6da"],
              ].map(([val, col], i) => (
                <span key={i} style={{ fontSize:11, color:col, fontVariantNumeric:"tabular-nums" }}>{val}</span>
              ))}

              {/* Signal dots */}
              <div style={{ display:"flex", gap:3, alignItems:"center" }}>
                {r.signals.map(s => (
                  <div key={s.key} title={s.label} style={{ width:8, height:8, borderRadius:"50%",
                    background: s.ok===true?"#00897b":s.ok==="warn"?"#ff9500":"#1e293b",
                    cursor:"help" }} />
                ))}
              </div>

              <span style={{ color:"#263238", fontSize:11, textAlign:"right" }}>
                {expanded===r.symbol?"▲":"▼"}
              </span>
            </div>

            {/* 展開詳情 */}
            {expanded === r.symbol && (
              <div style={{ borderTop:"1px solid #0f1629", padding:"16px 20px",
                display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
                {/* 左：指標明細 */}
                <div>
                  <div style={{ fontSize:9, color:"#3d5afe", letterSpacing:2, marginBottom:10 }}>SIGNAL DETAIL</div>
                  {r.signals.map(s => (
                    <div key={s.key} style={{ display:"flex", gap:10, marginBottom:10, alignItems:"flex-start" }}>
                      <span>{okIcon(s.ok)}</span>
                      <div>
                        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:2 }}>
                          <span style={{ fontSize:11, fontWeight:700,
                            color: s.ok===true?"#4dd0e1":s.ok==="warn"?"#ffb74d":"#455a64" }}>
                            {s.label}
                          </span>
                          <span style={{ fontSize:9, color:"#263238" }}>{s.score ?? 0}/{s.weight}pt</span>
                        </div>
                        <div style={{ fontSize:11, color:"#546e7a", lineHeight:1.6 }}>{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 右：評分長條 + 合約數據 */}
                <div>
                  {/* Score bar */}
                  <div style={{ marginBottom:16 }}>
                    <div style={{ display:"flex", justifyContent:"space-between",
                      fontSize:10, color:"#37474f", marginBottom:6 }}>
                      <span>綜合評分</span>
                      <span style={{ color:r.gradeColor, fontWeight:700, fontSize:14 }}>{r.score}/100</span>
                    </div>
                    <div style={{ height:6, background:"#111827", borderRadius:4 }}>
                      <div style={{ width:`${r.score}%`, height:"100%",
                        background:`linear-gradient(90deg,#283593,${r.gradeColor})`,
                        borderRadius:4, transition:"width .6s ease" }} />
                    </div>
                  </div>

                  {/* Futures extras */}
                  {r.extras?.length > 0 && (
                    <>
                      <div style={{ fontSize:9, color:"#3d5afe", letterSpacing:2, marginBottom:8 }}>FUTURES DATA</div>
                      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                        {r.extras.map(ex => (
                          <div key={ex.label} style={{ background:"#060810", borderRadius:6,
                            padding:"8px 14px", border:`1px solid ${ex.color}33`, minWidth:100 }}>
                            <div style={{ fontSize:9, color:"#455a64", marginBottom:3 }}>{ex.label}</div>
                            <div style={{ fontSize:14, fontWeight:700, color:ex.color }}>{ex.value}</div>
                            <div style={{ fontSize:9, color:"#37474f", marginTop:3 }}>{ex.note}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  <div style={{ marginTop:14, fontSize:9, color:"#1e293b" }}>
                    ⚠️ 技術指標僅供參考，不構成投資建議，合約交易風險極高。
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {!loading && results.length > 0 && filtered.length === 0 && (
          <div style={{ textAlign:"center", color:"#263238", marginTop:60, fontSize:13 }}>
            沒有符合篩選條件的標的
          </div>
        )}
      </div>
    </div>
  );
}
