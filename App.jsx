import { useState, useEffect, useRef, useCallback } from "react";

const FAPI   = "https://fapi.binance.com";
const NEWS_API = "https://cryptopanic.com/api/v1/posts/?auth_token=demo&public=true&currencies=";

const INTERVALS = [
  { label:"15分鐘", value:"15m" },
  { label:"1小時",  value:"1h"  },
  { label:"4小時",  value:"4h"  },
  { label:"日線",   value:"1d"  },
];

// ══════════════════════════════════════════════════════════════════
// 指標計算函式
// ══════════════════════════════════════════════════════════════════
const sma = (arr, n) => arr.length < n ? null : arr.slice(-n).reduce((a,b)=>a+b,0)/n;

function ema(arr, n) {
  if (arr.length < n) return null;
  const k = 2/(n+1);
  let e = arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i = n; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}

function bollingerWidth(closes, n=20) {
  if (closes.length < n) return null;
  const sl = closes.slice(-n);
  const m  = sl.reduce((a,b)=>a+b,0)/n;
  const sd = Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return m ? (4*sd)/m : null;
}

function rsiCalc(closes, n=14) {
  if (closes.length < n+1) return null;
  let g=0, l=0;
  for (let i=closes.length-n; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    d>=0 ? g+=d : l-=d;
  }
  return 100-100/(1+g/(l||0.0001));
}

function macdCalc(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  if (!e12 || !e26) return null;
  return e12 - e26; // MACD line (signal line needs more data, simplified)
}

function stochRsi(closes, rsiLen=14, stochLen=14) {
  if (closes.length < rsiLen+stochLen+1) return null;
  const rsiArr = [];
  for (let i=rsiLen; i<=closes.length; i++) {
    const sl = closes.slice(i-rsiLen-1, i);
    let g=0,l=0;
    for (let j=1; j<sl.length; j++) { const d=sl[j]-sl[j-1]; d>=0?g+=d:l-=d; }
    rsiArr.push(100-100/(1+g/(l||0.0001)));
  }
  if (rsiArr.length < stochLen) return null;
  const sl = rsiArr.slice(-stochLen);
  const hi = Math.max(...sl), lo = Math.min(...sl);
  return hi===lo ? 50 : (rsiArr[rsiArr.length-1]-lo)/(hi-lo)*100;
}

