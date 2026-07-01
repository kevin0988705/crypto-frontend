import { useState, useEffect, useRef } from "react";

// ── 直接打幣安合約 API（瀏覽器端，無需後端）─────────────────────────────────
const FAPI = "https://fapi.binance.com";

const INTERVALS = [
  { label: "15分鐘", value: "15m" },
  { label: "1小時",  value: "1h"  },
  { label: "4小時",  value: "4h"  },
  { label: "日線",   value: "1d"  },
];

// ── 指標計算 ──────────────────────────────────────────────────────────────────
function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function bollingerWidth(closes, n = 20) {
  if (closes.length < n) return null;
  const sl = closes.slice(-n);
  const m  = sl.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return m ? (4 * sd) / m : null;
}
function rsiCalc(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  return 100 - 100 / (1 + g / (l || 0.0001));
}
function volumeShrink(vols, n = 10) {
  if (vols.length < n + 1) return null;
  const avg = vols.slice(-n - 1, -1).reduce((a, b) => a + b, 0) / n;
  return avg ? (avg - vols[vols.length - 1]) / avg : null;
}
function priceRange(candles, n = 10) {
  if (candles.length < n) return null;
  const sl = candles.slice(-n);
  const hi = Math.max(...sl.map(c => c.h));
  const lo = Math.min(...sl.map(c => c.l));
  return lo ? (hi - lo) / lo : null;
}

