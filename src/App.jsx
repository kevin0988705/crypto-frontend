import { useState, useEffect, useRef, useCallback } from "react";

const FAPI = "https://fapi.binance.com";
const INTERVALS = [
  { label:"15分鐘", value:"15m" },
  { label:"1小時",  value:"1h"  },
  { label:"4小時",  value:"4h"  },
  { label:"日線",   value:"1d"  },
];

// ══════════════════════════════════════════════════════════════════
// 基礎指標
// ══════════════════════════════════════════════════════════════════
const sma = (arr,n) => arr.length<n?null:arr.slice(-n).reduce((a,b)=>a+b,0)/n;

function ema(arr,n) {
  if(arr.length<n) return null;
  const k=2/(n+1);
  let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<arr.length;i++) e=arr[i]*k+e*(1-k);
  return e;
}

function bollingerBands(closes,n=20,mult=2) {
  if(closes.length<n) return null;
  const sl=closes.slice(-n);
  const m=sl.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return {mid:m, upper:m+mult*sd, lower:m-mult*sd, width:(mult*2*sd)/m};
}

function rsiCalc(closes,n=14) {
  if(closes.length<n+1) return null;
  let g=0,l=0;
  for(let i=closes.length-n;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    d>=0?g+=d:l-=d;
  }
  return 100-100/(1+g/(l||0.0001));
}

function macdCalc(closes) {
  const e12=ema(closes,12),e26=ema(closes,26);
  return (!e12||!e26)?null:{line:e12-e26,prev:ema(closes.slice(0,-1),12)-ema(closes.slice(0,-1),26)||0};
}

function stochRsi(closes,rLen=14,sLen=14) {
  if(closes.length<rLen+sLen+1) return null;
  const rArr=[];
  for(let i=rLen;i<=closes.length;i++){
    const sl=closes.slice(i-rLen-1,i); let g=0,l=0;
    for(let j=1;j<sl.length;j++){const d=sl[j]-sl[j-1];d>=0?g+=d:l-=d;}
    rArr.push(100-100/(1+g/(l||0.0001)));
  }
  if(rArr.length<sLen) return null;
  const sl=rArr.slice(-sLen),hi=Math.max(...sl),lo=Math.min(...sl);
  return hi===lo?50:(rArr[rArr.length-1]-lo)/(hi-lo)*100;
}