function atr(candles, n=14) {
  if (candles.length < n+1) return null;
  const trs = candles.slice(1).map((c,i)=>Math.max(c.h-c.l, Math.abs(c.h-candles[i].c), Math.abs(c.l-candles[i].c)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function calcOBV(candles) {
  let obv=0; const arr=[0];
  for (let i=1; i<candles.length; i++) {
    obv += candles[i].c>candles[i-1].c ? candles[i].v : candles[i].c<candles[i-1].c ? -candles[i].v : 0;
    arr.push(obv);
  }
  return arr;
}

function volRatio(vols, n=5) {
  if (vols.length < n+1) return null;
  const avg = vols.slice(-n-1,-1).reduce((a,b)=>a+b,0)/n;
  return avg ? vols[vols.length-1]/avg : null;
}

function volPriceTrend(candles) {
  const obv     = calcOBV(candles);
  const obvLen  = obv.length;
  const obvS5   = obvLen>=5  ? obv.slice(-5).reduce((a,b)=>a+b,0)/5  : null;
  const obvS20  = obvLen>=20 ? obv.slice(-20).reduce((a,b)=>a+b,0)/20: null;
  const obvUp   = obvS5!=null&&obvS20!=null ? obvS5>obvS20 : null;

  const vols   = candles.map(c=>c.v);
  const closes = candles.map(c=>c.c);
  const vr     = volRatio(vols, 5);
  const slope  = closes.length>=20 ? (closes[closes.length-1]-closes[closes.length-20])/closes[closes.length-20] : 0;

  let bull=0, bear=0;
  const reasons=[];

  // OBV
  if (obvUp===true)  { bull+=3; reasons.push({type:"bull",text:"OBV上升，資金持續淨流入"}); }
  if (obvUp===false) { bear+=3; reasons.push({type:"bear",text:"OBV下降，資金持續流出"}); }

  // 近5根量價
  const r5 = candles.slice(-5);
  let puvd=0, puvu=0, pdvd=0, pdvu=0;
  for (let i=1;i<r5.length;i++) {
    const pu=r5[i].c>r5[i-1].c, vu=r5[i].v>r5[i-1].v;
    if(pu&&vu) puvu++; else if(pu&&!vu) puvd++; else if(!pu&&vu) pdvu++; else pdvd++;
  }
  if(puvu>=2){bull+=2;reasons.push({type:"bull",text:`${puvu}根價漲量增，多頭動能確認`});}
  if(pdvd>=2){bull+=1;reasons.push({type:"bull",text:`下跌量縮（${pdvd}根），賣壓不重`});}
  if(puvd>=2){bear+=2;reasons.push({type:"bear",text:`${puvd}根價漲量縮，動能不足易假突破`});}
  if(pdvu>=2){bear+=2;reasons.push({type:"bear",text:`${pdvu}根下跌放量，恐慌賣壓重`});}

  // 量比
  if(vr!=null){
    const vrs=(vr).toFixed(1);
    if(vr>2&&slope>0){bull+=2;reasons.push({type:"bull",text:`量比${vrs}x 放量上攻`});}
    else if(vr>2&&slope<0){bear+=2;reasons.push({type:"bear",text:`量比${vrs}x 放量下跌`});}
    else if(vr<0.5){reasons.push({type:"neutral",text:`量比${vrs}x 極度萎縮等方向`});}
  }

  if(slope>0.03){bull+=1;reasons.push({type:"bull",text:`近20根漲幅${(slope*100).toFixed(1)}%`});}
  else if(slope<-0.03){bear+=1;reasons.push({type:"bear",text:`近20根跌幅${(Math.abs(slope)*100).toFixed(1)}%`});}

  const verdict =
    bull>bear+2?"偏多":bear>bull+2?"偏空":bull>bear?"略偏多":bear>bull?"略偏空":"中性觀望";
  const verdictColor =
    verdict==="偏多"?"#4caf50":verdict==="偏空"?"#ef5350":
    verdict==="略偏多"?"#8bc34a":verdict==="略偏空"?"#ff7043":"#90a4ae";
  const verdictBg = verdict.includes("多")?"#1b5e2022":verdict.includes("空")?"#b71c1c22":"#1a2035";
  const verdictIcon = verdict==="偏多"?"▲":verdict==="偏空"?"▼":verdict==="略偏多"?"△":verdict==="略偏空"?"▽":"◆";

  return { verdict,verdictColor,verdictBg,verdictIcon,bullScore:bull,bearScore:bear,
    obvTrend:obvUp===true?"up":obvUp===false?"down":null,
    volRatioVal:vr?.toFixed(2), reasons };
}

// ══════════════════════════════════════════════════════════════════
// 10 項評分引擎
// ══════════════════════════════════════════════════════════════════
function scoreSymbol(candles, ma30, ma45, ma60) {
  const closes = candles.map(c=>c.c);
  const vols   = candles.map(c=>c.v);
  const last   = closes[closes.length-1];
  const aboveAll = last>ma30 && last>ma45 && last>ma60;
  const maFan    = ma30>ma45 && ma45>ma60;

  let score=0;
  const signals=[];

  // 1. 均線排列 20pt
  if(aboveAll){ score+=20; signals.push({key:"ma",label:"①均線排列",w:20,s:20,ok:true,detail:`站上MA30/45/60${maFan?"，三線多頭排列✨":""}`}); }
  else        { signals.push({key:"ma",label:"①均線排列",w:20,s:0,ok:false,detail:`未完全站上三均線`}); }

  // 2. 成交量萎縮 12pt
  const vols10avg = vols.slice(-11,-1).reduce((a,b)=>a+b,0)/10;
  const shrinkPct = vols10avg ? (vols10avg-vols[vols.length-1])/vols10avg : 0;
  const sp = (shrinkPct*100).toFixed(1);
  if(shrinkPct>0.25)     {score+=12;signals.push({key:"vol",label:"②成交量萎縮",w:12,s:12,ok:true,  detail:`量縮${sp}%，橫盤儲能`});}
  else if(shrinkPct>0.1) {score+=6; signals.push({key:"vol",label:"②成交量萎縮",w:12,s:6, ok:"warn",detail:`量略縮${sp}%`});}
  else                   {          signals.push({key:"vol",label:"②成交量萎縮",w:12,s:0, ok:false, detail:`量無明顯萎縮（${sp}%）`});}

  // 3. 布林帶收窄 12pt
  const bw = bollingerWidth(closes,20);
  if(bw!=null){
    const bp=(bw*100).toFixed(2);
    if(bw<0.04)     {score+=12;signals.push({key:"bb",label:"③布林帶Squeeze",w:12,s:12,ok:true,  detail:`帶寬${bp}%（極度壓縮）`});}
    else if(bw<0.07){score+=6; signals.push({key:"bb",label:"③布林帶收窄",   w:12,s:6, ok:"warn",detail:`帶寬${bp}%（收窄中）`});}
    else            {          signals.push({key:"bb",label:"③布林帶收窄",   w:12,s:0, ok:false, detail:`帶寬${bp}%（尚未收窄）`});}
  }

  // 4. RSI 蓄力 10pt
  const rsi = rsiCalc(closes,14);
  if(rsi!=null){
    const r=rsi.toFixed(1);
    if(rsi>=45&&rsi<=62)   {score+=10;signals.push({key:"rsi",label:"④RSI蓄力區",w:10,s:10,ok:true,  detail:`RSI${r}（45–62蓄勢）`});}
    else if(rsi>62&&rsi<70){score+=5; signals.push({key:"rsi",label:"④RSI偏強",  w:10,s:5, ok:"warn",detail:`RSI${r}（偏強注意超買）`});}
    else if(rsi>30&&rsi<45){score+=4; signals.push({key:"rsi",label:"④RSI偏弱",  w:10,s:4, ok:"warn",detail:`RSI${r}（偏弱待回升）`});}
    else                   {          signals.push({key:"rsi",label:"④RSI蓄力區",w:10,s:0, ok:false, detail:`RSI${r}（不在蓄力區）`});}
  }

  // 5. 橫盤壓縮 10pt
  const sl10 = candles.slice(-10);
  const hi10=Math.max(...sl10.map(c=>c.h)), lo10=Math.min(...sl10.map(c=>c.l));
  const prPct = lo10 ? (hi10-lo10)/lo10 : 1;
  const pp=(prPct*100).toFixed(2);
  if(prPct<0.04)     {score+=10;signals.push({key:"range",label:"⑤價格橫盤",w:10,s:10,ok:true,  detail:`10日高低幅${pp}%（橫盤明顯）`});}
  else if(prPct<0.07){score+=5; signals.push({key:"range",label:"⑤價格橫盤",w:10,s:5, ok:"warn",detail:`高低幅${pp}%（輕微橫盤）`});}
  else               {          signals.push({key:"range",label:"⑤價格橫盤",w:10,s:0, ok:false, detail:`高低幅${pp}%（波動大）`});}

  // 6. MACD 金叉 / 趨勢 8pt
  const macdVal = macdCalc(closes);
  const macdPrev = macdCalc(closes.slice(0,-1));
  if(macdVal!=null){
    if(macdVal>0&&macdPrev!=null&&macdPrev<0){score+=8;signals.push({key:"macd",label:"⑥MACD金叉",w:8,s:8,ok:true,  detail:`MACD剛穿越零軸，動能轉多`});}
    else if(macdVal>0)                       {score+=5;signals.push({key:"macd",label:"⑥MACD偏多",w:8,s:5,ok:"warn",detail:`MACD在零軸上方（${macdVal.toFixed(4)}）`});}
    else if(macdVal<0&&macdPrev!=null&&macdPrev>0){     signals.push({key:"macd",label:"⑥MACD死叉",w:8,s:0,ok:false,detail:`MACD剛穿越零軸向下`});}
    else                                     {          signals.push({key:"macd",label:"⑥MACD偏空",w:8,s:0,ok:false,detail:`MACD在零軸下方（${macdVal.toFixed(4)}）`});}
  }

  // 7. Stoch RSI 8pt
  const stoch = stochRsi(closes);
  if(stoch!=null){
    const s=stoch.toFixed(1);
    if(stoch<20)       {score+=8;signals.push({key:"stoch",label:"⑦StochRSI超賣",w:8,s:8,ok:true,  detail:`StochRSI${s}（<20超賣，反彈機率高）`});}
    else if(stoch<40)  {score+=5;signals.push({key:"stoch",label:"⑦StochRSI偏低",w:8,s:5,ok:"warn",detail:`StochRSI${s}（蓄力偏低位）`});}
    else if(stoch>80)  {          signals.push({key:"stoch",label:"⑦StochRSI超買",w:8,s:0,ok:false, detail:`StochRSI${s}（>80超買，注意回調）`});}
    else               {score+=3;signals.push({key:"stoch",label:"⑦StochRSI中性",w:8,s:3,ok:"warn",detail:`StochRSI${s}（中性區間）`});}
  }

  // 8. ATR 波動率收縮 8pt
  const atrNow = atr(candles,14);
  const atrPast = atr({...candles, length:candles.length-5, slice:(s,e)=>candles.slice(s,e)}, 14);
  // simplified: compare recent ATR to older ATR
  const atrOld = candles.length>=30 ? atr(candles.slice(0,-10),14) : null;
  if(atrNow!=null && last>0){
    const atrPct=(atrNow/last*100).toFixed(2);
    if(atrNow/last<0.02)     {score+=8;signals.push({key:"atr",label:"⑧ATR極低",    w:8,s:8,ok:true,  detail:`ATR/價格=${atrPct}%（波動極小，蓄爆前兆）`});}
    else if(atrNow/last<0.04){score+=4;signals.push({key:"atr",label:"⑧ATR收縮中",  w:8,s:4,ok:"warn",detail:`ATR/價格=${atrPct}%（波動收縮中）`});}
    else                     {          signals.push({key:"atr",label:"⑧ATR偏高",    w:8,s:0,ok:false, detail:`ATR/價格=${atrPct}%（波動仍大）`});}
  }

  // 9. EMA 黃金交叉趨勢 6pt
  const ema9  = ema(closes,9);
  const ema21 = ema(closes,21);
  const ema9p  = ema(closes.slice(0,-1),9);
  const ema21p = ema(closes.slice(0,-1),21);
  if(ema9!=null&&ema21!=null){
    if(ema9>ema21&&ema9p!=null&&ema9p<=ema21p){score+=6;signals.push({key:"ema",label:"⑨EMA金叉",  w:6,s:6,ok:true,  detail:`EMA9剛穿越EMA21，短期轉多`});}
    else if(ema9>ema21)                        {score+=4;signals.push({key:"ema",label:"⑨EMA多頭",  w:6,s:4,ok:"warn",detail:`EMA9在EMA21之上，短期偏多`});}
    else if(ema9<ema21&&ema9p!=null&&ema9p>=ema21p){      signals.push({key:"ema",label:"⑨EMA死叉",  w:6,s:0,ok:false, detail:`EMA9剛穿越EMA21向下`});}
    else                                       {          signals.push({key:"ema",label:"⑨EMA空頭",  w:6,s:0,ok:false, detail:`EMA9在EMA21之下，短期偏空`});}
  }

  // 10. OBV 趨勢 6pt
  const obvArr = calcOBV(candles);
  const obvS5  = obvArr.slice(-5).reduce((a,b)=>a+b,0)/5;
  const obvS20 = obvArr.slice(-20).reduce((a,b)=>a+b,0)/20;
  if(obvS5>obvS20*1.02){score+=6;signals.push({key:"obv",label:"⑩OBV上升",w:6,s:6,ok:true,  detail:`OBV5均高於20均，資金淨流入`});}
  else if(obvS5>obvS20){score+=3;signals.push({key:"obv",label:"⑩OBV略升",w:6,s:3,ok:"warn",detail:`OBV小幅淨流入`});}
  else                 {          signals.push({key:"obv",label:"⑩OBV下降",w:6,s:0,ok:false, detail:`OBV5均低於20均，資金流出`});}

  // 進場訊號判斷（高分 + 偏多 + 關鍵條件齊備）
  const isEntry = score>=70 && aboveAll && (shrinkPct>0.1) && (bw!=null&&bw<0.07) && (rsi!=null&&rsi>=40&&rsi<=65);

  return { score, signals, aboveAll, maFan, isEntry, atrNow, ma30, ma45, ma60,
    rsi, shrinkPct, bw, candles };
}

// ══════════════════════════════════════════════════════════════════
// 進場點位 / 止盈 / 止損 計算
// ══════════════════════════════════════════════════════════════════
function calcTradeSetup(candles, last, atrNow, ma30, ma45, ma60, score, vpt) {
  if(!atrNow || !last) return null;

  // ── 支撐阻力：近30根K棒樞紐 ──────────────────────────────
  const recent = candles.slice(-30);
  const highs  = recent.map(c=>c.h);
  const lows   = recent.map(c=>c.l);
  const pivotHi = Math.max(...highs);   // 近期阻力
  const pivotLo = Math.min(...lows);    // 近期支撐
  const recentLo5 = Math.min(...candles.slice(-5).map(c=>c.l)); // 5根最低（止損參考）

  // ── 動態信心係數（依評分調整止盈倍數）──────────────────
  const confidence = score>=85?3.0:score>=70?2.0:1.5;

  // ── 進場點 ────────────────────────────────────────────────
  // 理想進場：當前價格（市價）或略高於MA30確認
  const entryIdeal  = last;                           // 市價進場
  const entryLimit  = Math.max(ma30, last*0.998);     // 限價：稍低一點等回踩

  // ── 止損（SL）────────────────────────────────────────────
  // 方法1：近5根最低 - 0.5*ATR
  const sl_candles = recentLo5 - atrNow * 0.5;
  // 方法2：MA45 - ATR（均線保護）
  const sl_ma      = ma45 - atrNow * 0.8;
  // 取較高者（較緊，控制虧損）
  const stopLoss   = Math.max(sl_candles, sl_ma, last * 0.97); // 最多跌3%

  // ── 止盈（TP）────────────────────────────────────────────
  const risk       = entryIdeal - stopLoss;           // 每單風險
  const rr         = confidence;                      // 風報比
  const tp1        = entryIdeal + risk * 1.5;         // TP1：1.5R（保守）
  const tp2        = entryIdeal + risk * rr;          // TP2：信心倍數
  const tp3        = Math.min(pivotHi * 1.002, entryIdeal + risk * (rr+1.5)); // TP3：接近阻力

  // ── 百分比計算 ────────────────────────────────────────────
  const slPct  = ((stopLoss - entryIdeal) / entryIdeal * 100).toFixed(2);
  const tp1Pct = ((tp1 - entryIdeal) / entryIdeal * 100).toFixed(2);
  const tp2Pct = ((tp2 - entryIdeal) / entryIdeal * 100).toFixed(2);
  const tp3Pct = ((tp3 - entryIdeal) / entryIdeal * 100).toFixed(2);

  // ── 倉位建議 ─────────────────────────────────────────────
  // 以帳戶1%風險為基準
  const riskPerUnit = entryIdeal - stopLoss;
  const positionPct = score>=85?"5–8%（強訊號可適當加大）":score>=70?"3–5%":"1–3%（觀察倉）";

  // ── 策略描述 ──────────────────────────────────────────────
  const strategy =
    score>=85 ? "突破追多（強勢蓄發，可積極進場）" :
    score>=70 ? "回踩做多（等待回踩MA30確認後進場）" :
                "輕倉試多（訊號不完整，僅小倉觀察）";

  const fmt = n => {
    if(n>=1000) return n.toFixed(2);
    if(n>=10)   return n.toFixed(3);
    if(n>=1)    return n.toFixed(4);
    return n.toFixed(6);
  };

  return {
    strategy,
    entryIdeal: fmt(entryIdeal),
    entryLimit: fmt(entryLimit),
    stopLoss:   fmt(stopLoss),
    tp1: fmt(tp1), tp1Pct,
    tp2: fmt(tp2), tp2Pct,
    tp3: fmt(tp3), tp3Pct,
    slPct,
    rr: rr.toFixed(1),
    positionPct,
    pivotHi: fmt(pivotHi),
    pivotLo: fmt(pivotLo),
    confidence,
  };
}

// ══════════════════════════════════════════════════════════════════
// 即時新聞抓取
// ══════════════════════════════════════════════════════════════════
async function fetchNews(symbol) {
  const coin = symbol.replace("USDT","").toLowerCase();
  try {
    // 用 Claude API 搜尋最新消息
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"claude-sonnet-4-6",
        max_tokens:500,
        tools:[{type:"web_search_20250305",name:"web_search"}],
        messages:[{role:"user",content:`搜尋 ${symbol} 最新24小時內的加密貨幣新聞或重要消息，用繁體中文簡短列出最多3條，每條一句話，格式：["消息1","消息2","消息3"]，只回傳JSON陣列`}]
      })
    });
    const data = await res.json();
    const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("") || "[]";
    const clean = text.replace(/```json|```/g,"").trim();
    const arr = JSON.parse(clean);
    return Array.isArray(arr) ? arr.slice(0,3) : [];
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
// 分析單一幣種
// ══════════════════════════════════════════════════════════════════
async function analyseSymbol(symbol, interval) {
  const [klRes, frRes, oiRes] = await Promise.allSettled([
    fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=120`).then(r=>r.json()),
    fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`).then(r=>r.json()),
    fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`).then(r=>r.json()),
  ]);

  if(klRes.status!=="fulfilled"||!Array.isArray(klRes.value)||klRes.value.length<65) return null;

  const candles = klRes.value.map(k=>({o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
  const closes  = candles.map(c=>c.c);
  const vols    = candles.map(c=>c.v);
  const last    = closes[closes.length-1];

  const ma30 = sma(closes,30), ma45=sma(closes,45), ma60=sma(closes,60);
  if(!ma30||!ma45||!ma60) return null;

  const { score, signals, aboveAll, maFan, isEntry, atrNow } = scoreSymbol(candles,ma30,ma45,ma60);
  const vpt   = volPriceTrend(candles);
  const trade = isEntry ? calcTradeSetup(candles, last, atrNow, ma30, ma45, ma60, score, vpt) : null;

  const extras=[];
  try {
    if(frRes.status==="fulfilled"&&Array.isArray(frRes.value)&&frRes.value[0]){
      const fr=parseFloat(frRes.value[0].fundingRate)*100;
      extras.push({label:"資金費率",value:`${fr.toFixed(4)}%`,
        note:fr>0.01?"正費率（偏熱）":fr<-0.01?"負費率（潛在軋空）":"中性",
        color:fr>0.05?"#ef5350":fr<-0.01?"#ff9500":"#4dd0e1"});
    }
  } catch(_){}
  try {
    if(oiRes.status==="fulfilled"&&oiRes.value?.openInterest){
      const oi=parseFloat(oiRes.value.openInterest);
      extras.push({label:"未平倉量",value:oi>1e9?`${(oi/1e9).toFixed(2)}B`:`${(oi/1e6).toFixed(1)}M`,note:"USDT計價",color:"#9fa8da"});
    }
  } catch(_){}

  const gradeColor = score>=85?"#ff4d4d":score>=70?"#ff9500":score>=50?"#f5c518":"#455a64";
  const grade      = score>=85?"🔥 極強":score>=70?"⚡ 強訊號":score>=50?"👀 留意":"😴 觀察";

  return { symbol,score,grade,gradeColor,price:last.toFixed(4),
    ma30:ma30.toFixed(4),ma45:ma45.toFixed(4),ma60:ma60.toFixed(4),
    aboveAll,maFan,isEntry,signals,extras,vpt,trade,news:[] };
}

async function getTopSymbols(limit=100) {
  const res  = await fetch(`${FAPI}/fapi/v1/ticker/24hr`);
  const data = await res.json();
  return data.filter(d=>d.symbol.endsWith("USDT")&&!d.symbol.includes("_"))
    .sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume))
    .slice(0,limit).map(d=>d.symbol);
}

const GRADE_ORDER={"🔥 極強":0,"⚡ 強訊號":1,"👀 留意":2,"😴 觀察":3};

// ══════════════════════════════════════════════════════════════════
// 進場通知彈窗
// ══════════════════════════════════════════════════════════════════
function EntryAlert({ alerts, onDismiss }) {
  if(!alerts.length) return null;
  return (
    <div style={{ position:"fixed", top:20, right:20, zIndex:9999, display:"flex",
      flexDirection:"column", gap:10, maxWidth:360 }}>
      {alerts.map((a,i)=>(
        <div key={a.symbol+i} style={{
          background:"linear-gradient(135deg,#0d2137,#0d2820)",
          border:"1px solid #4caf50", borderRadius:12, padding:"14px 16px",
          boxShadow:"0 8px 32px #00000088,0 0 20px #4caf5044",
          animation:"slideIn .3s ease" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ fontSize:11, color:"#4caf50", letterSpacing:2, marginBottom:4 }}>
                🚀 進場訊號觸發
              </div>
              <div style={{ fontSize:18, fontWeight:800, color:"#e8eaf6", marginBottom:4 }}>
                {a.symbol.replace("USDT","")} <span style={{ fontSize:11, color:"#37474f" }}>/USDT.PERP</span>
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
                <span style={{ fontSize:11, color:"#ff9500", background:"#ff950022", padding:"2px 8px", borderRadius:4 }}>
                  評分 {a.score}/100
                </span>
                <span style={{ fontSize:11, color:a.vpt?.verdictColor||"#90a4ae",
                  background:`${a.vpt?.verdictBg||"#1a2035"}`, padding:"2px 8px", borderRadius:4 }}>
                  {a.vpt?.verdictIcon} {a.vpt?.verdict}
                </span>
              </div>
              {a.trade && (
                <div style={{ background:"#060c1a", borderRadius:6, padding:"8px 10px",
                  border:"1px solid #4caf5033", fontSize:10 }}>
                  <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
                    <span>📍進場 <span style={{ color:"#e8eaf6", fontWeight:700 }}>{a.trade.entryIdeal}</span></span>
                    <span>🛑止損 <span style={{ color:"#ef5350", fontWeight:700 }}>{a.trade.stopLoss}</span>
                      <span style={{ color:"#455a64" }}> ({a.trade.slPct}%)</span></span>
                    <span>🎯TP1 <span style={{ color:"#4caf50", fontWeight:700 }}>{a.trade.tp1}</span>
                      <span style={{ color:"#455a64" }}> (+{a.trade.tp1Pct}%)</span></span>
                  </div>
                  <div style={{ color:"#455a64", marginTop:4 }}>風報比 1:{a.trade.rr} · {a.trade.strategy}</div>
                </div>
              )}
              <div style={{ fontSize:11, color:"#546e7a", lineHeight:1.6 }}>
                均線排列✅ · 布林Squeeze · 量縮蓄能
              </div>
            </div>
            <button onClick={()=>onDismiss(i)}
              style={{ background:"none", border:"none", color:"#37474f", cursor:"pointer",
                fontSize:16, padding:"0 4px", lineHeight:1 }}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 新聞面板
// ══════════════════════════════════════════════════════════════════
function NewsPanel({ symbol, news, loading, onClose }) {
  return (
    <div style={{ position:"fixed", top:0, right:0, width:380, height:"100vh",
      background:"#0b0f1c", borderLeft:"1px solid #1a2035", zIndex:1000,
      display:"flex", flexDirection:"column", boxShadow:"-8px 0 32px #00000099" }}>
      <div style={{ padding:"16px 18px", borderBottom:"1px solid #1a2035",
        display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:9, color:"#ff9800", letterSpacing:2, marginBottom:4 }}>LATEST NEWS</div>
          <div style={{ fontSize:15, fontWeight:700, color:"#e8eaf6" }}>
            {symbol?.replace("USDT","")} 最新消息
          </div>
        </div>
        <button onClick={onClose}
          style={{ background:"none", border:"none", color:"#546e7a", cursor:"pointer", fontSize:18 }}>✕</button>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"16px 18px" }}>
        {loading ? (
          <div style={{ color:"#37474f", fontSize:12, textAlign:"center", marginTop:40 }}>
            🔍 搜尋最新消息中…
          </div>
        ) : news?.length ? (
          news.map((n,i)=>(
            <div key={i} style={{ background:"#060c1a", borderRadius:8, padding:"12px 14px",
              marginBottom:10, border:"1px solid #1a2035" }}>
              <div style={{ fontSize:9, color:"#37474f", marginBottom:5 }}>#{i+1}</div>
              <div style={{ fontSize:12, color:"#90a4ae", lineHeight:1.7 }}>{n}</div>
            </div>
          ))
        ) : (
          <div style={{ color:"#37474f", fontSize:12, textAlign:"center", marginTop:40 }}>
            目前沒有相關新聞
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 主 App
// ══════════════════════════════════════════════════════════════════
export default function App() {
  const [interval,    setIntervalVal] = useState("4h");
  const [mode,        setMode]        = useState("top100");
  const [customSyms,  setCustomSyms]  = useState("BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT");
  const [showCustom,  setShowCustom]  = useState(false);
  const [results,     setResults]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [progress,    setProgress]    = useState({done:0,total:0});
  const [expanded,    setExpanded]    = useState(null);
  const [filter,      setFilter]      = useState("all");
  const [sortKey,     setSortKey]     = useState("score");
  const [lastScan,    setLastScan]    = useState(null);
  const [error,       setError]       = useState(null);
  const [alerts,      setAlerts]      = useState([]);
  const [newsSymbol,  setNewsSymbol]  = useState(null);
  const [newsData,    setNewsData]    = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const abortRef   = useRef(false);
  const firstLoad  = useRef(true);
  const timerRef   = useRef(null);
  const seenAlerts = useRef(new Set());

  const runScan = useCallback(async (iv=interval, scanMode=mode, syms=customSyms) => {
    abortRef.current=false;
    setLoading(true); setError(null); setResults([]);
    try {
      let symList = scanMode==="top100"
        ? await getTopSymbols(100)
        : syms.split(/[,\s]+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
      setProgress({done:0,total:symList.length});

      const newAlerts=[];
      const out=[];
      const BATCH=10;
      for(let i=0;i<symList.length;i+=BATCH){
        if(abortRef.current) break;
        const batch=symList.slice(i,i+BATCH);
        const res=await Promise.all(batch.map(s=>analyseSymbol(s,iv)));
        res.forEach(r=>{
          if(!r) return;
          out.push(r);
          // 進場訊號通知（每個幣種只通知一次）
          if(r.isEntry && !seenAlerts.current.has(r.symbol+iv)){
            seenAlerts.current.add(r.symbol+iv);
            newAlerts.push(r);
            // 瀏覽器通知
            if(Notification.permission==="granted"){
              new Notification(`🚀 進場訊號：${r.symbol.replace("USDT","")}`,{
                body:`評分${r.score}/100 · ${r.vpt?.verdict||""} · 點擊查看詳情`,
                icon:"/icon-192.png"
              });
            }
          }
        });
        if(newAlerts.length) setAlerts(prev=>[...prev,...newAlerts.splice(0)]);
        setProgress({done:Math.min(i+BATCH,symList.length),total:symList.length});
        setResults([...out].sort((a,b)=>b.score-a.score));
        await new Promise(r=>setTimeout(r,150));
      }
      setLastScan(new Date().toLocaleTimeString("zh-TW"));
    } catch(e){ setError(e.message); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // 首次載入 + 請求通知權限
  useEffect(()=>{
    if(firstLoad.current){
      firstLoad.current=false;
      if(Notification.permission==="default") Notification.requestPermission();
      runScan();
    }
  },[runScan]);

  // 自動重新整理
  useEffect(()=>{
    if(autoRefresh){
      timerRef.current=setInterval(()=>runScan(), 5*60*1000); // 每5分鐘
    } else {
      clearInterval(timerRef.current);
    }
    return ()=>clearInterval(timerRef.current);
  },[autoRefresh,runScan]);

  // 抓新聞
  async function openNews(symbol) {
    setNewsSymbol(symbol); setNewsLoading(true); setNewsData([]);
    const news = await fetchNews(symbol);
    setNewsData(news); setNewsLoading(false);
  }

  const filtered = results
    .filter(r=>{
      if(filter==="strong") return r.score>=70;
      if(filter==="entry")  return r.isEntry;
      if(filter==="above")  return r.aboveAll;
      if(filter==="fan")    return r.maFan;
      return true;
    })
    .sort((a,b)=>{
      if(sortKey==="score")  return b.score-a.score;
      if(sortKey==="grade")  return (GRADE_ORDER[a.grade]??9)-(GRADE_ORDER[b.grade]??9);
      if(sortKey==="symbol") return a.symbol.localeCompare(b.symbol);
      return 0;
    });

  const okIcon = ok=>ok===true?"✅":ok==="warn"?"⚠️":"❌";
  const pct    = progress.total?Math.round(progress.done/progress.total*100):0;
  const entryCount = results.filter(r=>r.isEntry).length;

  const C={
    sidebar:  {width:220,minWidth:220,background:"#0b0f1c",borderRight:"1px solid #0f1629",
               height:"100vh",overflowY:"auto",padding:"18px 14px",boxSizing:"border-box",
               display:"flex",flexDirection:"column",gap:16},
    main:     {flex:1,overflowY:"auto",height:"100vh",background:"#07090f",
               padding:"16px 20px",boxSizing:"border-box"},
    sLabel:   {fontSize:9,letterSpacing:3,color:"#1e3a5f",textTransform:"uppercase",marginBottom:8},
    ivBtn:    (a)=>({width:"100%",padding:"7px 10px",borderRadius:5,textAlign:"left",marginBottom:3,
               border:`1px solid ${a?"#3949ab":"#0f1629"}`,background:a?"#1a2040":"transparent",
               color:a?"#9fa8da":"#37474f",cursor:"pointer",fontSize:11,fontFamily:"inherit"}),
    modeBtn:  (a)=>({width:"100%",padding:"8px 10px",borderRadius:6,textAlign:"left",marginBottom:3,
               border:`1px solid ${a?"#00897b":"#0f1629"}`,background:a?"#00695c22":"transparent",
               color:a?"#4dd0e1":"#37474f",cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:600}),
    scanBtn:  {width:"100%",padding:"9px",borderRadius:6,border:"none",
               background:"linear-gradient(135deg,#283593,#00695c)",
               color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"},
    fBtn:     (a)=>({padding:"4px 10px",borderRadius:4,
               border:`1px solid ${a?"#3949ab":"#1a2035"}`,background:a?"#1a2040":"transparent",
               color:a?"#9fa8da":"#37474f",cursor:"pointer",fontSize:10,fontFamily:"inherit"}),
    card:     (score,open)=>({background:open?"#0f1729":"#0c111e",borderRadius:7,marginBottom:4,
               cursor:"pointer",overflow:"hidden",
               border:`1px solid ${score>=85?"#3949ab":score>=70?"#2e3a5e":score>=50?"#1c2d35":"#111827"}`,
               boxShadow:open?"0 0 0 1px #3949ab44":score>=85?"0 0 14px #3949ab33":"none"}),
  };

  return (
    <div style={{display:"flex",height:"100vh",overflow:"hidden",
      fontFamily:"'SF Mono','Fira Code',ui-monospace,monospace",color:"#dde1f0"}}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#07090f}
        ::-webkit-scrollbar-thumb{background:#1a2035;border-radius:2px}
        *{box-sizing:border-box}
      `}</style>

      {/* 進場彈窗 */}
      <EntryAlert alerts={alerts} onDismiss={i=>setAlerts(prev=>prev.filter((_,j)=>j!==i))}/>

      {/* 新聞側欄 */}
      {newsSymbol && <NewsPanel symbol={newsSymbol} news={newsData} loading={newsLoading} onClose={()=>setNewsSymbol(null)}/>}

      {/* ── 左側欄 ── */}
      <div style={C.sidebar}>
        <div>
          <div style={{fontSize:9,letterSpacing:4,color:"#3d5afe",textTransform:"uppercase",marginBottom:5}}>FUTURES SCANNER</div>
          <div style={{fontSize:14,fontWeight:800,lineHeight:1.3,
            background:"linear-gradient(90deg,#7986cb,#4dd0e1)",
            WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
            合約爆發<br/>偵測器
          </div>
          <div style={{fontSize:9,color:"#263238",marginTop:3}}>10項評分 · 量價分析 · 即時新聞</div>
        </div>

        <div>
          <div style={C.sLabel}>掃描模式</div>
          <button style={C.modeBtn(mode==="top100")}
            onClick={()=>{setMode("top100");setShowCustom(false);runScan(interval,"top100",customSyms);}}>
            🏆 交易量前100名
          </button>
          <button style={C.modeBtn(mode==="custom")}
            onClick={()=>{setMode("custom");setShowCustom(true);}}>
            ✏️ 自訂幣種
          </button>
          {showCustom&&(
            <div style={{marginTop:5}}>
              <textarea value={customSyms} onChange={e=>setCustomSyms(e.target.value)}
                style={{width:"100%",height:70,background:"#060810",border:"1px solid #1a2035",
                  borderRadius:5,color:"#90a4ae",fontSize:10,padding:"5px 7px",fontFamily:"inherit",resize:"vertical"}}/>
              <button onClick={()=>runScan(interval,"custom",customSyms)} style={{...C.scanBtn,marginTop:4,fontSize:10}}>套用掃描</button>
            </div>
          )}
        </div>

        <div>
          <div style={C.sLabel}>時間週期</div>
          {INTERVALS.map(iv=>(
            <button key={iv.value} style={C.ivBtn(interval===iv.value)}
              onClick={()=>{setIntervalVal(iv.value);runScan(iv.value,mode,customSyms);}}>
              {iv.label}
            </button>
          ))}
        </div>

        <button onClick={()=>runScan(interval,mode,customSyms)} disabled={loading} style={C.scanBtn}>
          {loading
            ?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
               <span style={{width:11,height:11,border:"2px solid #546e7a",borderTopColor:"#fff",
                 borderRadius:"50%",display:"inline-block",animation:"spin 1s linear infinite"}}/>
               {progress.total>0?`${progress.done}/${progress.total}`:"準備中…"}
             </span>
            :"🔄 重新掃描"}
        </button>

        {/* 自動刷新 */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:10,color:"#37474f"}}>每5分鐘自動掃描</span>
          <div onClick={()=>setAutoRefresh(!autoRefresh)}
            style={{width:36,height:20,borderRadius:10,background:autoRefresh?"#00897b":"#1a2035",
              cursor:"pointer",position:"relative",transition:"background .2s"}}>
            <div style={{position:"absolute",top:3,left:autoRefresh?18:3,width:14,height:14,
              borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
          </div>
        </div>

        {loading&&progress.total>0&&(
          <div>
            <div style={{height:3,background:"#0f1629",borderRadius:2}}>
              <div style={{width:`${pct}%`,height:"100%",borderRadius:2,
                background:"linear-gradient(90deg,#283593,#00897b)",transition:"width .3s"}}/>
            </div>
            <div style={{fontSize:9,color:"#263238",marginTop:3,textAlign:"center"}}>{pct}%</div>
          </div>
        )}

        {results.length>0&&!loading&&(
          <div style={{background:"#060810",borderRadius:7,padding:"10px 12px",border:"1px solid #0f1629",fontSize:10}}>
            <div style={C.sLabel}>本次統計</div>
            {[["掃描幣種",progress.total||results.length],["有效結果",results.length],
              ["強訊號≥70",results.filter(r=>r.score>=70).length],
              ["🚀進場訊號",entryCount],["多頭排列",results.filter(r=>r.maFan).length]
            ].map(([k,v])=>(
              <div key={k} style={{display:"flex",justifyContent:"space-between",color:"#455a64",marginBottom:4}}>
                <span>{k}</span>
                <span style={{color:k==="🚀進場訊號"&&v>0?"#4caf50":"#7986cb",fontWeight:700}}>{v}</span>
              </div>
            ))}
            <div style={{color:"#263238",fontSize:9,marginTop:5}}>上次 {lastScan}</div>
          </div>
        )}

        {error&&<div style={{fontSize:10,lineHeight:1.6,borderRadius:5,padding:"7px 9px",
          background:"#1a0a0a",border:"1px solid #c62828",color:"#ef9a9a"}}>⚠️ {error}</div>}

        <div style={{fontSize:9,color:"#111827",marginTop:"auto"}}>直連幣安合約 · 瀏覽器端計算</div>
      </div>

      {/* ── 主區 ── */}
      <div style={C.main}>
        {/* 工具列 */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
          marginBottom:12,flexWrap:"wrap",gap:7}}>
          <div style={{display:"flex",gap:4}}>
            {[["all","全部"],["entry",`🚀進場(${entryCount})`],["strong","強訊號≥70"],
              ["above","站上三均"],["fan","多頭排列"]].map(([v,l])=>(
              <button key={v} onClick={()=>setFilter(v)} style={C.fBtn(filter===v)}>{l}</button>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:9,color:"#263238"}}>排序</span>
            {[["score","評分"],["grade","等級"],["symbol","名稱"]].map(([k,l])=>(
              <button key={k} onClick={()=>setSortKey(k)} style={C.fBtn(sortKey===k)}>{l}</button>
            ))}
            <span style={{fontSize:9,color:"#263238",marginLeft:4}}>
              顯示<span style={{color:"#7986cb"}}>{filtered.length}</span>/{results.length}
            </span>
          </div>
        </div>

        {/* 表頭 */}
        {filtered.length>0&&(
          <div style={{display:"grid",
            gridTemplateColumns:"28px 44px 1fr 90px 90px 90px 90px 70px 70px 28px",
            gap:"0 8px",padding:"0 8px 6px",fontSize:9,color:"#263238",
            letterSpacing:1,textTransform:"uppercase",borderBottom:"1px solid #0f1629",marginBottom:5}}>
            <span>#</span><span>分</span><span>幣種</span>
            <span>現價</span><span>MA30</span><span>MA45</span><span>MA60</span>
            <span>訊號</span><span>走勢</span><span></span>
          </div>
        )}

        {loading&&results.length===0&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",
            justifyContent:"center",height:"60vh",gap:14}}>
            <div style={{width:40,height:40,border:"3px solid #1a2035",
              borderTopColor:"#7986cb",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
            <div style={{color:"#37474f",fontSize:12}}>
              {progress.total>0?`掃描中 ${progress.done}/${progress.total}…`:"連線幣安中…"}
            </div>
          </div>
        )}

        {filtered.map((r,idx)=>(
          <div key={r.symbol} style={C.card(r.score,expanded===r.symbol)}>
            {/* 主列 */}
            <div style={{display:"grid",
              gridTemplateColumns:"28px 44px 1fr 90px 90px 90px 90px 70px 70px 28px",
              gap:"0 8px",padding:"8px 8px",alignItems:"center"}}
              onClick={()=>setExpanded(expanded===r.symbol?null:r.symbol)}>

              <span style={{color:"#1e293b",fontSize:9}}>#{idx+1}</span>

              {/* Score ring */}
              <div style={{position:"relative",width:40,height:40}}>
                <svg width="40" height="40" style={{transform:"rotate(-90deg)"}}>
                  <circle cx="20" cy="20" r="14" fill="none" stroke="#111827" strokeWidth="3"/>
                  <circle cx="20" cy="20" r="14" fill="none" stroke={r.gradeColor} strokeWidth="3"
                    strokeDasharray={`${(r.score/100)*88} 88`} strokeLinecap="round"/>
                </svg>
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:10,fontWeight:800,color:r.gradeColor}}>
                  {r.score}
                </div>
              </div>

              {/* Symbol */}
              <div>
                <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,fontWeight:700,color:"#e8eaf6"}}>{r.symbol.replace("USDT","")}</span>
                  <span style={{fontSize:8,color:"#263238"}}>/USDT</span>
                  <span style={{fontSize:8,color:r.gradeColor,background:`${r.gradeColor}18`,padding:"1px 4px",borderRadius:3}}>{r.grade}</span>
                  {r.isEntry&&<span style={{fontSize:8,color:"#4caf50",background:"#4caf5022",padding:"1px 5px",borderRadius:3,fontWeight:700}}>🚀進場</span>}
                  {r.maFan&&<span style={{fontSize:8,color:"#4dd0e1",background:"#00695c18",padding:"1px 4px",borderRadius:3}}>多頭↑</span>}
                </div>
              </div>

              {[[r.price,"#90a4ae"],[r.ma30,"#7986cb"],[r.ma45,"#9575cd"],[r.ma60,"#26c6da"]].map(([v,c],i)=>(
                <span key={i} style={{fontSize:10,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</span>
              ))}

              {/* 訊號點 */}
              <div style={{display:"flex",gap:2,flexWrap:"wrap"}}>
                {r.signals.slice(0,10).map(s=>(
                  <div key={s.key} title={s.label} style={{width:6,height:6,borderRadius:"50%",
                    background:s.ok===true?"#00897b":s.ok==="warn"?"#ff9500":"#1e293b"}}/>
                ))}
              </div>

              {/* 走勢標籤 */}
              <span style={{fontSize:9,color:r.vpt?.verdictColor||"#37474f",
                background:r.vpt?.verdictBg,padding:"2px 5px",borderRadius:3,fontWeight:700}}>
                {r.vpt?.verdictIcon} {r.vpt?.verdict?.replace("略","略\n")||"—"}
              </span>

              <span style={{color:"#263238",fontSize:10}}>{expanded===r.symbol?"▲":"▼"}</span>
            </div>

            {/* 展開詳情 */}
            {expanded===r.symbol&&(
              <div style={{borderTop:"1px solid #0f1629",padding:"14px 16px",
                display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:18}}>

                {/* 左：10項訊號 */}
                <div>
                  <div style={{fontSize:9,color:"#3d5afe",letterSpacing:2,marginBottom:10}}>
                    10項評分指標
                  </div>
                  {r.signals.map(s=>(
                    <div key={s.key} style={{display:"flex",gap:8,marginBottom:8,alignItems:"flex-start"}}>
                      <span style={{fontSize:12}}>{okIcon(s.ok)}</span>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{fontSize:10,fontWeight:700,
                            color:s.ok===true?"#4dd0e1":s.ok==="warn"?"#ffb74d":"#455a64"}}>{s.label}</span>
                          <span style={{fontSize:9,color:"#263238"}}>{s.s}/{s.w}pt</span>
                        </div>
                        <div style={{fontSize:10,color:"#546e7a",lineHeight:1.5}}>{s.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 中：量價走勢 */}
                <div>
                  <div style={{fontSize:9,color:"#ff9800",letterSpacing:2,marginBottom:10}}>量價走勢分析</div>
                  {r.vpt&&(
                    <>
                      <div style={{background:r.vpt.verdictBg,border:`1px solid ${r.vpt.verdictColor}44`,
                        borderRadius:8,padding:"12px 14px",marginBottom:10}}>
                        <div style={{fontSize:20,fontWeight:800,color:r.vpt.verdictColor}}>
                          {r.vpt.verdictIcon} {r.vpt.verdict}
                        </div>
                        <div style={{display:"flex",gap:12,marginTop:5}}>
                          <span style={{fontSize:10,color:"#4caf50"}}>多方 {r.vpt.bullScore}分</span>
                          <span style={{fontSize:10,color:"#37474f"}}>vs</span>
                          <span style={{fontSize:10,color:"#ef5350"}}>空方 {r.vpt.bearScore}分</span>
                        </div>
                      </div>
                      <div style={{height:5,background:"#111827",borderRadius:3,overflow:"hidden",display:"flex",marginBottom:10}}>
                        <div style={{width:`${r.vpt.bullScore/(r.vpt.bullScore+r.vpt.bearScore+0.01)*100}%`,background:"#4caf50"}}/>
                        <div style={{flex:1,background:"#ef5350"}}/>
                      </div>
                      {r.vpt.reasons.map((rs,i)=>(
                        <div key={i} style={{display:"flex",gap:6,marginBottom:6}}>
                          <span style={{fontSize:10,color:rs.type==="bull"?"#4caf50":rs.type==="bear"?"#ef5350":"#90a4ae",minWidth:10}}>
                            {rs.type==="bull"?"▲":rs.type==="bear"?"▼":"◆"}
                          </span>
                          <span style={{fontSize:10,color:"#546e7a",lineHeight:1.5}}>{rs.text}</span>
                        </div>
                      ))}
                      <div style={{marginTop:8,display:"flex",gap:10,fontSize:9,color:"#263238"}}>
                        {r.vpt.obvTrend&&<span>OBV:<span style={{color:r.vpt.obvTrend==="up"?"#4caf50":"#ef5350"}}>{r.vpt.obvTrend==="up"?"↑":"↓"}</span></span>}
                        {r.vpt.volRatioVal&&<span>量比:<span style={{color:"#9fa8da"}}>{r.vpt.volRatioVal}x</span></span>}
                      </div>
                    </>
                  )}
                </div>

                {/* 右：評分 + 新聞 + 合約數據 */}
                <div>
                  <div style={{marginBottom:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#37474f",marginBottom:5}}>
                      <span>爆發評分（10項）</span>
                      <span style={{color:r.gradeColor,fontWeight:800,fontSize:14}}>{r.score}/100</span>
                    </div>
                    <div style={{height:5,background:"#111827",borderRadius:3}}>
                      <div style={{width:`${r.score}%`,height:"100%",borderRadius:3,
                        background:`linear-gradient(90deg,#283593,${r.gradeColor})`}}/>
                    </div>
                  </div>

                  {/* 新聞按鈕 */}
                  <button onClick={e=>{e.stopPropagation();openNews(r.symbol);}}
                    style={{width:"100%",padding:"8px",borderRadius:6,
                      background:"#060c1a",border:"1px solid #1a2035",
                      color:"#ff9800",cursor:"pointer",fontSize:11,fontFamily:"inherit",
                      marginBottom:10,textAlign:"left"}}>
                    📰 查看 {r.symbol.replace("USDT","")} 最新消息
                  </button>

                  {/* 進場點位 / 止盈 / 止損 */}
                  {r.trade && (
                    <div style={{background:"#060c1a",borderRadius:8,padding:"12px 14px",
                      border:"1px solid #4caf5044",marginBottom:10}}>
                      <div style={{fontSize:9,color:"#4caf50",letterSpacing:2,marginBottom:10}}>
                        🚀 交易點位建議
                      </div>
                      <div style={{fontSize:10,color:"#546e7a",marginBottom:10,
                        background:"#0a1520",padding:"6px 8px",borderRadius:5}}>
                        {r.trade.strategy}
                      </div>

                      {/* 進場區 */}
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:9,color:"#37474f",letterSpacing:1,marginBottom:5}}>進場</div>
                        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                          <div style={{background:"#0d2137",borderRadius:5,padding:"7px 10px",flex:1}}>
                            <div style={{fontSize:9,color:"#37474f",marginBottom:2}}>市價進場</div>
                            <div style={{fontSize:14,fontWeight:800,color:"#90a4ae"}}>{r.trade.entryIdeal}</div>
                          </div>
                          <div style={{background:"#0d2137",borderRadius:5,padding:"7px 10px",flex:1}}>
                            <div style={{fontSize:9,color:"#37474f",marginBottom:2}}>限價等回踩</div>
                            <div style={{fontSize:14,fontWeight:800,color:"#7986cb"}}>{r.trade.entryLimit}</div>
                          </div>
                        </div>
                      </div>

                      {/* 止損 */}
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:9,color:"#37474f",letterSpacing:1,marginBottom:5}}>止損 SL</div>
                        <div style={{background:"#1a0a0a",borderRadius:5,padding:"8px 12px",
                          border:"1px solid #ef535033",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <div style={{fontSize:16,fontWeight:800,color:"#ef5350"}}>{r.trade.stopLoss}</div>
                            <div style={{fontSize:10,color:"#795548",marginTop:2}}>近5根低點 & MA45保護線</div>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:13,fontWeight:700,color:"#ef5350"}}>{r.trade.slPct}%</div>
                            <div style={{fontSize:9,color:"#37474f"}}>下跌幅度</div>
                          </div>
                        </div>
                      </div>

                      {/* 止盈三檔 */}
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:9,color:"#37474f",letterSpacing:1,marginBottom:5}}>止盈 TP（三檔）</div>
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {[
                            {label:"TP1 保守（1.5R）",val:r.trade.tp1,pct:r.trade.tp1Pct,tip:"建議先減半倉位",opacity:1},
                            {label:`TP2 標準（${r.trade.rr}R）`,val:r.trade.tp2,pct:r.trade.tp2Pct,tip:"再減半剩餘倉位",opacity:0.85},
                            {label:"TP3 接近阻力位",val:r.trade.tp3,pct:r.trade.tp3Pct,tip:"最後剩餘倉位出場",opacity:0.7},
                          ].map((tp,i)=>(
                            <div key={i} style={{background:`rgba(13,40,32,${tp.opacity})`,borderRadius:5,
                              padding:"7px 10px",border:"1px solid #4caf5033",
                              display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                              <div>
                                <div style={{fontSize:9,color:"#37474f",marginBottom:2}}>{tp.label}</div>
                                <div style={{fontSize:13,fontWeight:700,color:"#4caf50"}}>{tp.val}</div>
                                <div style={{fontSize:9,color:"#2e7d32",marginTop:1}}>{tp.tip}</div>
                              </div>
                              <div style={{textAlign:"right"}}>
                                <div style={{fontSize:13,fontWeight:700,color:"#4caf50"}}>+{tp.pct}%</div>
                                <div style={{fontSize:9,color:"#37474f"}}>上漲幅度</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* 風報比 & 倉位 */}
                      <div style={{display:"flex",gap:8}}>
                        <div style={{flex:1,background:"#0b1020",borderRadius:5,padding:"7px 10px",
                          border:"1px solid #37474f"}}>
                          <div style={{fontSize:9,color:"#37474f",marginBottom:2}}>風報比</div>
                          <div style={{fontSize:14,fontWeight:800,color:"#ff9800"}}>1 : {r.trade.rr}</div>
                        </div>
                        <div style={{flex:2,background:"#0b1020",borderRadius:5,padding:"7px 10px",
                          border:"1px solid #37474f"}}>
                          <div style={{fontSize:9,color:"#37474f",marginBottom:2}}>建議倉位（帳戶%）</div>
                          <div style={{fontSize:11,fontWeight:700,color:"#9fa8da"}}>{r.trade.positionPct}</div>
                        </div>
                      </div>

                      {/* 支撐阻力參考 */}
                      <div style={{marginTop:8,display:"flex",gap:8}}>
                        <div style={{flex:1,background:"#0b1020",borderRadius:5,padding:"6px 8px"}}>
                          <div style={{fontSize:9,color:"#37474f"}}>近期阻力</div>
                          <div style={{fontSize:11,color:"#ef5350",fontWeight:700}}>{r.trade.pivotHi}</div>
                        </div>
                        <div style={{flex:1,background:"#0b1020",borderRadius:5,padding:"6px 8px"}}>
                          <div style={{fontSize:9,color:"#37474f"}}>近期支撐</div>
                          <div style={{fontSize:11,color:"#4caf50",fontWeight:700}}>{r.trade.pivotLo}</div>
                        </div>
                      </div>

                      <div style={{marginTop:8,fontSize:9,color:"#1e293b",lineHeight:1.7}}>
                        ⚠️ 點位僅供參考，實際進出場請結合K線型態與個人風控。合約交易槓桿風險極高，請勿重倉。
                      </div>
                    </div>
                  )}

                  {r.extras?.length>0&&(
                    <>
                      <div style={{fontSize:9,color:"#3d5afe",letterSpacing:2,marginBottom:7}}>FUTURES DATA</div>
                      <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                        {r.extras.map(ex=>(
                          <div key={ex.label} style={{background:"#060810",borderRadius:5,padding:"7px 11px",
                            border:`1px solid ${ex.color}33`,minWidth:80}}>
                            <div style={{fontSize:9,color:"#455a64",marginBottom:2}}>{ex.label}</div>
                            <div style={{fontSize:13,fontWeight:700,color:ex.color}}>{ex.value}</div>
                            <div style={{fontSize:9,color:"#37474f",marginTop:2}}>{ex.note}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <div style={{marginTop:10,fontSize:9,color:"#1e293b",lineHeight:1.6}}>
                    ⚠️ 技術指標僅供參考，不構成投資建議。
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {!loading&&results.length>0&&filtered.length===0&&(
          <div style={{textAlign:"center",color:"#263238",marginTop:50,fontSize:12}}>
            沒有符合篩選條件的標的
          </div>
        )}
      </div>
    </div>
  );
}