// ── 分析單一幣種 ──────────────────────────────────────────────────────────────
async function analyseSymbol(symbol, interval) {
  const [klRes, frRes, oiRes] = await Promise.allSettled([
    fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=120`).then(r => r.json()),
    fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`).then(r => r.json()),
    fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.json()),
  ]);

  if (klRes.status !== "fulfilled" || !Array.isArray(klRes.value) || klRes.value.length < 65) return null;
  const klines = klRes.value;

  const candles = klines.map(k => ({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
  const closes  = candles.map(c => c.c);
  const vols    = candles.map(c => c.v);
  const last    = closes[closes.length - 1];

  const ma30 = sma(closes, 30), ma45 = sma(closes, 45), ma60 = sma(closes, 60);
  if (!ma30 || !ma45 || !ma60) return null;

  const aboveAll = last > ma30 && last > ma45 && last > ma60;
  const maFan    = ma30 > ma45 && ma45 > ma60;
  const shrink   = volumeShrink(vols, 10);
  const bw       = bollingerWidth(closes, 20);
  const rsi      = rsiCalc(closes, 14);
  const pr       = priceRange(candles, 10);

  let score = 0;
  const signals = [];

  // 1. 均線 30pt
  if (aboveAll) { score += 30; signals.push({ key:"ma", label:"均線排列", weight:30, score:30, ok:true, detail:`站上MA30/45/60${maFan?"，多頭排列✨":""}` }); }
  else          { signals.push({ key:"ma", label:"均線排列", weight:30, score:0,  ok:false, detail:`MA30=${ma30.toFixed(4)} MA45=${ma45.toFixed(4)} MA60=${ma60.toFixed(4)}` }); }

  // 2. 縮量 20pt
  if (shrink != null) {
    const p = (shrink * 100).toFixed(1);
    if (shrink > 0.25)     { score += 20; signals.push({ key:"vol", label:"成交量萎縮", weight:20, score:20, ok:true,   detail:`量縮 ${p}%，儲能中` }); }
    else if (shrink > 0.1) { score += 10; signals.push({ key:"vol", label:"成交量萎縮", weight:20, score:10, ok:"warn", detail:`量略縮 ${p}%` }); }
    else                   {              signals.push({ key:"vol", label:"成交量萎縮", weight:20, score:0,  ok:false,  detail:`無明顯萎縮（${p}%）` }); }
  }

  // 3. BB 收窄 20pt
  if (bw != null) {
    const p = (bw * 100).toFixed(2);
    if (bw < 0.04)     { score += 20; signals.push({ key:"bb", label:"布林帶極度收窄", weight:20, score:20, ok:true,   detail:`帶寬 ${p}%（Squeeze）` }); }
    else if (bw < 0.07){ score += 10; signals.push({ key:"bb", label:"布林帶收窄",     weight:20, score:10, ok:"warn", detail:`帶寬 ${p}%（收窄中）` }); }
    else               {              signals.push({ key:"bb", label:"布林帶收窄",     weight:20, score:0,  ok:false,  detail:`帶寬 ${p}%（尚未收窄）` }); }
  }

  // 4. RSI 15pt
  if (rsi != null) {
    const r = rsi.toFixed(1);
    if (rsi >= 45 && rsi <= 62)   { score += 15; signals.push({ key:"rsi", label:"RSI蓄力區", weight:15, score:15, ok:true,   detail:`RSI ${r}（45–62 蓄勢）` }); }
    else if (rsi > 62 && rsi < 70){ score += 8;  signals.push({ key:"rsi", label:"RSI偏強",   weight:15, score:8,  ok:"warn", detail:`RSI ${r}（偏強注意超買）` }); }
    else                          {              signals.push({ key:"rsi", label:"RSI蓄力區", weight:15, score:0,  ok:false,  detail:`RSI ${r}（不在蓄力區）` }); }
  }

  // 5. 橫盤 15pt
  if (pr != null) {
    const p = (pr * 100).toFixed(2);
    if (pr < 0.04)     { score += 15; signals.push({ key:"range", label:"價格橫盤壓縮", weight:15, score:15, ok:true,   detail:`10日幅 ${p}%（橫盤明顯）` }); }
    else if (pr < 0.07){ score += 8;  signals.push({ key:"range", label:"價格橫盤壓縮", weight:15, score:8,  ok:"warn", detail:`10日幅 ${p}%（輕微）` }); }
    else               {              signals.push({ key:"range", label:"價格橫盤壓縮", weight:15, score:0,  ok:false,  detail:`10日幅 ${p}%（波動大）` }); }
  }

  // 合約額外數據
  const extras = [];
  try {
    if (frRes.status === "fulfilled" && Array.isArray(frRes.value) && frRes.value[0]) {
      const fr = parseFloat(frRes.value[0].fundingRate) * 100;
      const note = fr > 0.01 ? "正費率（多方付費，偏熱）" : fr < -0.01 ? "負費率（潛在軋空）" : "費率中性";
      const col  = fr > 0.05 ? "#ef5350" : fr < -0.01 ? "#ff9500" : "#4dd0e1";
      extras.push({ label:"資金費率", value:`${fr.toFixed(4)}%`, note, color:col });
    }
  } catch (_) {}
  try {
    if (oiRes.status === "fulfilled" && oiRes.value?.openInterest) {
      const oi = parseFloat(oiRes.value.openInterest);
      extras.push({ label:"未平倉量", value: oi > 1e9 ? `${(oi/1e9).toFixed(2)}B` : `${(oi/1e6).toFixed(1)}M`, note:"USDT計價", color:"#9fa8da" });
    }
  } catch (_) {}

  const gradeColor = score >= 85 ? "#ff4d4d" : score >= 65 ? "#ff9500" : score >= 45 ? "#f5c518" : "#455a64";
  const grade      = score >= 85 ? "🔥 極強訊號" : score >= 65 ? "⚡ 強訊號" : score >= 45 ? "👀 留意觀察" : "😴 無明顯";

  return { symbol, score, grade, gradeColor, price:last.toFixed(4),
    ma30:ma30.toFixed(4), ma45:ma45.toFixed(4), ma60:ma60.toFixed(4),
    aboveAll, maFan, signals, extras };
}

// ── 取得前N名幣種 ─────────────────────────────────────────────────────────────
async function getTopSymbols(limit = 100) {
  const res  = await fetch(`${FAPI}/fapi/v1/ticker/24hr`);
  const data = await res.json();
  return data
    .filter(d => d.symbol.endsWith("USDT") && !d.symbol.includes("_"))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit)
    .map(d => d.symbol);
}

const GRADE_ORDER = { "🔥 極強訊號":0, "⚡ 強訊號":1, "👀 留意觀察":2, "😴 無明顯":3 };

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [interval,     setIntervalVal]  = useState("4h");
  const [mode,         setMode]         = useState("top100");
  const [customSyms,   setCustomSyms]   = useState("BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT");
  const [showCustom,   setShowCustom]   = useState(false);
  const [results,      setResults]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [progress,     setProgress]     = useState({ done:0, total:0 });
  const [expanded,     setExpanded]     = useState(null);
  const [filter,       setFilter]       = useState("all");
  const [sortKey,      setSortKey]      = useState("score");
  const [lastScan,     setLastScan]     = useState(null);
  const [error,        setError]        = useState(null);
  const abortRef = useRef(false);
  const firstLoad = useRef(true);

  async function runScan(iv = interval, scanMode = mode, syms = customSyms) {
    abortRef.current = false;
    setLoading(true); setError(null); setResults([]);
    try {
      let symList;
      if (scanMode === "top100") {
        setProgress({ done:0, total:0 });
        symList = await getTopSymbols(100);
      } else {
        symList = syms.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
      }
      setProgress({ done:0, total:symList.length });

      // 批次掃描，10個一批避免超量請求
      const out = [];
      const BATCH = 10;
      for (let i = 0; i < symList.length; i += BATCH) {
        if (abortRef.current) break;
        const batch = symList.slice(i, i + BATCH);
        const res   = await Promise.all(batch.map(s => analyseSymbol(s, iv)));
        res.forEach(r => r && out.push(r));
        setProgress({ done: Math.min(i + BATCH, symList.length), total: symList.length });
        setResults([...out].sort((a, b) => b.score - a.score)); // 即時更新
        await new Promise(r => setTimeout(r, 150)); // 防止打爆幣安 API
      }
      setLastScan(new Date().toLocaleTimeString("zh-TW"));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; runScan(); }
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
      if (sortKey === "score")  return b.score - a.score;
      if (sortKey === "grade")  return (GRADE_ORDER[a.grade]??9) - (GRADE_ORDER[b.grade]??9);
      if (sortKey === "symbol") return a.symbol.localeCompare(b.symbol);
      return 0;
    });

  const okIcon = ok => ok === true ? "✅" : ok === "warn" ? "⚠️" : "❌";
  const pct    = progress.total ? Math.round(progress.done / progress.total * 100) : 0;

  const C = {
    sidebar:   { width:220, minWidth:220, background:"#0b0f1c", borderRight:"1px solid #0f1629",
                 height:"100vh", overflowY:"auto", padding:"20px 16px", boxSizing:"border-box",
                 display:"flex", flexDirection:"column", gap:18 },
    main:      { flex:1, overflowY:"auto", height:"100vh", background:"#07090f",
                 padding:"18px 24px", boxSizing:"border-box" },
    sLabel:    { fontSize:9, letterSpacing:3, color:"#1e3a5f", textTransform:"uppercase", marginBottom:8 },
    ivBtn:     (a) => ({ width:"100%", padding:"8px 12px", borderRadius:6, textAlign:"left", marginBottom:4,
                 border:`1px solid ${a?"#3949ab":"#0f1629"}`, background:a?"#1a2040":"transparent",
                 color:a?"#9fa8da":"#37474f", cursor:"pointer", fontSize:12, fontFamily:"inherit" }),
    modeBtn:   (a) => ({ width:"100%", padding:"9px 12px", borderRadius:7, textAlign:"left", marginBottom:4,
                 border:`1px solid ${a?"#00897b":"#0f1629"}`, background:a?"#00695c22":"transparent",
                 color:a?"#4dd0e1":"#37474f", cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }),
    scanBtn:   { width:"100%", padding:"10px", borderRadius:7, border:"none",
                 background:"linear-gradient(135deg,#283593,#00695c)",
                 color:"#fff", cursor:"pointer", fontSize:13, fontWeight:700, fontFamily:"inherit" },
    filterBtn: (a) => ({ padding:"5px 12px", borderRadius:4,
                 border:`1px solid ${a?"#3949ab":"#1a2035"}`, background:a?"#1a2040":"transparent",
                 color:a?"#9fa8da":"#37474f", cursor:"pointer", fontSize:11, fontFamily:"inherit" }),
    card:      (score, open) => ({
                 background:open?"#0f1729":"#0c111e", borderRadius:8, marginBottom:5,
                 cursor:"pointer", overflow:"hidden",
                 border:`1px solid ${score>=85?"#3949ab":score>=65?"#2e3a5e":score>=45?"#1c2d35":"#111827"}`,
                 boxShadow:open?"0 0 0 1px #3949ab44":score>=85?"0 0 16px #3949ab33":"none" }),
  };

  const strong   = results.filter(r => r.score >= 65).length;
  const fanCount = results.filter(r => r.maFan).length;

  return (
    <div style={{ display:"flex", height:"100vh", overflow:"hidden",
      fontFamily:"'SF Mono','Fira Code',ui-monospace,monospace", color:"#dde1f0" }}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#07090f}
        ::-webkit-scrollbar-thumb{background:#1a2035;border-radius:2px}
        *{box-sizing:border-box}
      `}</style>

      {/* ── 左側欄 ── */}
      <div style={C.sidebar}>
        <div>
          <div style={{ fontSize:9, letterSpacing:4, color:"#3d5afe", textTransform:"uppercase", marginBottom:6 }}>FUTURES BREAKOUT</div>
          <div style={{ fontSize:15, fontWeight:800, lineHeight:1.3,
            background:"linear-gradient(90deg,#7986cb,#4dd0e1)",
            WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
            合約橫盤縮量<br/>爆發偵測器
          </div>
          <div style={{ fontSize:9, color:"#263238", marginTop:4 }}>直連幣安合約 · 無需後端</div>
        </div>

        <div>
          <div style={C.sLabel}>掃描模式</div>
          <button style={C.modeBtn(mode==="top100")}
            onClick={() => { setMode("top100"); setShowCustom(false); runScan(interval,"top100",customSyms); }}>
            🏆 交易量前100名
          </button>
          <button style={C.modeBtn(mode==="custom")}
            onClick={() => { setMode("custom"); setShowCustom(true); }}>
            ✏️ 自訂幣種
          </button>
          {showCustom && (
            <div style={{ marginTop:6 }}>
              <textarea value={customSyms} onChange={e => setCustomSyms(e.target.value)}
                placeholder="BTCUSDT,ETHUSDT,..."
                style={{ width:"100%", height:80, background:"#060810", border:"1px solid #1a2035",
                  borderRadius:6, color:"#90a4ae", fontSize:10, padding:"6px 8px", fontFamily:"inherit", resize:"vertical" }}/>
              <button onClick={() => runScan(interval,"custom",customSyms)}
                style={{ ...C.scanBtn, fontSize:11, marginTop:4 }}>套用並掃描</button>
            </div>
          )}
        </div>

        <div>
          <div style={C.sLabel}>時間週期</div>
          {INTERVALS.map(iv => (
            <button key={iv.value} style={C.ivBtn(interval===iv.value)}
              onClick={() => { setIntervalVal(iv.value); runScan(iv.value, mode, customSyms); }}>
              {iv.label}
            </button>
          ))}
        </div>

        <button onClick={() => runScan(interval, mode, customSyms)} disabled={loading} style={C.scanBtn}>
          {loading
            ? <span style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                <span style={{ width:12, height:12, border:"2px solid #546e7a", borderTopColor:"#fff",
                  borderRadius:"50%", display:"inline-block", animation:"spin 1s linear infinite" }}/>
                {progress.total > 0 ? `${progress.done}/${progress.total}` : "準備中…"}
              </span>
            : "🔄 重新掃描"}
        </button>

        {loading && progress.total > 0 && (
          <div>
            <div style={{ height:3, background:"#0f1629", borderRadius:2 }}>
              <div style={{ width:`${pct}%`, height:"100%", borderRadius:2,
                background:"linear-gradient(90deg,#283593,#00897b)", transition:"width .3s" }}/>
            </div>
            <div style={{ fontSize:9, color:"#263238", marginTop:4, textAlign:"center" }}>{pct}%</div>
          </div>
        )}

        {results.length > 0 && !loading && (
          <div style={{ background:"#060810", borderRadius:8, padding:"12px 14px",
            border:"1px solid #0f1629", fontSize:11 }}>
            <div style={C.sLabel}>本次統計</div>
            {[["掃描幣種", progress.total || results.length],["有效結果", results.length],
              ["強訊號≥65", strong],["多頭排列", fanCount]].map(([k,v]) => (
              <div key={k} style={{ display:"flex", justifyContent:"space-between", color:"#455a64", marginBottom:5 }}>
                <span>{k}</span><span style={{ color:"#7986cb", fontWeight:700 }}>{v}</span>
              </div>
            ))}
            <div style={{ color:"#263238", fontSize:9, marginTop:6 }}>上次 {lastScan}</div>
          </div>
        )}

        {error && (
          <div style={{ fontSize:10, lineHeight:1.6, borderRadius:6, padding:"8px 10px",
            background:"#1a0a0a", border:"1px solid #c62828", color:"#ef9a9a" }}>
            ⚠️ {error}
          </div>
        )}

        <div style={{ fontSize:9, color:"#111827", marginTop:"auto" }}>直連幣安合約 API · 瀏覽器端計算</div>
      </div>

      {/* ── 主區 ── */}
      <div style={C.main}>
        {/* 工具列 */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
          marginBottom:14, flexWrap:"wrap", gap:8 }}>
          <div style={{ display:"flex", gap:5 }}>
            {[["all","全部"],["strong","強訊號≥65"],["above","站上三均線"],["fan","多頭排列"]].map(([v,l]) => (
              <button key={v} onClick={() => setFilter(v)} style={C.filterBtn(filter===v)}>{l}</button>
            ))}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:10, color:"#263238" }}>排序</span>
            {[["score","評分"],["grade","等級"],["symbol","名稱"]].map(([k,l]) => (
              <button key={k} onClick={() => setSortKey(k)} style={C.filterBtn(sortKey===k)}>{l}</button>
            ))}
            <span style={{ fontSize:10, color:"#263238", marginLeft:6 }}>
              顯示 <span style={{ color:"#7986cb" }}>{filtered.length}</span>/{results.length}
            </span>
          </div>
        </div>

        {/* 表頭 */}
        {filtered.length > 0 && (
          <div style={{ display:"grid",
            gridTemplateColumns:"32px 46px 1fr 100px 100px 100px 100px 70px 24px",
            gap:"0 10px", padding:"0 10px 8px", fontSize:9, color:"#263238",
            letterSpacing:1, textTransform:"uppercase", borderBottom:"1px solid #0f1629", marginBottom:6 }}>
            <span>#</span><span>分數</span><span>幣種</span>
            <span>現價</span><span>MA30</span><span>MA45</span><span>MA60</span>
            <span>訊號</span><span></span>
          </div>
        )}

        {/* 載入中 */}
        {loading && results.length === 0 && (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
            justifyContent:"center", height:"60vh", gap:16 }}>
            <div style={{ width:44, height:44, border:"3px solid #1a2035",
              borderTopColor:"#7986cb", borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
            <div style={{ color:"#37474f", fontSize:13 }}>
              {progress.total > 0 ? `掃描中 ${progress.done}/${progress.total}…` : "連線幣安中…"}
            </div>
          </div>
        )}

        {/* 結果列表 */}
        {filtered.map((r, idx) => (
          <div key={r.symbol} style={C.card(r.score, expanded===r.symbol)}>
            <div style={{ display:"grid",
              gridTemplateColumns:"32px 46px 1fr 100px 100px 100px 100px 70px 24px",
              gap:"0 10px", padding:"9px 10px", alignItems:"center" }}
              onClick={() => setExpanded(expanded===r.symbol ? null : r.symbol)}>

              <span style={{ color:"#1e293b", fontSize:10 }}>#{idx+1}</span>

              {/* Score ring */}
              <div style={{ position:"relative", width:42, height:42 }}>
                <svg width="42" height="42" style={{ transform:"rotate(-90deg)" }}>
                  <circle cx="21" cy="21" r="15" fill="none" stroke="#111827" strokeWidth="3"/>
                  <circle cx="21" cy="21" r="15" fill="none" stroke={r.gradeColor} strokeWidth="3"
                    strokeDasharray={`${(r.score/100)*94.2} 94.2`} strokeLinecap="round"/>
                </svg>
                <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center",
                  justifyContent:"center", fontSize:11, fontWeight:800, color:r.gradeColor }}>
                  {r.score}
                </div>
              </div>

              {/* Symbol */}
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                  <span style={{ fontSize:13, fontWeight:700, color:"#e8eaf6" }}>{r.symbol.replace("USDT","")}</span>
                  <span style={{ fontSize:8, color:"#263238" }}>/USDT.PERP</span>
                  <span style={{ fontSize:9, color:r.gradeColor, background:`${r.gradeColor}18`, padding:"1px 5px", borderRadius:3 }}>{r.grade}</span>
                  {r.maFan && <span style={{ fontSize:9, color:"#4dd0e1", background:"#00695c18", padding:"1px 5px", borderRadius:3 }}>多頭↑</span>}
                </div>
              </div>

              {[r.price,"#90a4ae"],[r.ma30,"#7986cb"],[r.ma45,"#9575cd"],[r.ma60,"#26c6da"]].map(([v,c],i) => (
                <span key={i} style={{ fontSize:11, color:c, fontVariantNumeric:"tabular-nums" }}>{v}</span>
              ))}

              <div style={{ display:"flex", gap:3 }}>
                {r.signals.map(s => (
                  <div key={s.key} title={s.label} style={{ width:7, height:7, borderRadius:"50%",
                    background:s.ok===true?"#00897b":s.ok==="warn"?"#ff9500":"#1e293b" }}/>
                ))}
              </div>
              <span style={{ color:"#263238", fontSize:11 }}>{expanded===r.symbol?"▲":"▼"}</span>
            </div>

            {/* 展開詳情 */}
            {expanded===r.symbol && (
              <div style={{ borderTop:"1px solid #0f1629", padding:"14px 18px",
                display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
                <div>
                  <div style={{ fontSize:9, color:"#3d5afe", letterSpacing:2, marginBottom:10 }}>SIGNAL DETAIL</div>
                  {r.signals.map(s => (
                    <div key={s.key} style={{ display:"flex", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:13 }}>{okIcon(s.ok)}</span>
                      <div>
                        <div style={{ display:"flex", gap:6, alignItems:"center", marginBottom:2 }}>
                          <span style={{ fontSize:11, fontWeight:700,
                            color:s.ok===true?"#4dd0e1":s.ok==="warn"?"#ffb74d":"#455a64" }}>{s.label}</span>
                          <span style={{ fontSize:9, color:"#263238" }}>{s.score}/{s.weight}pt</span>
                        </div>
                        <div style={{ fontSize:11, color:"#546e7a", lineHeight:1.6 }}>{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ marginBottom:14 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#37474f", marginBottom:5 }}>
                      <span>綜合評分</span>
                      <span style={{ color:r.gradeColor, fontWeight:700, fontSize:14 }}>{r.score}/100</span>
                    </div>
                    <div style={{ height:5, background:"#111827", borderRadius:3 }}>
                      <div style={{ width:`${r.score}%`, height:"100%", borderRadius:3,
                        background:`linear-gradient(90deg,#283593,${r.gradeColor})` }}/>
                    </div>
                  </div>
                  {r.extras?.length > 0 && (
                    <>
                      <div style={{ fontSize:9, color:"#3d5afe", letterSpacing:2, marginBottom:8 }}>FUTURES DATA</div>
                      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                        {r.extras.map(ex => (
                          <div key={ex.label} style={{ background:"#060810", borderRadius:6, padding:"8px 14px",
                            border:`1px solid ${ex.color}33`, minWidth:90 }}>
                            <div style={{ fontSize:9, color:"#455a64", marginBottom:2 }}>{ex.label}</div>
                            <div style={{ fontSize:14, fontWeight:700, color:ex.color }}>{ex.value}</div>
                            <div style={{ fontSize:9, color:"#37474f", marginTop:2 }}>{ex.note}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <div style={{ marginTop:12, fontSize:9, color:"#1e293b" }}>
                    ⚠️ 技術指標僅供參考，不構成投資建議。
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {!loading && results.length > 0 && filtered.length === 0 && (
          <div style={{ textAlign:"center", color:"#263238", marginTop:60, fontSize:12 }}>
            沒有符合篩選條件的標的
          </div>
        )}
      </div>
    </div>
  );
}