function atrCalc(candles,n=14) {
  if(candles.length<n+1) return null;
  const trs=candles.slice(1).map((c,i)=>Math.max(c.h-c.l,Math.abs(c.h-candles[i].c),Math.abs(c.l-candles[i].c)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function calcOBV(candles) {
  let o=0; const a=[0];
  for(let i=1;i<candles.length;i++){
    o+=candles[i].c>candles[i-1].c?candles[i].v:candles[i].c<candles[i-1].c?-candles[i].v:0;
    a.push(o);
  }
  return a;
}

// ══════════════════════════════════════════════════════════════════
// SMC 分析引擎
// ══════════════════════════════════════════════════════════════════
function detectSMC(candles) {
  const len = candles.length;
  if(len < 30) return null;

  // ── 1. Break of Structure (BOS) & Change of Character (CHoCH) ──
  // 找近期高低點（Swing High/Low）
  const swings = [];
  for(let i=3;i<len-3;i++){
    const isHigh = candles[i].h > candles[i-1].h && candles[i].h > candles[i-2].h &&
                   candles[i].h > candles[i+1].h && candles[i].h > candles[i+2].h;
    const isLow  = candles[i].l < candles[i-1].l && candles[i].l < candles[i-2].l &&
                   candles[i].l < candles[i+1].l && candles[i].l < candles[i+2].l;
    if(isHigh) swings.push({idx:i,type:"high",price:candles[i].h});
    if(isLow)  swings.push({idx:i,type:"low", price:candles[i].l});
  }

  // 最近的 BOS
  const lastPrice = candles[len-1].c;
  const recentHighs = swings.filter(s=>s.type==="high").slice(-5);
  const recentLows  = swings.filter(s=>s.type==="low" ).slice(-5);
  const lastSwingHigh = recentHighs[recentHighs.length-1];
  const lastSwingLow  = recentLows[recentLows.length-1];

  let bos = null;
  if(lastSwingHigh && lastPrice > lastSwingHigh.price){
    bos = { type:"bullish", price:lastSwingHigh.price, idx:lastSwingHigh.idx,
            label:"BOS 向上突破", color:"#4caf50" };
  } else if(lastSwingLow && lastPrice < lastSwingLow.price){
    bos = { type:"bearish", price:lastSwingLow.price, idx:lastSwingLow.idx,
            label:"BOS 向下突破", color:"#ef5350" };
  }

  // CHoCH（趨勢轉換）
  let choch = null;
  if(recentHighs.length>=2 && recentLows.length>=2){
    const hi1=recentHighs[recentHighs.length-1], hi2=recentHighs[recentHighs.length-2];
    const lo1=recentLows[recentLows.length-1],  lo2=recentLows[recentLows.length-2];
    if(hi1.price<hi2.price && lo1.price<lo2.price){
      choch={type:"bearish",label:"CHoCH 趨勢由多轉空",color:"#ef5350"};
    } else if(hi1.price>hi2.price && lo1.price>lo2.price){
      choch={type:"bullish",label:"CHoCH 趨勢由空轉多",color:"#4caf50"};
    }
  }

  // ── 2. Order Blocks (OB) ──
  // 多頭OB：下跌後的最後一根陰線（後面開始上漲）
  // 空頭OB：上漲後的最後一根陽線（後面開始下跌）
  const orderBlocks = [];
  for(let i=5;i<len-5;i++){
    const c=candles[i];
    const isBear=c.c<c.o; // 陰線
    const isBull=c.c>c.o; // 陽線
    // 看後面5根是否持續上漲/下跌
    const afterUp   = candles.slice(i+1,i+6).every((x,j,a)=>j===0||x.c>=a[j-1].c);
    const afterDown = candles.slice(i+1,i+6).every((x,j,a)=>j===0||x.c<=a[j-1].c);
    if(isBear && afterUp && i>len-40){
      orderBlocks.push({type:"bull",high:c.h,low:c.l,open:c.o,close:c.c,idx:i,
        label:"多頭OB",color:"#4caf50",colorBg:"#4caf5018"});
    }
    if(isBull && afterDown && i>len-40){
      orderBlocks.push({type:"bear",high:c.h,low:c.l,open:c.o,close:c.c,idx:i,
        label:"空頭OB",color:"#ef5350",colorBg:"#ef535018"});
    }
  }
  const recentOBs = orderBlocks.slice(-4);

  // 最近的 OB 是否在當前價格附近（±2%）
  const nearbyOB = recentOBs.filter(ob=>{
    const mid=(ob.high+ob.low)/2;
    return Math.abs(lastPrice-mid)/lastPrice < 0.02;
  });

  // ── 3. Fair Value Gaps (FVG / Imbalance) ──
  const fvgs = [];
  for(let i=1;i<len-1;i++){
    const prev=candles[i-1], curr=candles[i], next=candles[i+1];
    // 看漲FVG：前根高點 < 後根低點（中間缺口）
    if(next.l > prev.h && i>len-50){
      fvgs.push({type:"bull",high:next.l,low:prev.h,idx:i,
        label:"看漲FVG",color:"#4caf50",colorBg:"#4caf5015"});
    }
    // 看跌FVG：前根低點 > 後根高點
    if(next.h < prev.l && i>len-50){
      fvgs.push({type:"bear",high:prev.l,low:next.h,idx:i,
        label:"看跌FVG",color:"#ef5350",colorBg:"#ef535015"});
    }
  }
  // 未填補的FVG（當前價格未進入）
  const unfilledFVGs = fvgs.filter(f=>{
    if(f.type==="bull") return lastPrice < f.high; // 價格還沒回填
    return lastPrice > f.low;
  }).slice(-4);

  // ── 4. Liquidity (Equal Highs/Lows = 流動性池) ──
  const liquidity = [];
  // Equal Highs（多個相近高點 = 上方流動性，容易被獵取）
  for(let i=0;i<recentHighs.length-1;i++){
    const h1=recentHighs[i], h2=recentHighs[i+1];
    if(Math.abs(h1.price-h2.price)/h1.price < 0.005){
      liquidity.push({type:"high",price:h1.price,label:"上方流動性（Equal Highs）",
        color:"#ff9800",note:"Smart Money 可能向上獵取"});
    }
  }
  // Equal Lows（下方流動性）
  for(let i=0;i<recentLows.length-1;i++){
    const l1=recentLows[i], l2=recentLows[i+1];
    if(Math.abs(l1.price-l2.price)/l1.price < 0.005){
      liquidity.push({type:"low",price:l1.price,label:"下方流動性（Equal Lows）",
        color:"#9c27b0",note:"Smart Money 可能向下獵取"});
    }
  }

  // ── SMC 綜合偏向 ──
  let smcBias = 0, smcReasons = [];
  if(bos?.type==="bullish"){ smcBias+=3; smcReasons.push({t:"bull",s:`BOS向上突破 ${bos.price.toFixed(4)}`}); }
  if(bos?.type==="bearish"){ smcBias-=3; smcReasons.push({t:"bear",s:`BOS向下突破 ${bos.price.toFixed(4)}`}); }
  if(choch?.type==="bullish"){ smcBias+=2; smcReasons.push({t:"bull",s:choch.label}); }
  if(choch?.type==="bearish"){ smcBias-=2; smcReasons.push({t:"bear",s:choch.label}); }
  nearbyOB.forEach(ob=>{
    if(ob.type==="bull"){ smcBias+=2; smcReasons.push({t:"bull",s:`多頭OB支撐附近 ${ob.low.toFixed(4)}–${ob.high.toFixed(4)}`}); }
    if(ob.type==="bear"){ smcBias-=2; smcReasons.push({t:"bear",s:`空頭OB壓制附近 ${ob.low.toFixed(4)}–${ob.high.toFixed(4)}`}); }
  });
  unfilledFVGs.slice(0,2).forEach(f=>{
    if(f.type==="bull"){ smcBias+=1; smcReasons.push({t:"bull",s:`看漲FVG未填補 ${f.low.toFixed(4)}–${f.high.toFixed(4)}`}); }
    if(f.type==="bear"){ smcBias-=1; smcReasons.push({t:"bear",s:`看跌FVG未填補 ${f.low.toFixed(4)}–${f.high.toFixed(4)}`}); }
  });

  const smcVerdict = smcBias>=3?"強勢多頭結構":smcBias>=1?"偏多結構":
    smcBias<=-3?"強勢空頭結構":smcBias<=-1?"偏空結構":"中性結構";
  const smcColor = smcBias>=2?"#4caf50":smcBias<=-2?"#ef5350":"#90a4ae";

  return { bos, choch, orderBlocks:recentOBs, fvgs:unfilledFVGs,
    liquidity, smcBias, smcVerdict, smcColor, smcReasons, swings };
}

// ══════════════════════════════════════════════════════════════════
// K線圖組件（Canvas）
// ══════════════════════════════════════════════════════════════════
function KlineChart({ candles, ma30arr, ma45arr, ma60arr, bb, trade, smc, height=280 }) {
  const canvasRef = useRef(null);

  useEffect(()=>{
    if(!canvasRef.current || !candles || candles.length<2) return;
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext("2d");
    const W = canvas.width, H = height;
    canvas.height = H;
    ctx.clearRect(0,0,W,H);

    // 顯示最近60根
    const display = candles.slice(-60);
    const n = display.length;
    const allH = display.map(c=>c.h), allL = display.map(c=>c.l);

    // 加入MA/BB線的值到範圍計算
    const maVals = [...(ma30arr||[]),...(ma45arr||[]),...(ma60arr||[])].filter(Boolean);
    const bbVals = bb ? [bb.upper, bb.lower] : [];
    const tpVals = trade ? [trade.tp3n, trade.stopLossN, trade.entryN].filter(Boolean) : [];

    const allVals = [...allH, ...allL, ...maVals, ...bbVals, ...tpVals];
    const hi = Math.max(...allVals), lo = Math.min(...allVals);
    const pad = (hi-lo)*0.08;
    const yHi = hi+pad, yLo = lo-pad;

    const toY = v => H - ((v-yLo)/(yHi-yLo))*H;
    const candleW = Math.max(3, Math.floor(W/n)-1);
    const toX = i => i*(W/n) + (W/n-candleW)/2;

    // 背景格線
    ctx.strokeStyle="#1a2035"; ctx.lineWidth=0.5;
    for(let i=0;i<=4;i++){
      const y=H*i/4;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      const price=(yHi-(yHi-yLo)*i/4);
      ctx.fillStyle="#263238"; ctx.font="9px monospace";
      ctx.fillText(price>=1000?price.toFixed(1):price>=1?price.toFixed(3):price.toFixed(5),2,y-2);
    }

    // BB 帶
    if(bb && display.length>=20){
      const bbDisp = candles.slice(-60);
      const bbSlice = candles.slice(-(60+20));
      ctx.fillStyle="rgba(121,134,203,0.06)";
      ctx.beginPath();
      bbDisp.forEach((_,i)=>{
        const sl=bbSlice.slice(i,i+20).map(c=>c.c);
        const m=sl.reduce((a,b)=>a+b,0)/20;
        const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/20);
        const u=m+2*sd;
        if(i===0) ctx.moveTo(toX(i)+candleW/2,toY(u));
        else ctx.lineTo(toX(i)+candleW/2,toY(u));
      });
      for(let i=bbDisp.length-1;i>=0;i--){
        const sl=bbSlice.slice(i,i+20).map(c=>c.c);
        const m=sl.reduce((a,b)=>a+b,0)/20;
        const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/20);
        const l2=m-2*sd;
        ctx.lineTo(toX(i)+candleW/2,toY(l2));
      }
      ctx.closePath(); ctx.fill();
    }

    // SMC: FVG 區塊
    if(smc?.fvgs){
      smc.fvgs.forEach(f=>{
        const startIdx = Math.max(0, f.idx-(candles.length-60));
        if(startIdx>=0&&startIdx<n){
          ctx.fillStyle = f.type==="bull"?"rgba(76,175,80,0.12)":"rgba(239,83,80,0.12)";
          ctx.fillRect(toX(startIdx),toY(f.high),W-toX(startIdx),toY(f.low)-toY(f.high));
          ctx.strokeStyle = f.type==="bull"?"#4caf5044":"#ef535044";
          ctx.lineWidth=0.5;
          ctx.strokeRect(toX(startIdx),toY(f.high),W-toX(startIdx),toY(f.low)-toY(f.high));
          ctx.fillStyle = f.type==="bull"?"#4caf5088":"#ef535088";
          ctx.font="8px monospace"; ctx.fillText("FVG",toX(startIdx)+2,toY(f.high)+9);
        }
      });
    }

    // SMC: Order Blocks
    if(smc?.orderBlocks){
      smc.orderBlocks.forEach(ob=>{
        const startIdx=Math.max(0,ob.idx-(candles.length-60));
        if(startIdx>=0&&startIdx<n){
          ctx.fillStyle=ob.type==="bull"?"rgba(76,175,80,0.15)":"rgba(239,83,80,0.15)";
          ctx.fillRect(toX(startIdx),toY(ob.high),W-toX(startIdx),toY(ob.low)-toY(ob.high));
          ctx.strokeStyle=ob.type==="bull"?"#4caf5077":"#ef535077";
          ctx.lineWidth=1; ctx.setLineDash([3,2]);
          ctx.strokeRect(toX(startIdx),toY(ob.high),W-toX(startIdx),toY(ob.low)-toY(ob.high));
          ctx.setLineDash([]);
          ctx.fillStyle=ob.type==="bull"?"#4caf50bb":"#ef5350bb";
          ctx.font="8px monospace";
          ctx.fillText(ob.type==="bull"?"OB↑":"OB↓",toX(startIdx)+2,toY(ob.high)+9);
        }
      });
    }

    // MA 線
    const drawMA=(arr,col)=>{
      if(!arr||arr.length<2) return;
      const offset=Math.max(0,arr.length-60);
      ctx.strokeStyle=col; ctx.lineWidth=1; ctx.setLineDash([]);
      ctx.beginPath();
      arr.slice(-60).forEach((v,i)=>{ if(!v)return; i===0?ctx.moveTo(toX(i)+candleW/2,toY(v)):ctx.lineTo(toX(i)+candleW/2,toY(v)); });
      ctx.stroke();
    };
    drawMA(ma30arr,"#7986cb"); drawMA(ma45arr,"#9575cd"); drawMA(ma60arr,"#26c6da");

    // K線本體
    display.forEach((c,i)=>{
      const x=toX(i), isBull=c.c>=c.o;
      const col=isBull?"#4caf50":"#ef5350";
      const bodyTop=toY(Math.max(c.o,c.c)), bodyBot=toY(Math.min(c.o,c.c));
      const bodyH=Math.max(1,bodyBot-bodyTop);
      // 影線
      ctx.strokeStyle=col; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(x+candleW/2,toY(c.h)); ctx.lineTo(x+candleW/2,bodyTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x+candleW/2,bodyBot); ctx.lineTo(x+candleW/2,toY(c.l)); ctx.stroke();
      // 本體
      ctx.fillStyle=col; ctx.fillRect(x,bodyTop,candleW,bodyH);
    });

    // 流動性線
    if(smc?.liquidity){
      smc.liquidity.slice(0,3).forEach(liq=>{
        ctx.strokeStyle=liq.type==="high"?"#ff980088":"#9c27b088";
        ctx.lineWidth=1; ctx.setLineDash([4,3]);
        ctx.beginPath(); ctx.moveTo(0,toY(liq.price)); ctx.lineTo(W,toY(liq.price)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle=liq.type==="high"?"#ff9800":"#9c27b0";
        ctx.font="8px monospace"; ctx.fillText("LIQ",W-28,toY(liq.price)-2);
      });
    }

    // BOS 線
    if(smc?.bos){
      ctx.strokeStyle=smc.bos.color+"88"; ctx.lineWidth=1.5; ctx.setLineDash([6,3]);
      ctx.beginPath(); ctx.moveTo(0,toY(smc.bos.price)); ctx.lineTo(W,toY(smc.bos.price)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=smc.bos.color; ctx.font="9px monospace";
      ctx.fillText("BOS",4,toY(smc.bos.price)-3);
    }

    // 進場/止損/止盈線
    if(trade){
      const lines=[
        {v:trade.entryN, col:"#90a4ae", label:"進場"},
        {v:trade.stopLossN, col:"#ef5350", label:"SL"},
        {v:trade.tp1N, col:"#81c784", label:"TP1"},
        {v:trade.tp2N, col:"#4caf50", label:"TP2"},
        {v:trade.tp3N, col:"#2e7d32", label:"TP3"},
      ].filter(l=>l.v);
      lines.forEach(l=>{
        ctx.strokeStyle=l.col+"99"; ctx.lineWidth=1; ctx.setLineDash([5,3]);
        ctx.beginPath(); ctx.moveTo(0,toY(l.v)); ctx.lineTo(W,toY(l.v)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle=l.col; ctx.font="bold 9px monospace";
        ctx.fillText(l.label,W-28,toY(l.v)-3);
      });
    }

    // 最新收盤價線
    const lastC=display[display.length-1];
    ctx.strokeStyle="#90a4ae44"; ctx.lineWidth=0.5; ctx.setLineDash([2,2]);
    ctx.beginPath(); ctx.moveTo(0,toY(lastC.c)); ctx.lineTo(W,toY(lastC.c)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle="#90a4ae"; ctx.font="9px monospace";
    ctx.fillText(lastC.c>=1000?lastC.c.toFixed(2):lastC.c>=1?lastC.c.toFixed(4):lastC.c.toFixed(6),2,toY(lastC.c)-3);

  },[candles, ma30arr, ma45arr, ma60arr, bb, trade, smc, height]);

  return (
    <canvas ref={canvasRef} width={700} height={height}
      style={{width:"100%",height:height,borderRadius:6,background:"#060c1a",
        border:"1px solid #1a2035",display:"block"}}/>
  );
}

// ══════════════════════════════════════════════════════════════════
// 量價分析
// ══════════════════════════════════════════════════════════════════
function volPriceTrend(candles) {
  const obv=calcOBV(candles), l=obv.length;
  const obvS5=l>=5?obv.slice(-5).reduce((a,b)=>a+b,0)/5:null;
  const obvS20=l>=20?obv.slice(-20).reduce((a,b)=>a+b,0)/20:null;
  const obvUp=obvS5!=null&&obvS20!=null?obvS5>obvS20:null;
  const vols=candles.map(c=>c.v), closes=candles.map(c=>c.c);
  const vol20avg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const vr=vol20avg?vols[vols.length-1]/vol20avg:1;
  const slope=closes.length>=20?(closes[closes.length-1]-closes[closes.length-20])/closes[closes.length-20]:0;

  let bull=0,bear=0; const reasons=[];
  if(obvUp===true){bull+=3;reasons.push({type:"bull",text:"OBV上升，資金淨流入"});}
  if(obvUp===false){bear+=3;reasons.push({type:"bear",text:"OBV下降，資金流出"});}
  const r5=candles.slice(-5); let puvu=0,puvd=0,pdvd=0,pdvu=0;
  for(let i=1;i<r5.length;i++){
    const pu=r5[i].c>r5[i-1].c,vu=r5[i].v>r5[i-1].v;
    if(pu&&vu)puvu++;else if(pu&&!vu)puvd++;else if(!pu&&vu)pdvu++;else pdvd++;
  }
  if(puvu>=2){bull+=2;reasons.push({type:"bull",text:`${puvu}根價漲量增`});}
  if(pdvd>=2){bull+=1;reasons.push({type:"bull",text:`下跌量縮（${pdvd}根）`});}
  if(puvd>=2){bear+=2;reasons.push({type:"bear",text:`${puvd}根價漲量縮`});}
  if(pdvu>=2){bear+=2;reasons.push({type:"bear",text:`${pdvu}根下跌放量`});}
  if(vr>2&&slope>0){bull+=2;reasons.push({type:"bull",text:`量比${vr.toFixed(1)}x放量上攻`});}
  else if(vr>2&&slope<0){bear+=2;reasons.push({type:"bear",text:`量比${vr.toFixed(1)}x放量下跌`});}

  const verdict=bull>bear+2?"偏多":bear>bull+2?"偏空":bull>bear?"略偏多":bear>bull?"略偏空":"中性";
  const verdictColor=verdict==="偏多"?"#4caf50":verdict==="偏空"?"#ef5350":
    verdict==="略偏多"?"#8bc34a":verdict==="略偏空"?"#ff7043":"#90a4ae";
  const verdictBg=verdict.includes("多")?"#1b5e2022":verdict.includes("空")?"#b71c1c22":"#1a2035";
  const verdictIcon=verdict==="偏多"?"▲":verdict==="偏空"?"▼":verdict==="略偏多"?"△":verdict==="略偏空"?"▽":"◆";
  return {verdict,verdictColor,verdictBg,verdictIcon,bullScore:bull,bearScore:bear,
    obvTrend:obvUp===true?"up":obvUp===false?"down":null,volRatioVal:vr?.toFixed(2),reasons};
}

// ══════════════════════════════════════════════════════════════════
// 10項評分
// ══════════════════════════════════════════════════════════════════
function scoreSymbol(candles,ma30,ma45,ma60) {
  const closes=candles.map(c=>c.c), vols=candles.map(c=>c.v), last=closes[closes.length-1];
  const aboveAll=last>ma30&&last>ma45&&last>ma60, maFan=ma30>ma45&&ma45>ma60;
  let score=0; const signals=[];

  // 1. 均線 20pt
  if(aboveAll){score+=20;signals.push({key:"ma",label:"①均線排列",w:20,s:20,ok:true,detail:`站上MA30/45/60${maFan?"，多頭✨":""}`});}
  else{signals.push({key:"ma",label:"①均線排列",w:20,s:0,ok:false,detail:"未站上三均線"});}

  // 2. 縮量 12pt
  const vol10avg=vols.slice(-11,-1).reduce((a,b)=>a+b,0)/10;
  const shrinkPct=vol10avg?(vol10avg-vols[vols.length-1])/vol10avg:0;
  const sp=(shrinkPct*100).toFixed(1);
  if(shrinkPct>0.25){score+=12;signals.push({key:"vol",label:"②縮量",w:12,s:12,ok:true,detail:`量縮${sp}%`});}
  else if(shrinkPct>0.1){score+=6;signals.push({key:"vol",label:"②縮量",w:12,s:6,ok:"warn",detail:`略縮${sp}%`});}
  else{signals.push({key:"vol",label:"②縮量",w:12,s:0,ok:false,detail:`無萎縮（${sp}%）`});}

  // 3. BB 12pt
  const bb=bollingerBands(closes,20);
  if(bb){
    const bp=(bb.width*100).toFixed(2);
    if(bb.width<0.04){score+=12;signals.push({key:"bb",label:"③BB Squeeze",w:12,s:12,ok:true,detail:`帶寬${bp}%`});}
    else if(bb.width<0.07){score+=6;signals.push({key:"bb",label:"③BB收窄",w:12,s:6,ok:"warn",detail:`帶寬${bp}%`});}
    else{signals.push({key:"bb",label:"③BB收窄",w:12,s:0,ok:false,detail:`帶寬${bp}%`});}
  }

  // 4. RSI 10pt
  const rsi=rsiCalc(closes);
  if(rsi!=null){
    const r=rsi.toFixed(1);
    if(rsi>=45&&rsi<=62){score+=10;signals.push({key:"rsi",label:"④RSI蓄力",w:10,s:10,ok:true,detail:`RSI ${r}`});}
    else if(rsi>62&&rsi<70){score+=5;signals.push({key:"rsi",label:"④RSI偏強",w:10,s:5,ok:"warn",detail:`RSI ${r}`});}
    else if(rsi>30&&rsi<45){score+=4;signals.push({key:"rsi",label:"④RSI偏弱",w:10,s:4,ok:"warn",detail:`RSI ${r}`});}
    else{signals.push({key:"rsi",label:"④RSI",w:10,s:0,ok:false,detail:`RSI ${r}`});}
  }

  // 5. 橫盤 10pt
  const sl10=candles.slice(-10),hi10=Math.max(...sl10.map(c=>c.h)),lo10=Math.min(...sl10.map(c=>c.l));
  const prPct=lo10?(hi10-lo10)/lo10:1;
  const pp=(prPct*100).toFixed(2);
  if(prPct<0.04){score+=10;signals.push({key:"range",label:"⑤橫盤",w:10,s:10,ok:true,detail:`幅度${pp}%`});}
  else if(prPct<0.07){score+=5;signals.push({key:"range",label:"⑤橫盤",w:10,s:5,ok:"warn",detail:`幅度${pp}%`});}
  else{signals.push({key:"range",label:"⑤橫盤",w:10,s:0,ok:false,detail:`幅度${pp}%`});}

  // 6. MACD 8pt
  const macdR=macdCalc(closes);
  if(macdR){
    if(macdR.line>0&&macdR.prev<0){score+=8;signals.push({key:"macd",label:"⑥MACD金叉",w:8,s:8,ok:true,detail:"穿越零軸"});}
    else if(macdR.line>0){score+=5;signals.push({key:"macd",label:"⑥MACD偏多",w:8,s:5,ok:"warn",detail:`${macdR.line.toFixed(4)}`});}
    else{signals.push({key:"macd",label:"⑥MACD偏空",w:8,s:0,ok:false,detail:`${macdR.line.toFixed(4)}`});}
  }

  // 7. StochRSI 8pt
  const stoch=stochRsi(closes);
  if(stoch!=null){
    const s=stoch.toFixed(1);
    if(stoch<20){score+=8;signals.push({key:"stoch",label:"⑦StochRSI超賣",w:8,s:8,ok:true,detail:`${s}`});}
    else if(stoch<40){score+=5;signals.push({key:"stoch",label:"⑦StochRSI偏低",w:8,s:5,ok:"warn",detail:`${s}`});}
    else if(stoch>80){signals.push({key:"stoch",label:"⑦StochRSI超買",w:8,s:0,ok:false,detail:`${s}`});}
    else{score+=3;signals.push({key:"stoch",label:"⑦StochRSI中性",w:8,s:3,ok:"warn",detail:`${s}`});}
  }

  // 8. ATR 8pt
  const atrNow=atrCalc(candles);
  if(atrNow&&last>0){
    const ap=(atrNow/last*100).toFixed(2);
    if(atrNow/last<0.02){score+=8;signals.push({key:"atr",label:"⑧ATR極低",w:8,s:8,ok:true,detail:`${ap}%`});}
    else if(atrNow/last<0.04){score+=4;signals.push({key:"atr",label:"⑧ATR收縮",w:8,s:4,ok:"warn",detail:`${ap}%`});}
    else{signals.push({key:"atr",label:"⑧ATR偏高",w:8,s:0,ok:false,detail:`${ap}%`});}
  }

  // 9. EMA 6pt
  const e9=ema(closes,9),e21=ema(closes,21),e9p=ema(closes.slice(0,-1),9),e21p=ema(closes.slice(0,-1),21);
  if(e9&&e21){
    if(e9>e21&&e9p&&e9p<=e21p){score+=6;signals.push({key:"ema",label:"⑨EMA金叉",w:6,s:6,ok:true,detail:"EMA9穿EMA21"});}
    else if(e9>e21){score+=4;signals.push({key:"ema",label:"⑨EMA多頭",w:6,s:4,ok:"warn",detail:"9>21"});}
    else{signals.push({key:"ema",label:"⑨EMA空頭",w:6,s:0,ok:false,detail:"9<21"});}
  }

  // 10. OBV 6pt
  const obvArr=calcOBV(candles);
  const oS5=obvArr.slice(-5).reduce((a,b)=>a+b,0)/5,oS20=obvArr.slice(-20).reduce((a,b)=>a+b,0)/20;
  if(oS5>oS20*1.02){score+=6;signals.push({key:"obv",label:"⑩OBV上升",w:6,s:6,ok:true,detail:"資金淨流入"});}
  else if(oS5>oS20){score+=3;signals.push({key:"obv",label:"⑩OBV略升",w:6,s:3,ok:"warn",detail:"小幅流入"});}
  else{signals.push({key:"obv",label:"⑩OBV下降",w:6,s:0,ok:false,detail:"資金流出"});}

  const isEntry=score>=70&&aboveAll&&shrinkPct>0.1&&(bb&&bb.width<0.07)&&(rsi&&rsi>=40&&rsi<=65);
  return {score,signals,aboveAll,maFan,isEntry,atrNow,rsi,shrinkPct,bb,candles};
}

// ══════════════════════════════════════════════════════════════════
// 進場點位計算
// ══════════════════════════════════════════════════════════════════
function calcTradeSetup(candles,last,atrNow,ma30,ma45,ma60,score) {
  if(!atrNow||!last) return null;
  const recent=candles.slice(-30);
  const pivotHi=Math.max(...recent.map(c=>c.h)), pivotLo=Math.min(...recent.map(c=>c.l));
  const recentLo5=Math.min(...candles.slice(-5).map(c=>c.l));
  const confidence=score>=85?3.0:score>=70?2.0:1.5;
  const entry=last, entryLimit=Math.max(ma30,last*0.998);
  const sl=Math.max(recentLo5-atrNow*0.5, ma45-atrNow*0.8, last*0.97);
  const risk=entry-sl;
  const tp1=entry+risk*1.5, tp2=entry+risk*confidence;
  const tp3=Math.min(pivotHi*1.002,entry+risk*(confidence+1.5));
  const fmt=n=>n>=1000?n.toFixed(2):n>=10?n.toFixed(3):n>=1?n.toFixed(4):n.toFixed(6);
  return {
    strategy: score>=85?"突破追多":score>=70?"回踩做多":"輕倉試多",
    entryIdeal:fmt(entry), entryLimit:fmt(entryLimit),
    stopLoss:fmt(sl), slPct:((sl-entry)/entry*100).toFixed(2),
    tp1:fmt(tp1), tp1Pct:((tp1-entry)/entry*100).toFixed(2),
    tp2:fmt(tp2), tp2Pct:((tp2-entry)/entry*100).toFixed(2),
    tp3:fmt(tp3), tp3Pct:((tp3-entry)/entry*100).toFixed(2),
    rr:confidence.toFixed(1), pivotHi:fmt(pivotHi), pivotLo:fmt(pivotLo),
    positionPct:score>=85?"5–8%":score>=70?"3–5%":"1–3%",
    // raw values for chart
    entryN:entry, stopLossN:sl, tp1N:tp1, tp2N:tp2, tp3N:tp3,
  };
}

// ══════════════════════════════════════════════════════════════════
// 暴漲/暴跌偵測
// ══════════════════════════════════════════════════════════════════
function detectSurge(candles,last,ma30,ma45,fr) {
  const closes=candles.map(c=>c.c), vols=candles.map(c=>c.v), highs=candles.map(c=>c.h);
  const obv=calcOBV(candles); const obvNow=obv[obv.length-1], obvPrev=obv[obv.length-6]||0;
  const obvSurge=obvPrev!==0?(obvNow-obvPrev)/Math.abs(obvPrev):0;
  const vol20avg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const vr=vol20avg?vols[vols.length-1]/vol20avg:1;
  const hi30=Math.max(...highs.slice(-30));
  const breakout=last>=hi30*0.998;
  const bw=bollingerBands(closes,20)?.width;
  const bwPrev=bollingerBands(closes.slice(0,-3),20)?.width;
  const squeezeBreak=bw&&bwPrev&&bwPrev<0.05&&bw>bwPrev*1.3&&vr>2;
  const rsiNow=rsiCalc(closes), rsiPrev=rsiCalc(closes.slice(0,-3));
  const rsiSurge=rsiNow&&rsiPrev&&rsiNow-rsiPrev>15&&rsiNow>50;
  const slope=closes.length>=6?(last-closes[closes.length-6])/closes[closes.length-6]:0;

  const reasons=[]; let s=0;
  if(vr>3){s+=3;reasons.push(`量比${vr.toFixed(1)}x異常爆量`);}
  else if(vr>2){s+=1;reasons.push(`量比${vr.toFixed(1)}x放量`);}
  if(obvSurge>0.3){s+=2;reasons.push(`OBV急升${(obvSurge*100).toFixed(0)}%`);}
  if(breakout){s+=3;reasons.push(`突破30日高點${hi30.toFixed(4)}`);}
  if(squeezeBreak){s+=3;reasons.push("BB Squeeze後爆量突破");}
  if(rsiSurge){s+=2;reasons.push(`RSI急升+${(rsiNow-rsiPrev).toFixed(0)}pt`);}
  if(slope>0.05){s+=2;reasons.push(`近5根漲${(slope*100).toFixed(1)}%`);}
  return {isSurge:s>=5, surgeScore:s,
    surgeStrength:s>=8?"🚀🚀 極強爆漲":s>=5?"🚀 暴漲預警":"", surgeReasons:reasons};
}

function detectCrash(candles,last,ma30,ma45,fr) {
  const closes=candles.map(c=>c.c), vols=candles.map(c=>c.v);
  const highs=candles.map(c=>c.h), lows=candles.map(c=>c.l);
  const obv=calcOBV(candles);
  const hi10=Math.max(...highs.slice(-10)),hi20=Math.max(...highs.slice(-20,-10));
  const obvHi10=Math.max(...obv.slice(-10)),obvHi20=Math.max(...obv.slice(-20,-10));
  const obvDiverg=hi10>hi20&&obvHi10<obvHi20;
  const vol20avg=vols.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const vr=vol20avg?vols[vols.length-1]/vol20avg:1;
  const lastC=candles[candles.length-1];
  const uShadow=lastC.h-Math.max(lastC.o,lastC.c);
  const body=Math.abs(lastC.c-lastC.o);
  const longUpper=uShadow>body*2&&uShadow/lastC.h>0.02;
  const rsiNow=rsiCalc(closes); const shrink=vol20avg?(vol20avg-vols[vols.length-1])/vol20avg:0;
  const rsiOB=rsiNow&&rsiNow>75&&shrink>0.2;
  const maBelowBreak=closes[closes.length-2]>ma30&&last<ma30;
  const slope=closes.length>=6?(last-closes[closes.length-6])/closes[closes.length-6]:0;
  const frOverheat=fr&&fr>0.08;

  const reasons=[]; let s=0;
  if(obvDiverg){s+=3;reasons.push("OBV頂背離，資金偷跑");}
  if(longUpper){s+=3;reasons.push("高位長上影線，拉高出貨");}
  if(rsiOB){s+=3;reasons.push(`RSI超買${rsiNow?.toFixed(0)}+量縮`);}
  if(maBelowBreak){s+=2;reasons.push("跌破MA30，趨勢轉弱");}
  if(vr>2&&slope<0){s+=3;reasons.push(`放量${vr.toFixed(1)}x下跌`);}
  if(frOverheat){s+=2;reasons.push(`資金費率${fr?.toFixed(4)}%過熱`);}
  if(slope<-0.05){s+=2;reasons.push(`近5根跌${(Math.abs(slope)*100).toFixed(1)}%`);}
  return {isCrash:s>=5, crashScore:s,
    crashStrength:s>=8?"💥💥 極危":s>=5?"💥 暴跌預警":"", crashReasons:reasons};
}

// ══════════════════════════════════════════════════════════════════
// 主分析函式
// ══════════════════════════════════════════════════════════════════
async function analyseSymbol(symbol,interval) {
  const [klRes,frRes,oiRes]=await Promise.allSettled([
    fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=120`).then(r=>r.json()),
    fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`).then(r=>r.json()),
    fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`).then(r=>r.json()),
  ]);
  if(klRes.status!=="fulfilled"||!Array.isArray(klRes.value)||klRes.value.length<65) return null;
  const candles=klRes.value.map(k=>({o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
  const closes=candles.map(c=>c.c), last=closes[closes.length-1];
  const ma30=sma(closes,30),ma45=sma(closes,45),ma60=sma(closes,60);
  if(!ma30||!ma45||!ma60) return null;

  // 計算MA陣列（用於K線圖）
  const ma30arr=closes.map((_,i)=>i<29?null:sma(closes.slice(0,i+1),30));
  const ma45arr=closes.map((_,i)=>i<44?null:sma(closes.slice(0,i+1),45));
  const ma60arr=closes.map((_,i)=>i<59?null:sma(closes.slice(0,i+1),60));

  const {score,signals,aboveAll,maFan,isEntry,atrNow}=scoreSymbol(candles,ma30,ma45,ma60);
  const vpt  = volPriceTrend(candles);
  const bb   = bollingerBands(closes,20);
  const trade= isEntry?calcTradeSetup(candles,last,atrNow,ma30,ma45,ma60,score):null;
  const smc  = detectSMC(candles);

  let frVal=null;
  try{if(frRes.status==="fulfilled"&&Array.isArray(frRes.value)&&frRes.value[0])
    frVal=parseFloat(frRes.value[0].fundingRate)*100;}catch(_){}

  const surge=detectSurge(candles,last,ma30,ma45,frVal);
  const crash=detectCrash(candles,last,ma30,ma45,frVal);

  const extras=[];
  if(frVal!=null) extras.push({label:"資金費率",value:`${frVal.toFixed(4)}%`,
    note:frVal>0.01?"正費率偏熱":frVal<-0.01?"負費率潛在軋空":"中性",
    color:frVal>0.05?"#ef5350":frVal<-0.01?"#ff9500":"#4dd0e1"});
  try{if(oiRes.status==="fulfilled"&&oiRes.value?.openInterest){
    const oi=parseFloat(oiRes.value.openInterest);
    extras.push({label:"未平倉量",value:oi>1e9?`${(oi/1e9).toFixed(2)}B`:`${(oi/1e6).toFixed(1)}M`,note:"USDT",color:"#9fa8da"});
  }}catch(_){}

  const gradeColor=score>=85?"#ff4d4d":score>=70?"#ff9500":score>=50?"#f5c518":"#455a64";
  const grade=score>=85?"🔥 極強":score>=70?"⚡ 強訊號":score>=50?"👀 留意":"😴 觀察";

  return {symbol,score,grade,gradeColor,price:last.toFixed(4),
    ma30:ma30.toFixed(4),ma45:ma45.toFixed(4),ma60:ma60.toFixed(4),
    aboveAll,maFan,isEntry,signals,extras,vpt,trade,surge,crash,smc,
    candles,ma30arr,ma45arr,ma60arr,bb,news:[]};
}

async function getTopSymbols(limit=100) {
  const res=await fetch(`${FAPI}/fapi/v1/ticker/24hr`);
  const data=await res.json();
  return data.filter(d=>d.symbol.endsWith("USDT")&&!d.symbol.includes("_"))
    .sort((a,b)=>parseFloat(b.quoteVolume)-parseFloat(a.quoteVolume))
    .slice(0,limit).map(d=>d.symbol);
}

async function fetchNews(symbol) {
  const coin=symbol.replace("USDT","").toLowerCase();
  try{
    const res=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:500,
        tools:[{type:"web_search_20250305",name:"web_search"}],
        messages:[{role:"user",content:`搜尋 ${symbol} 最新24小時加密貨幣新聞，繁體中文，最多3條一句話，格式：["消息1","消息2","消息3"]，只回傳JSON`}]})
    });
    const data=await res.json();
    const text=data.content?.filter(b=>b.type==="text").map(b=>b.text).join("")||"[]";
    const arr=JSON.parse(text.replace(/```json|```/g,"").trim());
    return Array.isArray(arr)?arr.slice(0,3):[];
  }catch{return[];}
}

const GRADE_ORDER={"🔥 極強":0,"⚡ 強訊號":1,"👀 留意":2,"😴 觀察":3};

// ══════════════════════════════════════════════════════════════════
// 彈窗通知
// ══════════════════════════════════════════════════════════════════
function EntryAlert({alerts,onDismiss}) {
  if(!alerts.length) return null;
  return(
    <div style={{position:"fixed",top:20,right:20,zIndex:9999,display:"flex",
      flexDirection:"column",gap:10,maxWidth:340}}>
      {alerts.map((a,i)=>{
        const isSurge=a.alertType==="surge",isCrash=a.alertType==="crash";
        const bc=isCrash?"#ef5350":isSurge?"#ff9800":"#4caf50";
        const bg=isCrash?"linear-gradient(135deg,#1a0505,#1a0a00)":
                 isSurge?"linear-gradient(135deg,#1a1000,#1a1500)":
                         "linear-gradient(135deg,#0d2137,#0d2820)";
        const title=isCrash?"💥 暴跌預警":isSurge?"🚀 暴漲預警":"🚀 進場訊號";
        const reasons=isCrash?a.crash?.crashReasons:isSurge?a.surge?.surgeReasons:null;
        return(
          <div key={a.symbol+i} style={{background:bg,border:`1px solid ${bc}`,
            borderRadius:12,padding:"12px 14px",
            boxShadow:`0 8px 24px #00000088,0 0 16px ${bc}44`,animation:"slideIn .3s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:10,color:bc,letterSpacing:2,marginBottom:3}}>{title}</div>
                <div style={{fontSize:16,fontWeight:800,color:"#e8eaf6",marginBottom:5}}>
                  {a.symbol.replace("USDT","")}
                  {a.smc&&<span style={{fontSize:10,color:a.smc.smcColor,marginLeft:8}}>{a.smc.smcVerdict}</span>}
                </div>
                {reasons&&reasons.slice(0,2).map((r,j)=>(
                  <div key={j} style={{fontSize:10,color:"#546e7a",marginBottom:2}}>
                    {isCrash?"▼":"▲"} {r}
                  </div>
                ))}
                {!isSurge&&!isCrash&&a.trade&&(
                  <div style={{background:"#060c1a",borderRadius:5,padding:"6px 8px",
                    border:`1px solid ${bc}33`,fontSize:10,marginTop:6}}>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      <span>📍<b style={{color:"#e8eaf6"}}>{a.trade.entryIdeal}</b></span>
                      <span>🛑<b style={{color:"#ef5350"}}>{a.trade.stopLoss}</b>({a.trade.slPct}%)</span>
                      <span>🎯<b style={{color:"#4caf50"}}>{a.trade.tp1}</b>(+{a.trade.tp1Pct}%)</span>
                    </div>
                    <div style={{color:"#455a64",marginTop:3}}>風報比 1:{a.trade.rr}</div>
                  </div>
                )}
              </div>
              <button onClick={()=>onDismiss(i)}
                style={{background:"none",border:"none",color:"#37474f",cursor:"pointer",fontSize:15}}>✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 新聞面板
// ══════════════════════════════════════════════════════════════════
function NewsPanel({symbol,news,loading,onClose}) {
  return(
    <div style={{position:"fixed",top:0,right:0,width:360,height:"100vh",
      background:"#0b0f1c",borderLeft:"1px solid #1a2035",zIndex:1000,
      display:"flex",flexDirection:"column",boxShadow:"-8px 0 32px #00000099"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #1a2035",
        display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:9,color:"#ff9800",letterSpacing:2,marginBottom:3}}>LATEST NEWS</div>
          <div style={{fontSize:14,fontWeight:700,color:"#e8eaf6"}}>{symbol?.replace("USDT","")} 最新消息</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#546e7a",cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"14px 16px"}}>
        {loading?<div style={{color:"#37474f",fontSize:12,textAlign:"center",marginTop:40}}>🔍 搜尋中…</div>
        :news?.length?news.map((n,i)=>(
          <div key={i} style={{background:"#060c1a",borderRadius:7,padding:"10px 12px",
            marginBottom:8,border:"1px solid #1a2035"}}>
            <div style={{fontSize:9,color:"#37474f",marginBottom:4}}>#{i+1}</div>
            <div style={{fontSize:11,color:"#90a4ae",lineHeight:1.7}}>{n}</div>
          </div>
        )):<div style={{color:"#37474f",fontSize:12,textAlign:"center",marginTop:40}}>暫無消息</div>}
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
  const abortRef=useRef(false), firstLoad=useRef(true);
  const timerRef=useRef(null), seenAlerts=useRef(new Set());

  const runScan=useCallback(async(iv=interval,scanMode=mode,syms=customSyms)=>{
    abortRef.current=false; setLoading(true); setError(null); setResults([]);
    try{
      let symList=scanMode==="top100"?await getTopSymbols(100):
        syms.split(/[,\s]+/).map(s=>s.trim().toUpperCase()).filter(Boolean);
      setProgress({done:0,total:symList.length});
      const newAlerts=[],out=[];
      for(let i=0;i<symList.length;i+=10){
        if(abortRef.current) break;
        const batch=symList.slice(i,i+10);
        const res=await Promise.all(batch.map(s=>analyseSymbol(s,iv)));
        res.forEach(r=>{
          if(!r) return; out.push(r);
          if(r.isEntry&&!seenAlerts.current.has(r.symbol+iv+"e")){
            seenAlerts.current.add(r.symbol+iv+"e");
            newAlerts.push({...r,alertType:"entry"});
            if(Notification.permission==="granted")
              new Notification(`🚀 進場：${r.symbol.replace("USDT","")}`,{body:`評分${r.score} · ${r.smc?.smcVerdict||""}`,icon:"/icon-192.png"});
          }
          if(r.surge?.isSurge&&!seenAlerts.current.has(r.symbol+iv+"s")){
            seenAlerts.current.add(r.symbol+iv+"s");
            newAlerts.push({...r,alertType:"surge"});
            if(Notification.permission==="granted")
              new Notification(`🚀 暴漲：${r.symbol.replace("USDT","")}`,{body:r.surge.surgeReasons[0]||"",icon:"/icon-192.png"});
          }
          if(r.crash?.isCrash&&!seenAlerts.current.has(r.symbol+iv+"c")){
            seenAlerts.current.add(r.symbol+iv+"c");
            newAlerts.push({...r,alertType:"crash"});
            if(Notification.permission==="granted")
              new Notification(`💥 暴跌：${r.symbol.replace("USDT","")}`,{body:r.crash.crashReasons[0]||"",icon:"/icon-192.png"});
          }
        });
        if(newAlerts.length){setAlerts(prev=>[...prev,...newAlerts.splice(0)]);}
        setProgress({done:Math.min(i+10,symList.length),total:symList.length});
        setResults([...out].sort((a,b)=>b.score-a.score));
        await new Promise(r=>setTimeout(r,150));
      }
      setLastScan(new Date().toLocaleTimeString("zh-TW"));
    }catch(e){setError(e.message);}finally{setLoading(false);}
  },[]);

  useEffect(()=>{
    if(firstLoad.current){firstLoad.current=false;
      if(Notification.permission==="default") Notification.requestPermission();
      runScan();}
  },[runScan]);

  useEffect(()=>{
    if(autoRefresh){timerRef.current=setInterval(()=>runScan(),5*60*1000);}
    else clearInterval(timerRef.current);
    return()=>clearInterval(timerRef.current);
  },[autoRefresh,runScan]);

  async function openNews(sym){
    setNewsSymbol(sym);setNewsLoading(true);setNewsData([]);
    const n=await fetchNews(sym);setNewsData(n);setNewsLoading(false);
  }

  const filtered=results.filter(r=>{
    if(filter==="strong") return r.score>=70;
    if(filter==="entry")  return r.isEntry;
    if(filter==="surge")  return r.surge?.isSurge;
    if(filter==="crash")  return r.crash?.isCrash;
    if(filter==="above")  return r.aboveAll;
    if(filter==="smc")    return r.smc?.smcBias>=2;
    return true;
  }).sort((a,b)=>{
    if(sortKey==="score")  return b.score-a.score;
    if(sortKey==="grade")  return (GRADE_ORDER[a.grade]??9)-(GRADE_ORDER[b.grade]??9);
    if(sortKey==="symbol") return a.symbol.localeCompare(b.symbol);
    if(sortKey==="smc")    return (b.smc?.smcBias||0)-(a.smc?.smcBias||0);
    return 0;
  });

  const okIcon=ok=>ok===true?"✅":ok==="warn"?"⚠️":"❌";
  const pct=progress.total?Math.round(progress.done/progress.total*100):0;
  const entryCount=results.filter(r=>r.isEntry).length;
  const surgeCount=results.filter(r=>r.surge?.isSurge).length;
  const crashCount=results.filter(r=>r.crash?.isCrash).length;
  const smcBullCount=results.filter(r=>r.smc?.smcBias>=2).length;

  const C={
    sidebar:{width:220,minWidth:220,background:"#0b0f1c",borderRight:"1px solid #0f1629",
      height:"100vh",overflowY:"auto",padding:"16px 14px",boxSizing:"border-box",
      display:"flex",flexDirection:"column",gap:14},
    main:{flex:1,overflowY:"auto",height:"100vh",background:"#07090f",padding:"14px 18px",boxSizing:"border-box"},
    sL:{fontSize:9,letterSpacing:3,color:"#1e3a5f",textTransform:"uppercase",marginBottom:7},
    ivB:(a)=>({width:"100%",padding:"7px 10px",borderRadius:5,textAlign:"left",marginBottom:3,
      border:`1px solid ${a?"#3949ab":"#0f1629"}`,background:a?"#1a2040":"transparent",
      color:a?"#9fa8da":"#37474f",cursor:"pointer",fontSize:11,fontFamily:"inherit"}),
    mB:(a)=>({width:"100%",padding:"7px 10px",borderRadius:5,textAlign:"left",marginBottom:3,
      border:`1px solid ${a?"#00897b":"#0f1629"}`,background:a?"#00695c22":"transparent",
      color:a?"#4dd0e1":"#37474f",cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:600}),
    sBtn:{width:"100%",padding:"9px",borderRadius:6,border:"none",
      background:"linear-gradient(135deg,#283593,#00695c)",
      color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"},
    fB:(a,col)=>({padding:"4px 9px",borderRadius:4,fontSize:10,fontFamily:"inherit",cursor:"pointer",
      border:`1px solid ${a?(col||"#3949ab"):"#1a2035"}`,
      background:a?(col?col+"22":"#1a2040"):"transparent",
      color:a?(col||"#9fa8da"):(col?col+"88":"#37474f")}),
    card:(score,open,surge,crash)=>({background:open?"#0f1729":"#0c111e",borderRadius:7,marginBottom:4,
      cursor:"pointer",overflow:"hidden",
      border:`1px solid ${crash?.isCrash?"#ef535044":surge?.isSurge?"#ff980044":score>=85?"#3949ab":score>=70?"#2e3a5e":score>=50?"#1c2d35":"#111827"}`,
      boxShadow:open?"0 0 0 1px #3949ab44":crash?.isCrash?"0 0 10px #ef535022":surge?.isSurge?"0 0 10px #ff980022":score>=85?"0 0 14px #3949ab33":"none"}),
  };

  return(
    <div style={{display:"flex",height:"100vh",overflow:"hidden",
      fontFamily:"'SF Mono','Fira Code',ui-monospace,monospace",color:"#dde1f0"}}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#07090f}
        ::-webkit-scrollbar-thumb{background:#1a2035;border-radius:2px} *{box-sizing:border-box}
      `}</style>

      <EntryAlert alerts={alerts} onDismiss={i=>setAlerts(prev=>prev.filter((_,j)=>j!==i))}/>
      {newsSymbol&&<NewsPanel symbol={newsSymbol} news={newsData} loading={newsLoading} onClose={()=>setNewsSymbol(null)}/>}

      {/* 左側欄 */}
      <div style={C.sidebar}>
        <div>
          <div style={{fontSize:9,letterSpacing:4,color:"#3d5afe",textTransform:"uppercase",marginBottom:4}}>FUTURES SCANNER</div>
          <div style={{fontSize:13,fontWeight:800,lineHeight:1.3,
            background:"linear-gradient(90deg,#7986cb,#4dd0e1)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
            合約爆發偵測器
          </div>
          <div style={{fontSize:8,color:"#263238",marginTop:2}}>10項評分·SMC·K線·量價·即時新聞</div>
        </div>

        <div>
          <div style={C.sL}>掃描模式</div>
          <button style={C.mB(mode==="top100")} onClick={()=>{setMode("top100");setShowCustom(false);runScan(interval,"top100",customSyms);}}>🏆 交易量前100名</button>
          <button style={C.mB(mode==="custom")} onClick={()=>{setMode("custom");setShowCustom(true);}}>✏️ 自訂幣種</button>
          {showCustom&&(
            <div style={{marginTop:5}}>
              <textarea value={customSyms} onChange={e=>setCustomSyms(e.target.value)}
                style={{width:"100%",height:65,background:"#060810",border:"1px solid #1a2035",
                  borderRadius:5,color:"#90a4ae",fontSize:10,padding:"5px 7px",fontFamily:"inherit",resize:"vertical"}}/>
              <button onClick={()=>runScan(interval,"custom",customSyms)} style={{...C.sBtn,marginTop:4,fontSize:10}}>套用掃描</button>
            </div>
          )}
        </div>

        <div>
          <div style={C.sL}>時間週期</div>
          {INTERVALS.map(iv=>(
            <button key={iv.value} style={C.ivB(interval===iv.value)}
              onClick={()=>{setIntervalVal(iv.value);runScan(iv.value,mode,customSyms);}}>{iv.label}</button>
          ))}
        </div>

        <button onClick={()=>runScan(interval,mode,customSyms)} disabled={loading} style={C.sBtn}>
          {loading?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
            <span style={{width:11,height:11,border:"2px solid #546e7a",borderTopColor:"#fff",
              borderRadius:"50%",display:"inline-block",animation:"spin 1s linear infinite"}}/>
            {progress.total>0?`${progress.done}/${progress.total}`:"準備中…"}
          </span>:"🔄 重新掃描"}
        </button>

        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <span style={{fontSize:10,color:"#37474f"}}>每5分鐘自動掃描</span>
          <div onClick={()=>setAutoRefresh(!autoRefresh)}
            style={{width:34,height:18,borderRadius:9,background:autoRefresh?"#00897b":"#1a2035",cursor:"pointer",position:"relative"}}>
            <div style={{position:"absolute",top:2,left:autoRefresh?17:2,width:14,height:14,
              borderRadius:"50%",background:"#fff",transition:"left .2s"}}/>
          </div>
        </div>

        {loading&&progress.total>0&&(
          <div>
            <div style={{height:3,background:"#0f1629",borderRadius:2}}>
              <div style={{width:`${pct}%`,height:"100%",borderRadius:2,
                background:"linear-gradient(90deg,#283593,#00897b)",transition:"width .3s"}}/>
            </div>
            <div style={{fontSize:9,color:"#263238",marginTop:2,textAlign:"center"}}>{pct}%</div>
          </div>
        )}

        {results.length>0&&!loading&&(
          <div style={{background:"#060810",borderRadius:7,padding:"9px 11px",border:"1px solid #0f1629",fontSize:10}}>
            <div style={C.sL}>本次統計</div>
            {[["掃描",progress.total||results.length,"#7986cb"],
              ["有效",results.length,"#7986cb"],
              ["強訊號",results.filter(r=>r.score>=70).length,"#7986cb"],
              ["🚀進場",entryCount,"#4caf50"],
              ["🚀暴漲",surgeCount,"#ff9800"],
              ["💥暴跌",crashCount,"#ef5350"],
              ["SMC多頭",smcBullCount,"#4dd0e1"],
            ].map(([k,v,col])=>(
              <div key={k} style={{display:"flex",justifyContent:"space-between",color:"#455a64",marginBottom:3}}>
                <span>{k}</span>
                <span style={{color:v>0?col:"#37474f",fontWeight:700}}>{v}</span>
              </div>
            ))}
            <div style={{color:"#263238",fontSize:9,marginTop:4}}>上次 {lastScan}</div>
          </div>
        )}

        {error&&<div style={{fontSize:10,borderRadius:5,padding:"7px 9px",
          background:"#1a0a0a",border:"1px solid #c62828",color:"#ef9a9a"}}>⚠️ {error}</div>}
        <div style={{fontSize:8,color:"#111827",marginTop:"auto"}}>直連幣安合約 · SMC分析</div>
      </div>

      {/* 主區 */}
      <div style={C.main}>
        {/* 篩選列 */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,flexWrap:"wrap",gap:5}}>
          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
            {[["all","全部",null],["entry","🚀進場","#4caf50"],["surge","🚀暴漲","#ff9800"],
              ["crash","💥暴跌","#ef5350"],["smc","SMC多頭","#4dd0e1"],["strong","強訊號≥70",null],
              ["above","站上三均",null]].map(([v,l,col])=>(
              <button key={v} onClick={()=>setFilter(v)} style={C.fB(filter===v,col)}>{l}</button>
            ))}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <span style={{fontSize:9,color:"#263238"}}>排序</span>
            {[["score","評分"],["smc","SMC"],["grade","等級"],["symbol","名稱"]].map(([k,l])=>(
              <button key={k} onClick={()=>setSortKey(k)} style={C.fB(sortKey===k)}>{l}</button>
            ))}
            <span style={{fontSize:9,color:"#263238",marginLeft:4}}>
              <span style={{color:"#7986cb"}}>{filtered.length}</span>/{results.length}
            </span>
          </div>
        </div>

        {/* 表頭 */}
        {filtered.length>0&&(
          <div style={{display:"grid",gridTemplateColumns:"26px 42px 1fr 88px 88px 88px 88px 60px 80px 22px",
            gap:"0 6px",padding:"0 6px 5px",fontSize:9,color:"#263238",letterSpacing:1,
            textTransform:"uppercase",borderBottom:"1px solid #0f1629",marginBottom:4}}>
            <span>#</span><span>分</span><span>幣種</span>
            <span>現價</span><span>MA30</span><span>MA45</span><span>MA60</span>
            <span>訊號</span><span>SMC</span><span></span>
          </div>
        )}

        {loading&&results.length===0&&(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"60vh",gap:14}}>
            <div style={{width:40,height:40,border:"3px solid #1a2035",borderTopColor:"#7986cb",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
            <div style={{color:"#37474f",fontSize:12}}>{progress.total>0?`掃描中 ${progress.done}/${progress.total}…`:"連線幣安中…"}</div>
          </div>
        )}

        {filtered.map((r,idx)=>(
          <div key={r.symbol} style={C.card(r.score,expanded===r.symbol,r.surge,r.crash)}>
            {/* 主列 */}
            <div style={{display:"grid",gridTemplateColumns:"26px 42px 1fr 88px 88px 88px 88px 60px 80px 22px",
              gap:"0 6px",padding:"7px 6px",alignItems:"center"}}
              onClick={()=>setExpanded(expanded===r.symbol?null:r.symbol)}>

              <span style={{color:"#1e293b",fontSize:9}}>#{idx+1}</span>

              {/* Score ring */}
              <div style={{position:"relative",width:38,height:38}}>
                <svg width="38" height="38" style={{transform:"rotate(-90deg)"}}>
                  <circle cx="19" cy="19" r="13" fill="none" stroke="#111827" strokeWidth="3"/>
                  <circle cx="19" cy="19" r="13" fill="none" stroke={r.gradeColor} strokeWidth="3"
                    strokeDasharray={`${(r.score/100)*81.7} 81.7`} strokeLinecap="round"/>
                </svg>
                <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:10,fontWeight:800,color:r.gradeColor}}>{r.score}</div>
              </div>

              {/* Symbol + badges */}
              <div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,fontWeight:700,color:"#e8eaf6"}}>{r.symbol.replace("USDT","")}</span>
                  <span style={{fontSize:8,color:"#263238"}}>/USDT</span>
                  <span style={{fontSize:8,color:r.gradeColor,background:`${r.gradeColor}18`,padding:"1px 4px",borderRadius:3}}>{r.grade}</span>
                  {r.isEntry&&<span style={{fontSize:8,color:"#4caf50",background:"#4caf5022",padding:"1px 4px",borderRadius:3,fontWeight:700}}>🚀進場</span>}
                  {r.surge?.isSurge&&<span style={{fontSize:8,color:"#ff9800",background:"#ff980022",padding:"1px 4px",borderRadius:3,fontWeight:700}}>🚀爆漲</span>}
                  {r.crash?.isCrash&&<span style={{fontSize:8,color:"#ef5350",background:"#ef535022",padding:"1px 4px",borderRadius:3,fontWeight:700}}>💥暴跌</span>}
                  {r.maFan&&<span style={{fontSize:8,color:"#4dd0e1",background:"#00695c18",padding:"1px 4px",borderRadius:3}}>多頭↑</span>}
                </div>
              </div>

              {[[r.price,"#90a4ae"],[r.ma30,"#7986cb"],[r.ma45,"#9575cd"],[r.ma60,"#26c6da"]].map(([v,c],i)=>(
                <span key={i} style={{fontSize:10,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</span>
              ))}

              {/* Signal dots */}
              <div style={{display:"flex",gap:2,flexWrap:"wrap"}}>
                {r.signals.slice(0,10).map(s=>(
                  <div key={s.key} title={s.label} style={{width:6,height:6,borderRadius:"50%",
                    background:s.ok===true?"#00897b":s.ok==="warn"?"#ff9500":"#1e293b"}}/>
                ))}
              </div>

              {/* SMC badge */}
              <span style={{fontSize:9,color:r.smc?.smcColor||"#37474f",
                background:r.smc?.smcBias>=2?"#4caf5018":r.smc?.smcBias<=-2?"#ef535018":"transparent",
                padding:"2px 5px",borderRadius:3,fontWeight:r.smc?.smcBias?700:400}}>
                {r.smc?.smcVerdict||"—"}
              </span>

              <span style={{color:"#263238",fontSize:10}}>{expanded===r.symbol?"▲":"▼"}</span>
            </div>

            {/* 展開：四欄 = K線 | 指標 | 量價+SMC | 點位+新聞 */}
            {expanded===r.symbol&&(
              <div style={{borderTop:"1px solid #0f1629",padding:"12px 14px"}}>

                {/* K線圖 */}
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:9,color:"#7986cb",letterSpacing:2,marginBottom:7}}>
                    K線圖 · MA · 布林帶 · SMC結構 · 進場點位
                  </div>
                  <KlineChart
                    candles={r.candles?.slice(-60)||[]}
                    ma30arr={r.ma30arr?.slice(-60)}
                    ma45arr={r.ma45arr?.slice(-60)}
                    ma60arr={r.ma60arr?.slice(-60)}
                    bb={r.bb}
                    trade={r.trade}
                    smc={r.smc}
                    height={260}
                  />
                  {/* 圖例 */}
                  <div style={{display:"flex",gap:12,marginTop:6,flexWrap:"wrap"}}>
                    {[["MA30","#7986cb"],["MA45","#9575cd"],["MA60","#26c6da"],
                      ["BB帶","#7986cb66"],["OB 訂單塊","#4caf5077"],
                      ["FVG 缺口","#4caf5044"],["BOS 結構","#4caf50"],
                      ["LIQ 流動性","#ff9800"],["SL 止損","#ef5350"],
                      ["TP 止盈","#4caf50"]].map(([l,c])=>(
                      <span key={l} style={{fontSize:9,color:c,display:"flex",alignItems:"center",gap:3}}>
                        <span style={{width:16,height:2,background:c,display:"inline-block"}}/>
                        {l}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 下方三欄 */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>

                  {/* 左：10項指標 */}
                  <div>
                    <div style={{fontSize:9,color:"#3d5afe",letterSpacing:2,marginBottom:8}}>10項評分指標</div>
                    {r.signals.map(s=>(
                      <div key={s.key} style={{display:"flex",gap:7,marginBottom:7}}>
                        <span style={{fontSize:12}}>{okIcon(s.ok)}</span>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                            <span style={{fontSize:10,fontWeight:700,
                              color:s.ok===true?"#4dd0e1":s.ok==="warn"?"#ffb74d":"#455a64"}}>{s.label}</span>
                            <span style={{fontSize:9,color:"#263238"}}>{s.s}/{s.w}pt</span>
                          </div>
                          <div style={{fontSize:10,color:"#546e7a"}}>{s.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 中：SMC + 量價 */}
                  <div>
                    {/* SMC */}
                    <div style={{fontSize:9,color:"#ff9800",letterSpacing:2,marginBottom:8}}>SMC 結構分析</div>
                    {r.smc&&(
                      <div style={{marginBottom:12}}>
                        <div style={{background:r.smc.smcBias>=2?"#1b5e2022":r.smc.smcBias<=-2?"#b71c1c22":"#1a2035",
                          borderRadius:7,padding:"8px 10px",border:`1px solid ${r.smc.smcColor}44`,marginBottom:8}}>
                          <div style={{fontSize:14,fontWeight:800,color:r.smc.smcColor}}>
                            {r.smc.smcVerdict}
                          </div>
                          <div style={{fontSize:9,color:"#37474f",marginTop:2}}>
                            多空偏向 {r.smc.smcBias>0?"+":""}{r.smc.smcBias}
                          </div>
                        </div>
                        {r.smc.smcReasons.map((rs,j)=>(
                          <div key={j} style={{display:"flex",gap:5,marginBottom:5}}>
                            <span style={{fontSize:10,color:rs.t==="bull"?"#4caf50":"#ef5350",minWidth:10}}>
                              {rs.t==="bull"?"▲":"▼"}
                            </span>
                            <span style={{fontSize:10,color:"#546e7a",lineHeight:1.5}}>{rs.s}</span>
                          </div>
                        ))}
                        {r.smc.bos&&<div style={{marginTop:6,fontSize:10,color:r.smc.bos.color}}>
                          📌 {r.smc.bos.label} @ {r.smc.bos.price.toFixed(4)}</div>}
                        {r.smc.choch&&<div style={{fontSize:10,color:r.smc.choch.color,marginTop:3}}>
                          🔄 {r.smc.choch.label}</div>}
                        {r.smc.liquidity.slice(0,2).map((liq,j)=>(
                          <div key={j} style={{fontSize:10,color:liq.color,marginTop:3}}>
                            💧 {liq.label} @ {liq.price.toFixed(4)}
                            <div style={{fontSize:9,color:"#37474f"}}>{liq.note}</div>
                          </div>
                        ))}
                        {r.surge?.isSurge&&(
                          <div style={{marginTop:8,background:"#1a1000",borderRadius:6,padding:"7px 9px",border:"1px solid #ff980033"}}>
                            <div style={{fontSize:9,color:"#ff9800",marginBottom:4}}>🚀 {r.surge.surgeStrength}</div>
                            {r.surge.surgeReasons.map((rs,j)=>(
                              <div key={j} style={{fontSize:10,color:"#546e7a",marginBottom:2}}>▲ {rs}</div>
                            ))}
                          </div>
                        )}
                        {r.crash?.isCrash&&(
                          <div style={{marginTop:6,background:"#1a0505",borderRadius:6,padding:"7px 9px",border:"1px solid #ef535033"}}>
                            <div style={{fontSize:9,color:"#ef5350",marginBottom:4}}>💥 {r.crash.crashStrength}</div>
                            {r.crash.crashReasons.map((rs,j)=>(
                              <div key={j} style={{fontSize:10,color:"#546e7a",marginBottom:2}}>▼ {rs}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {/* 量價 */}
                    {r.vpt&&(
                      <>
                        <div style={{fontSize:9,color:"#ff9800",letterSpacing:2,marginBottom:6}}>量價走勢</div>
                        <div style={{background:r.vpt.verdictBg,borderRadius:6,padding:"7px 9px",
                          border:`1px solid ${r.vpt.verdictColor}44`,marginBottom:7}}>
                          <div style={{fontSize:14,fontWeight:800,color:r.vpt.verdictColor}}>
                            {r.vpt.verdictIcon} {r.vpt.verdict}
                          </div>
                          <div style={{display:"flex",gap:8,marginTop:3}}>
                            <span style={{fontSize:9,color:"#4caf50"}}>多{r.vpt.bullScore}</span>
                            <span style={{fontSize:9,color:"#37474f"}}>vs</span>
                            <span style={{fontSize:9,color:"#ef5350"}}>空{r.vpt.bearScore}</span>
                          </div>
                        </div>
                        {r.vpt.reasons.map((rs,j)=>(
                          <div key={j} style={{display:"flex",gap:5,marginBottom:4}}>
                            <span style={{fontSize:10,color:rs.type==="bull"?"#4caf50":rs.type==="bear"?"#ef5350":"#90a4ae",minWidth:10}}>
                              {rs.type==="bull"?"▲":rs.type==="bear"?"▼":"◆"}
                            </span>
                            <span style={{fontSize:10,color:"#546e7a",lineHeight:1.5}}>{rs.text}</span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>

                  {/* 右：進場點位 + 評分 + 新聞 */}
                  <div>
                    {/* 評分條 */}
                    <div style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#37474f",marginBottom:4}}>
                        <span>爆發評分</span>
                        <span style={{color:r.gradeColor,fontWeight:800,fontSize:13}}>{r.score}/100</span>
                      </div>
                      <div style={{height:4,background:"#111827",borderRadius:3}}>
                        <div style={{width:`${r.score}%`,height:"100%",borderRadius:3,
                          background:`linear-gradient(90deg,#283593,${r.gradeColor})`}}/>
                      </div>
                    </div>

                    {/* 進場點位 */}
                    {r.trade&&(
                      <div style={{background:"#060c1a",borderRadius:7,padding:"10px 12px",
                        border:"1px solid #4caf5044",marginBottom:10}}>
                        <div style={{fontSize:9,color:"#4caf50",letterSpacing:2,marginBottom:7}}>🚀 交易點位</div>
                        <div style={{fontSize:9,color:"#37474f",marginBottom:7,background:"#0a1520",padding:"4px 7px",borderRadius:4}}>{r.trade.strategy}</div>

                        <div style={{display:"flex",gap:6,marginBottom:7}}>
                          <div style={{flex:1,background:"#0d2137",borderRadius:5,padding:"6px 8px"}}>
                            <div style={{fontSize:8,color:"#37474f",marginBottom:1}}>市價進場</div>
                            <div style={{fontSize:12,fontWeight:800,color:"#90a4ae"}}>{r.trade.entryIdeal}</div>
                          </div>
                          <div style={{flex:1,background:"#0d2137",borderRadius:5,padding:"6px 8px"}}>
                            <div style={{fontSize:8,color:"#37474f",marginBottom:1}}>限價回踩</div>
                            <div style={{fontSize:12,fontWeight:800,color:"#7986cb"}}>{r.trade.entryLimit}</div>
                          </div>
                        </div>

                        <div style={{background:"#1a0a0a",borderRadius:5,padding:"6px 9px",
                          border:"1px solid #ef535033",display:"flex",justifyContent:"space-between",marginBottom:6}}>
                          <div>
                            <div style={{fontSize:8,color:"#37474f",marginBottom:1}}>🛑 止損 SL</div>
                            <div style={{fontSize:13,fontWeight:800,color:"#ef5350"}}>{r.trade.stopLoss}</div>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:12,color:"#ef5350",fontWeight:700}}>{r.trade.slPct}%</div>
                          </div>
                        </div>

                        {[{l:"TP1 保守(1.5R)",v:r.trade.tp1,p:r.trade.tp1Pct,tip:"先減半"},
                          {l:`TP2 標準(${r.trade.rr}R)`,v:r.trade.tp2,p:r.trade.tp2Pct,tip:"再減半"},
                          {l:"TP3 接近阻力",v:r.trade.tp3,p:r.trade.tp3Pct,tip:"全出"}].map((tp,ti)=>(
                          <div key={ti} style={{background:"#0d2820",borderRadius:5,padding:"5px 9px",
                            border:"1px solid #4caf5033",display:"flex",justifyContent:"space-between",
                            alignItems:"center",marginBottom:4}}>
                            <div>
                              <div style={{fontSize:8,color:"#2e7d32",marginBottom:1}}>{tp.l} · {tp.tip}</div>
                              <div style={{fontSize:12,fontWeight:700,color:"#4caf50"}}>{tp.v}</div>
                            </div>
                            <div style={{fontSize:12,fontWeight:700,color:"#4caf50"}}>+{tp.p}%</div>
                          </div>
                        ))}

                        <div style={{display:"flex",gap:6,marginTop:6}}>
                          <div style={{flex:1,background:"#0b1020",borderRadius:4,padding:"5px 7px"}}>
                            <div style={{fontSize:8,color:"#37474f"}}>風報比</div>
                            <div style={{fontSize:12,fontWeight:800,color:"#ff9800"}}>1:{r.trade.rr}</div>
                          </div>
                          <div style={{flex:2,background:"#0b1020",borderRadius:4,padding:"5px 7px"}}>
                            <div style={{fontSize:8,color:"#37474f"}}>建議倉位</div>
                            <div style={{fontSize:10,fontWeight:700,color:"#9fa8da"}}>{r.trade.positionPct}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 合約數據 */}
                    {r.extras?.length>0&&(
                      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                        {r.extras.map(ex=>(
                          <div key={ex.label} style={{background:"#060810",borderRadius:5,padding:"6px 9px",
                            border:`1px solid ${ex.color}33`}}>
                            <div style={{fontSize:8,color:"#455a64",marginBottom:1}}>{ex.label}</div>
                            <div style={{fontSize:12,fontWeight:700,color:ex.color}}>{ex.value}</div>
                            <div style={{fontSize:8,color:"#37474f"}}>{ex.note}</div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 新聞 */}
                    <button onClick={e=>{e.stopPropagation();openNews(r.symbol);}}
                      style={{width:"100%",padding:"7px",borderRadius:5,
                        background:"#060c1a",border:"1px solid #1a2035",
                        color:"#ff9800",cursor:"pointer",fontSize:10,fontFamily:"inherit",textAlign:"left"}}>
                      📰 查看 {r.symbol.replace("USDT","")} 最新消息
                    </button>

                    <div style={{marginTop:8,fontSize:9,color:"#1e293b",lineHeight:1.6}}>
                      ⚠️ 僅供參考，合約交易風險極高。
                    </div>
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
