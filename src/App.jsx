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
// 立刻進場決策引擎
// ══════════════════════════════════════════════════════════════════
function calcEntryDecision(r) {
  if(!r) return null;
  const checks = [];
  let go = 0, warn = 0, stop = 0;

  // 必要條件（缺一不可）
  const c1 = r.aboveAll;
  checks.push({label:"站上MA30/45/60", ok:c1, must:true,
    note:c1?"三條均線全部站上✅":"未站上均線，禁止進場❌"});

  const c2 = r.score >= 70;
  checks.push({label:"綜合評分≥70", ok:c2, must:true,
    note:c2?`評分${r.score}分✅`:`評分只有${r.score}分，條件不足❌`});

  const c3 = r.vpt?.verdict?.includes("多");
  checks.push({label:"量價偏多", ok:c3, must:true,
    note:c3?`${r.vpt.verdict}✅`:`量價${r.vpt?.verdict||"不明"}，方向不對❌`});

  const c4 = r.crash?.isCrash !== true;
  checks.push({label:"無暴跌預警", ok:c4, must:true,
    note:c4?"無暴跌預警✅":"⚠️ 偵測到暴跌訊號，禁止做多❌"});

  // 加分條件（滿足越多越好）
  const b1 = r.smc?.smcBias >= 1;
  checks.push({label:"SMC結構偏多", ok:b1, must:false,
    note:b1?`${r.smc.smcVerdict}✅`:"SMC結構中性或偏空⚠️"});

  const b2 = r.bb?.width < 0.07;
  checks.push({label:"布林帶收窄", ok:b2, must:false,
    note:b2?`帶寬${(r.bb?.width*100).toFixed(2)}%✅`:"布林帶未收窄⚠️"});

  const b3 = r.surge?.isSurge;
  checks.push({label:"有爆漲訊號", ok:b3, must:false,
    note:b3?`${r.surge.surgeStrength}✅`:"無爆漲前兆（普通進場）"});

  const b4 = r.smc?.bos?.type === "bullish";
  checks.push({label:"BOS向上突破", ok:b4, must:false,
    note:b4?"結構向上突破確認✅":"無BOS突破"});

  // 計算
  const mustFail = checks.filter(c=>c.must&&!c.ok).length;
  const bonusOk  = checks.filter(c=>!c.must&&c.ok).length;
  const bonusTotal = checks.filter(c=>!c.must).length;

  let decision, decisionColor, decisionBg, urgency;

  if(mustFail > 0) {
    decision = "❌ 禁止進場";
    decisionColor = "#ef5350";
    decisionBg = "#1a0505";
    urgency = "必要條件未達標，等待機會";
  } else if(bonusOk >= 3) {
    decision = "🚀 立刻進場";
    decisionColor = "#4caf50";
    decisionBg = "#0d2820";
    urgency = "所有條件齊備，這是最佳機會";
  } else if(bonusOk >= 2) {
    decision = "✅ 可以進場";
    decisionColor = "#8bc34a";
    decisionBg = "#1b5e2018";
    urgency = "條件良好，建議進場";
  } else {
    decision = "⚠️ 謹慎輕倉";
    decisionColor = "#ff9800";
    decisionBg = "#1a1000";
    urgency = "基本條件達標但加分不足，小倉觀察";
  }

  return { decision, decisionColor, decisionBg, urgency, checks, mustFail, bonusOk, bonusTotal };
}


// ══════════════════════════════════════════════════════════════════
// OI 儀表板
// ══════════════════════════════════════════════════════════════════
const JOURNAL_KEY = "trading_journal_v1";
let _mem = [];
function loadJournal() {
  try { const r=localStorage.getItem(JOURNAL_KEY); if(r){ const p=JSON.parse(r); if(Array.isArray(p)){_mem=[...p];return [...p];}}} catch(_){}
  try { const r=sessionStorage.getItem(JOURNAL_KEY); if(r){ const p=JSON.parse(r); if(Array.isArray(p)){_mem=[...p];return [...p];}}} catch(_){}
  return [..._mem];
}
function saveJournal(trades) {
  if(!Array.isArray(trades)) return;
  _mem=[...trades];
  const j=JSON.stringify(trades);
  try{localStorage.setItem(JOURNAL_KEY,j);return;}catch(_){}
  try{sessionStorage.setItem(JOURNAL_KEY,j);}catch(_){}
}

async function fetchOIData(symbols) {
  const results = await Promise.allSettled(
    symbols.map(async sym => {
      const [ticker, oi, fr, oiHist] = await Promise.allSettled([
        fetch(`${FAPI}/fapi/v1/ticker/24hr?symbol=${sym}`).then(r=>r.json()),
        fetch(`${FAPI}/fapi/v1/openInterest?symbol=${sym}`).then(r=>r.json()),
        fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${sym}&limit=1`).then(r=>r.json()),
        fetch(`${FAPI}/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=24`).then(r=>r.json()),
      ]);
      const t=ticker.status==="fulfilled"?ticker.value:{};
      const o=oi.status==="fulfilled"?oi.value:{};
      const fr2=fr.status==="fulfilled"&&Array.isArray(fr.value)?fr.value:[];
      const oh=oiHist.status==="fulfilled"&&Array.isArray(oiHist.value)?oiHist.value:[];
      const price=parseFloat(t.lastPrice||0);
      const oiNow=parseFloat(o.openInterest||0);
      const vol24h=parseFloat(t.quoteVolume||0);
      const change24=parseFloat(t.priceChangePercent||0);
      const frNow=fr2[0]?parseFloat(fr2[0].fundingRate)*100:null;
      const oiHr1=oh.length>=2?parseFloat(oh[oh.length-2].sumOpenInterest):oiNow;
      const oiHr4=oh.length>=5?parseFloat(oh[oh.length-5].sumOpenInterest):oiNow;
      const oiChg1h=oiHr1?((oiNow-oiHr1)/oiHr1*100):0;
      const oiChg4h=oiHr4?((oiNow-oiHr4)/oiHr4*100):0;
      let divergence="neutral",divColor="#90a4ae",divNote="";
      if(change24>1&&oiChg4h>5){divergence="bullAccum";divColor="#4caf50";divNote="價漲OI升，多頭積累（健康）";}
      else if(change24>1&&oiChg4h<-5){divergence="shortCover";divColor="#ff9800";divNote="價漲OI降，空頭回補";}
      else if(change24<-1&&oiChg4h>5){divergence="bearAccum";divColor="#ef5350";divNote="價跌OI升，空頭積累（危險）";}
      else if(change24<-1&&oiChg4h<-5){divergence="longSqueezeEnd";divColor="#ffb74d";divNote="價跌OI降，可能近底";}
      else if(Math.abs(change24)<0.5&&Math.abs(oiChg4h)>8){divergence="coil";divColor="#7986cb";divNote="橫盤OI急變，方向即將決定🔥";}
      const squeezeRisk=frNow!=null&&Math.abs(frNow)>0.08&&oiNow*price>5e8;
      return {sym,price,oiNow,oiChg1h,oiChg4h,vol24h,change24,frNow,divergence,divColor,divNote,squeezeRisk,
        oiHist:oh.map(x=>parseFloat(x.sumOpenInterest))};
    })
  );
  return results.filter(r=>r.status==="fulfilled").map(r=>r.value);
}

function OISparkline({data,color="#7986cb"}) {
  if(!data||data.length<2) return null;
  const w=80,h=22;
  const min=Math.min(...data),max=Math.max(...data),range=max-min||1;
  const pts=data.map((v,i)=>`${i*(w/(data.length-1))},${h-(v-min)/range*h}`).join(" ");
  return <svg width={w} height={h} style={{display:"block"}}><polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></svg>;
}

function OIDashboard() {
  const [oiData,setOiData]=useState([]);
  const [loading,setLoading]=useState(false);
  const [sortBy,setSortBy]=useState("oiChg1h");
  const [filterDiv,setFilterDiv]=useState("all");
  const [lastUpdate,setLastUpdate]=useState(null);
  const TOP=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","ADAUSDT","AVAXUSDT","DOGEUSDT","LINKUSDT","DOTUSDT","MATICUSDT","LTCUSDT","ATOMUSDT","NEARUSDT","APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT","TIAUSDT","WIFUSDT","JUPUSDT","FETUSDT","RNDRUSDT","LDOUSDT"];

  async function refresh(){
    setLoading(true);
    const data=await fetchOIData(TOP);
    setOiData(data);setLastUpdate(new Date().toLocaleTimeString("zh-TW"));setLoading(false);
  }
  useEffect(()=>{refresh();},[]);

  const sorted=[...oiData].filter(d=>{
    if(filterDiv==="coil") return d.divergence==="coil";
    if(filterDiv==="bear") return d.divergence==="bearAccum";
    if(filterDiv==="bull") return d.divergence==="bullAccum";
    if(filterDiv==="squeeze") return d.squeezeRisk;
    return true;
  }).sort((a,b)=>{
    if(sortBy==="oiChg1h") return Math.abs(b.oiChg1h)-Math.abs(a.oiChg1h);
    if(sortBy==="oiChg4h") return Math.abs(b.oiChg4h)-Math.abs(a.oiChg4h);
    if(sortBy==="fr") return Math.abs(b.frNow||0)-Math.abs(a.frNow||0);
    return b.vol24h-a.vol24h;
  });

  const fmtOI=v=>v>1e9?`${(v/1e9).toFixed(2)}B`:v>1e6?`${(v/1e6).toFixed(1)}M`:`${(v/1e3).toFixed(0)}K`;
  const fmtC=v=>(v>=0?"+":"")+v.toFixed(2)+"%";

  return(
    <div style={{flex:1,overflowY:"auto",height:"100vh",background:"#07090f",padding:"14px 20px",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:10,letterSpacing:3,color:"#ff9800",textTransform:"uppercase",marginBottom:3}}>OI DASHBOARD</div>
          <div style={{fontSize:18,fontWeight:800,background:"linear-gradient(90deg,#ff9800,#ef5350)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>未平倉量儀表板</div>
          <div style={{fontSize:9,color:"#37474f",marginTop:2}}>預測將發生·背離偵測·費率矩陣</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {lastUpdate&&<span style={{fontSize:10,color:"#263238"}}>更新 {lastUpdate}</span>}
          <button onClick={refresh} disabled={loading}
            style={{padding:"7px 14px",borderRadius:6,border:"none",background:"linear-gradient(135deg,#e65100,#b71c1c)",color:"#fff",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
            {loading?"更新中…":"🔄 更新"}
          </button>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        {[["coil","🔥 蓄勢爆發",oiData.filter(d=>d.divergence==="coil").length,"OI急變+橫盤","#7986cb"],
          ["bull","🚀 多頭積累",oiData.filter(d=>d.divergence==="bullAccum").length,"價漲OI升","#4caf50"],
          ["bear","💥 空頭積累",oiData.filter(d=>d.divergence==="bearAccum").length,"價跌OI升","#ef5350"],
          ["squeeze","⚡ 軋倉風險",oiData.filter(d=>d.squeezeRisk).length,"費率極端+OI高","#ff9800"],
        ].map(([k,l,v,n,c])=>(
          <div key={k} onClick={()=>setFilterDiv(filterDiv===k?"all":k)}
            style={{background:filterDiv===k?`${c}18`:"#0c111e",borderRadius:8,padding:"11px 13px",cursor:"pointer",
              border:`1px solid ${filterDiv===k?c:"#1a2035"}`,boxShadow:filterDiv===k?`0 0 10px ${c}33`:"none"}}>
            <div style={{fontSize:11,color:c,marginBottom:3}}>{l}</div>
            <div style={{fontSize:22,fontWeight:800,color:c}}>{v}</div>
            <div style={{fontSize:9,color:"#37474f",marginTop:2}}>{n}</div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",gap:6,marginBottom:10,alignItems:"center"}}>
        <span style={{fontSize:9,color:"#37474f"}}>排序</span>
        {[["oiChg1h","OI 1H"],["oiChg4h","OI 4H"],["fr","費率"],["vol","交易量"]].map(([k,l])=>(
          <button key={k} onClick={()=>setSortBy(k)}
            style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:"inherit",cursor:"pointer",
              border:`1px solid ${sortBy===k?"#ff9800":"#1a2035"}`,background:sortBy===k?"#ff980022":"transparent",color:sortBy===k?"#ff9800":"#37474f"}}>
            {l}
          </button>
        ))}
        {filterDiv!=="all"&&<button onClick={()=>setFilterDiv("all")} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:"inherit",cursor:"pointer",border:"1px solid #37474f",background:"transparent",color:"#546e7a"}}>✕清除</button>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"90px 75px 65px 65px 65px 75px 85px 80px 1fr",gap:"0 8px",padding:"0 8px 5px",fontSize:9,color:"#263238",letterSpacing:1,textTransform:"uppercase",borderBottom:"1px solid #0f1629",marginBottom:5}}>
        <span>幣種</span><span>現價</span><span>OI 1H</span><span>OI 4H</span><span>24H%</span><span>費率</span><span>OI量</span><span>走勢</span><span>訊號</span>
      </div>
      {loading&&oiData.length===0&&<div style={{textAlign:"center",color:"#37474f",marginTop:60,fontSize:12}}>載入中…</div>}
      {sorted.map(d=>{
        const oc=d.oiChg1h>5?"#4caf50":d.oiChg1h<-5?"#ef5350":"#90a4ae";
        const o4c=d.oiChg4h>5?"#4caf50":d.oiChg4h<-5?"#ef5350":"#90a4ae";
        const frc=d.frNow==null?"#37474f":d.frNow>0.05?"#ef5350":d.frNow>0.01?"#ff9800":d.frNow<-0.01?"#4caf50":"#4dd0e1";
        return(
          <div key={d.sym} style={{display:"grid",gridTemplateColumns:"90px 75px 65px 65px 65px 75px 85px 80px 1fr",
            gap:"0 8px",padding:"8px 8px",marginBottom:3,alignItems:"center",
            background:d.divergence==="coil"?"#1a1535":d.squeezeRisk?"#1a0d00":"#0c111e",
            borderRadius:6,border:`1px solid ${d.divergence==="coil"?"#7986cb33":d.squeezeRisk?"#ff980033":"#111827"}`}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:"#e8eaf6"}}>{d.sym.replace("USDT","")}</div>
              {d.squeezeRisk&&<div style={{fontSize:8,color:"#ff9800"}}>⚡軋倉風險</div>}
              {d.divergence==="coil"&&<div style={{fontSize:8,color:"#7986cb"}}>🔥即將爆發</div>}
            </div>
            <span style={{fontSize:11,color:"#90a4ae"}}>{d.price>=1000?d.price.toFixed(1):d.price>=1?d.price.toFixed(3):d.price.toFixed(6)}</span>
            <span style={{fontSize:11,fontWeight:700,color:oc}}>{fmtC(d.oiChg1h)}</span>
            <span style={{fontSize:11,fontWeight:700,color:o4c}}>{fmtC(d.oiChg4h)}</span>
            <span style={{fontSize:11,color:d.change24>0?"#4caf50":d.change24<0?"#ef5350":"#90a4ae",fontWeight:700}}>{fmtC(d.change24)}</span>
            <span style={{fontSize:11,color:frc,fontWeight:700}}>{d.frNow!=null?`${d.frNow.toFixed(4)}%`:"—"}</span>
            <span style={{fontSize:10,color:"#546e7a"}}>{fmtOI(d.oiNow*d.price)}</span>
            <OISparkline data={d.oiHist} color={d.oiChg4h>0?"#4caf50":"#ef5350"}/>
            <span style={{fontSize:10,color:d.divColor,fontWeight:d.divergence!=="neutral"?700:400}}>{d.divNote||"—"}</span>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 交易日誌
// ══════════════════════════════════════════════════════════════════
async function checkTradeResult(trade) {
  try {
    const res=await fetch(`${FAPI}/fapi/v1/klines?symbol=${trade.symbol}&interval=15m&limit=200`);
    const klines=await res.json();
    if(!Array.isArray(klines)) return null;
    const entryTime=new Date(trade.entryTime).getTime();
    const candles=klines.map(k=>({time:+k[0],high:+k[2],low:+k[3],close:+k[4]})).filter(c=>c.time>=entryTime);
    if(!candles.length) return {result:"持倉中",currentPnl:"0.00",maxProfit:"0.00",maxLoss:"0.00",lastPrice:klines[klines.length-1][4]};
    const entry=parseFloat(trade.entryPrice),sl=parseFloat(trade.stopLoss),tp1=parseFloat(trade.tp1);
    const tp2=trade.tp2?parseFloat(trade.tp2):null,tp3=trade.tp3?parseFloat(trade.tp3):null;
    const dir=trade.direction==="long"?1:-1;
    let result=null,resultTime=null,maxP=0,maxL=0;
    for(const c of candles){
      const pnl=dir===1?(c.close-entry)/entry*100:(entry-c.close)/entry*100;
      if(pnl>maxP) maxP=pnl;
      if(pnl<maxL) maxL=pnl;
      if(!result){
        if(tp3&&(dir===1?c.high>=tp3:c.low<=tp3)){result="TP3";resultTime=new Date(c.time).toLocaleString("zh-TW");}
        else if(tp2&&(dir===1?c.high>=tp2:c.low<=tp2)){result="TP2";resultTime=new Date(c.time).toLocaleString("zh-TW");}
        else if(dir===1?c.high>=tp1:c.low<=tp1){result="TP1";resultTime=new Date(c.time).toLocaleString("zh-TW");}
        else if(dir===1?c.low<=sl:c.high>=sl){result="SL";resultTime=new Date(c.time).toLocaleString("zh-TW");}
      }
    }
    const last=candles[candles.length-1].close;
    const curPnl=dir===1?(last-entry)/entry*100:(entry-last)/entry*100;
    return{result:result||"持倉中",resultTime,currentPnl:curPnl.toFixed(2),maxProfit:maxP.toFixed(2),maxLoss:maxL.toFixed(2),lastPrice:last.toFixed(4)};
  }catch(e){return{result:"錯誤",error:e.message};}
}

function TradingJournal({quickAdd,onQuickAddDone}){
  const [trades,setTrades]=useState(()=>loadJournal());
  const [showForm,setShowForm]=useState(false);
  const [checking,setChecking]=useState({});
  const [form,setForm]=useState({
    symbol:"BTCUSDT",direction:"long",entryPrice:"",stopLoss:"",tp1:"",tp2:"",tp3:"",
    entryTime:new Date().toISOString().slice(0,16),note:"",score:"",smcVerdict:"",vptVerdict:""
  });
  const formRef=useRef(form);
  useEffect(()=>{formRef.current=form;},[form]);

  useEffect(()=>{
    if(!quickAdd) return;
    const newForm={...quickAdd,entryTime:new Date().toISOString().slice(0,16)};
    setForm(newForm);
    formRef.current=newForm;
    setShowForm(true);
    if(onQuickAddDone) onQuickAddDone();
  },[quickAdd]);

  const closed=trades.filter(t=>["TP1","TP2","TP3","SL"].includes(t.result?.result));
  const wins=closed.filter(t=>t.result?.result?.startsWith("TP"));
  const losses=closed.filter(t=>t.result?.result==="SL");
  const winRate=closed.length>0?(wins.length/closed.length*100).toFixed(0):"-";

  const handleAdd=()=>{
    const f=formRef.current;
    if(!f.symbol||!f.entryPrice||!f.stopLoss||!f.tp1){
      alert("請填入：幣種、進場價格、止損、TP1");return;
    }
    const ep=parseFloat(f.entryPrice),sl=parseFloat(f.stopLoss),t1=parseFloat(f.tp1);
    const t2=f.tp2?parseFloat(f.tp2):null,t3=f.tp3?parseFloat(f.tp3):null;
    if(isNaN(ep)||isNaN(sl)||isNaN(t1)){alert("價格格式有誤");return;}
    const dir=f.direction==="long"?1:-1;
    const slPct=((sl-ep)/ep*100*dir*-1).toFixed(2);
    const tp1Pct=((t1-ep)/ep*100*dir).toFixed(2);
    const tp2Pct=t2?((t2-ep)/ep*100*dir).toFixed(2):"";
    const tp3Pct=t3?((t3-ep)/ep*100*dir).toFixed(2):"";
    const newTrade={...f,id:Date.now(),slPct,tp1Pct,tp2Pct,tp3Pct,result:null,addedAt:new Date().toISOString()};
    const existing=loadJournal();
    const updated=[newTrade,...existing];
    saveJournal(updated);
    setTrades(updated);
    setShowForm(false);
    setForm(f=>({...f,entryPrice:"",stopLoss:"",tp1:"",tp2:"",tp3:"",note:"",score:""}));
  };

  const doCheck=async(trade)=>{
    setChecking(c=>({...c,[trade.id]:true}));
    const result=await checkTradeResult(trade);
    const existing=loadJournal();
    const updated=existing.map(t=>t.id===trade.id?{...t,result,checkedAt:new Date().toISOString()}:t);
    saveJournal(updated);setTrades(updated);
    setChecking(c=>({...c,[trade.id]:false}));
  };

  const doDelete=(id)=>{
    const updated=loadJournal().filter(t=>t.id!==id);
    saveJournal(updated);setTrades(updated);
  };

  const sync=()=>{setTrades(loadJournal());};

  const rCol=r=>r==="TP3"?"#2e7d32":r==="TP2"?"#4caf50":r==="TP1"?"#8bc34a":r==="SL"?"#ef5350":r==="持倉中"?"#ff9800":"#37474f";
  const rLabel=r=>r==="TP3"?"🎯🎯 TP3":r==="TP2"?"🎯 TP2":r==="TP1"?"✅ TP1":r==="SL"?"🛑 止損":r==="持倉中"?"⏳ 持倉中":"—";

  const Inp=({k,ph,type="text"})=>(
    <div style={{display:"flex",flexDirection:"column",gap:3}}>
      <span style={{fontSize:10,color:"#37474f"}}>{ph}</span>
      <input type={type} value={form[k]} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}
        style={{background:"#060810",border:"1px solid #1a2035",borderRadius:5,
          color:"#90a4ae",fontSize:12,padding:"6px 8px",fontFamily:"inherit",outline:"none",width:"100%"}}/>
    </div>
  );

  return(
    <div style={{flex:1,overflowY:"auto",height:"100vh",background:"#07090f",padding:"14px 20px",boxSizing:"border-box"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:10,letterSpacing:3,color:"#7986cb",textTransform:"uppercase",marginBottom:3}}>TRADING JOURNAL</div>
          <div style={{fontSize:18,fontWeight:800,background:"linear-gradient(90deg,#7986cb,#4caf50)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>交易日誌 · 自動回測</div>
          <div style={{fontSize:9,color:"#37474f",marginTop:2}}>記錄進場點位，系統自動回測止盈止損</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={sync} style={{padding:"7px 12px",borderRadius:6,border:"1px solid #1a2035",background:"#0c111e",color:"#7986cb",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>🔄 同步</button>
          <button onClick={()=>setShowForm(!showForm)} style={{padding:"7px 16px",borderRadius:6,border:"none",background:"linear-gradient(135deg,#283593,#00695c)",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"}}>+ 新增交易</button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:14}}>
        {[["總記錄",trades.length,"#7986cb"],["已結算",closed.length,"#90a4ae"],
          ["勝率",`${winRate}%`,winRate>=60?"#4caf50":winRate>=45?"#ff9800":"#ef5350"],
          ["獲利筆數",wins.length,"#4caf50"],["止損筆數",losses.length,"#ef5350"]
        ].map(([k,v,c])=>(
          <div key={k} style={{background:"#0c111e",borderRadius:8,padding:"11px 13px",border:"1px solid #1a2035"}}>
            <div style={{fontSize:10,color:"#37474f",marginBottom:3}}>{k}</div>
            <div style={{fontSize:20,fontWeight:800,color:c}}>{v}</div>
          </div>
        ))}
      </div>

      {showForm&&(
        <div style={{background:"#0c111e",borderRadius:10,padding:"14px 16px",border:"1px solid #1a2035",marginBottom:14}}>
          <div style={{fontSize:11,color:"#7986cb",letterSpacing:2,marginBottom:10}}>新增交易記錄</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 160px 1fr 1fr",gap:10,marginBottom:8}}>
            <div style={{display:"flex",flexDirection:"column",gap:3}}>
              <span style={{fontSize:10,color:"#37474f"}}>幣種</span>
              <input value={form.symbol} onChange={e=>setForm(f=>({...f,symbol:e.target.value.toUpperCase()}))} placeholder="BTCUSDT"
                style={{background:"#060810",border:"1px solid #1a2035",borderRadius:5,color:"#90a4ae",fontSize:12,padding:"6px 8px",fontFamily:"inherit",outline:"none"}}/>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:3}}>
              <span style={{fontSize:10,color:"#37474f"}}>方向</span>
              <div style={{display:"flex",gap:5,height:32}}>
                {["long","short"].map(d=>(
                  <button key={d} onClick={()=>setForm(f=>({...f,direction:d}))}
                    style={{flex:1,padding:"4px",borderRadius:5,cursor:"pointer",fontSize:11,fontFamily:"inherit",
                      border:`1px solid ${form.direction===d?d==="long"?"#4caf50":"#ef5350":"#1a2035"}`,
                      background:form.direction===d?d==="long"?"#1b5e2022":"#b71c1c22":"transparent",
                      color:form.direction===d?d==="long"?"#4caf50":"#ef5350":"#37474f",fontWeight:700}}>
                    {d==="long"?"▲ 多":"▼ 空"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:3}}>
              <span style={{fontSize:10,color:"#37474f"}}>進場時間</span>
              <input type="datetime-local" value={form.entryTime} onChange={e=>setForm(f=>({...f,entryTime:e.target.value}))}
                style={{background:"#060810",border:"1px solid #1a2035",borderRadius:5,color:"#90a4ae",fontSize:11,padding:"6px 8px",fontFamily:"inherit",outline:"none"}}/>
            </div>
            <Inp k="note" ph="備注"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:10}}>
            <Inp k="entryPrice" ph="進場價格" type="number"/>
            <Inp k="stopLoss" ph="止損 SL" type="number"/>
            <Inp k="tp1" ph="止盈 TP1 *" type="number"/>
            <Inp k="tp2" ph="止盈 TP2（選填）" type="number"/>
            <Inp k="tp3" ph="止盈 TP3（選填）" type="number"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
            <Inp k="score" ph="系統評分（選填）"/>
            <Inp k="smcVerdict" ph="SMC判斷（選填）"/>
            <Inp k="vptVerdict" ph="量價判斷（選填）"/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={handleAdd}
              style={{padding:"9px 24px",borderRadius:6,border:"none",background:"linear-gradient(135deg,#283593,#00695c)",
                color:"#fff",cursor:"pointer",fontSize:13,fontWeight:700,fontFamily:"inherit"}}>
              ✅ 確認記錄
            </button>
            <button onClick={()=>setShowForm(false)}
              style={{padding:"9px 14px",borderRadius:6,border:"1px solid #1a2035",background:"transparent",color:"#546e7a",cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>
              取消
            </button>
          </div>
        </div>
      )}

      {trades.length===0?(
        <div style={{textAlign:"center",color:"#37474f",marginTop:60,fontSize:13}}>
          <div style={{fontSize:40,marginBottom:12}}>📋</div>
          <div>還沒有交易記錄</div>
          <div style={{fontSize:11,marginTop:6,color:"#1e293b"}}>點「+ 新增交易」或在掃描器點 📋 按鈕</div>
        </div>
      ):(
        <>
          <div style={{display:"grid",gridTemplateColumns:"95px 50px 82px 82px 68px 68px 68px 1fr 105px 105px 65px",
            gap:"0 6px",padding:"0 6px 5px",fontSize:9,color:"#263238",letterSpacing:1,textTransform:"uppercase",
            borderBottom:"1px solid #0f1629",marginBottom:5}}>
            <span>幣種/時間</span><span>方向</span><span>進場價</span><span>止損</span>
            <span>TP1</span><span>TP2</span><span>TP3</span><span>備注</span>
            <span>回測結果</span><span>損益%</span><span>操作</span>
          </div>
          {trades.map(t=>{
            const res=t.result;
            const isWin=res?.result?.startsWith("TP");
            const isSL=res?.result==="SL";
            return(
              <div key={t.id} style={{display:"grid",
                gridTemplateColumns:"95px 50px 82px 82px 68px 68px 68px 1fr 105px 105px 65px",
                gap:"0 6px",padding:"8px 6px",marginBottom:4,alignItems:"center",
                background:isWin?"#0d2820":isSL?"#1a0505":"#0c111e",
                borderRadius:6,border:`1px solid ${isWin?"#4caf5033":isSL?"#ef535033":"#111827"}`}}>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:"#e8eaf6"}}>{t.symbol.replace("USDT","")}</div>
                  <div style={{fontSize:9,color:"#37474f"}}>{new Date(t.entryTime).toLocaleString("zh-TW",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</div>
                </div>
                <span style={{fontSize:12,fontWeight:700,color:t.direction==="long"?"#4caf50":"#ef5350"}}>{t.direction==="long"?"▲多":"▼空"}</span>
                <span style={{fontSize:11,color:"#90a4ae"}}>{t.entryPrice}</span>
                <div><div style={{fontSize:11,color:"#ef5350",fontWeight:700}}>{t.stopLoss}</div><div style={{fontSize:9,color:"#546e7a"}}>{t.slPct}%</div></div>
                <div><div style={{fontSize:11,color:"#8bc34a"}}>{t.tp1}</div><div style={{fontSize:9,color:"#546e7a"}}>{t.tp1Pct?`+${t.tp1Pct}%`:""}</div></div>
                <div><div style={{fontSize:11,color:"#4caf50"}}>{t.tp2||"—"}</div><div style={{fontSize:9,color:"#546e7a"}}>{t.tp2Pct?`+${t.tp2Pct}%`:""}</div></div>
                <div><div style={{fontSize:11,color:"#2e7d32"}}>{t.tp3||"—"}</div><div style={{fontSize:9,color:"#546e7a"}}>{t.tp3Pct?`+${t.tp3Pct}%`:""}</div></div>
                <div style={{fontSize:10,color:"#546e7a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.note||"—"}{t.score&&<span style={{marginLeft:4,color:"#7986cb"}}>評{t.score}</span>}</div>
                <div>
                  {res?(<><div style={{fontSize:12,fontWeight:700,color:rCol(res.result)}}>{rLabel(res.result)}</div>{res.resultTime&&<div style={{fontSize:9,color:"#37474f"}}>{res.resultTime}</div>}</>):<div style={{fontSize:10,color:"#37474f"}}>未回測</div>}
                </div>
                <div>
                  {res&&(<><div style={{fontSize:13,fontWeight:800,color:parseFloat(res.currentPnl)>0?"#4caf50":parseFloat(res.currentPnl)<0?"#ef5350":"#90a4ae"}}>{parseFloat(res.currentPnl)>0?"+":""}{res.currentPnl}%</div><div style={{fontSize:9,color:"#37474f"}}>最高+{res.maxProfit}%</div></>)}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  <button onClick={()=>doCheck(t)} disabled={checking[t.id]}
                    style={{padding:"4px 8px",borderRadius:4,border:"1px solid #1a2035",background:"#060c1a",color:"#7986cb",cursor:"pointer",fontSize:10,fontFamily:"inherit"}}>
                    {checking[t.id]?"…":"回測"}
                  </button>
                  <button onClick={()=>doDelete(t.id)}
                    style={{padding:"4px 8px",borderRadius:4,border:"1px solid #1a2035",background:"transparent",color:"#546e7a",cursor:"pointer",fontSize:10,fontFamily:"inherit"}}>
                    刪除
                  </button>
                </div>
              </div>
            );
          })}
          {closed.length>=3&&(()=>{
            const wr=parseFloat(winRate)/100;
            const avgW=wins.length>0?(wins.reduce((a,t)=>{
              const r=t.result?.result;
              const p=r==="TP3"?parseFloat(t.tp3Pct||0):r==="TP2"?parseFloat(t.tp2Pct||0):parseFloat(t.tp1Pct||0);
              return a+(isNaN(p)?0:p);
            },0)/wins.length).toFixed(1):"0";
            const avgL=losses.length>0?Math.abs(losses.reduce((a,t)=>a+parseFloat(t.slPct||0),0)/losses.length).toFixed(1):"0";
            const ev=(wr*parseFloat(avgW)-(1-wr)*parseFloat(avgL)).toFixed(2);
            const pos=parseFloat(ev)>0;
            return(
              <div style={{marginTop:16,background:"#0c111e",borderRadius:10,padding:"14px 16px",border:"1px solid #1a2035"}}>
                <div style={{fontSize:10,color:"#7986cb",letterSpacing:2,marginBottom:10}}>📊 回測分析</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
                  <div>
                    <div style={{fontSize:11,color:"#37474f",marginBottom:7}}>勝率分佈</div>
                    <div style={{height:8,background:"#111827",borderRadius:4,overflow:"hidden",display:"flex",marginBottom:5}}>
                      <div style={{width:`${winRate}%`,background:"#4caf50"}}/>
                      <div style={{flex:1,background:"#ef5350"}}/>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}>
                      <span style={{color:"#4caf50"}}>獲利 {wins.length} ({winRate}%)</span>
                      <span style={{color:"#ef5350"}}>止損 {losses.length}</span>
                    </div>
                  </div>
                  <div>
                    <div style={{fontSize:11,color:"#37474f",marginBottom:7}}>期望值</div>
                    <div style={{fontSize:24,fontWeight:800,color:pos?"#4caf50":"#ef5350"}}>{pos?"+":""}{ev}%</div>
                    <div style={{fontSize:10,color:"#37474f",marginTop:3}}>{pos?"正期望值 ✅":"負期望值，需改善"}</div>
                  </div>
                  <div>
                    <div style={{fontSize:11,color:"#37474f",marginBottom:7}}>均值</div>
                    <div style={{fontSize:11,color:"#4caf50"}}>平均獲利 +{avgW}%</div>
                    <div style={{fontSize:11,color:"#ef5350",marginTop:3}}>平均虧損 -{avgL}%</div>
                  </div>
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 右側通知欄（固定欄，不浮動）
// ══════════════════════════════════════════════════════════════════
function AlertPanel({alerts, onDismiss}) {
  const isSurgeAlert = a => a.alertType==="surge";
  const isCrashAlert = a => a.alertType==="crash";

  return(
    <div style={{
      width:280, minWidth:280,
      background:"#090d1a",
      borderLeft:"1px solid #1a2035",
      height:"100vh",
      overflowY:"auto",
      display:"flex",
      flexDirection:"column",
      boxSizing:"border-box"
    }}>
      {/* Header */}
      <div style={{
        padding:"12px 14px",
        borderBottom:"1px solid #1a2035",
        background:"#080c18",
        position:"sticky", top:0, zIndex:1,
        display:"flex", justifyContent:"space-between", alignItems:"center"
      }}>
        <div>
          <div style={{fontSize:9,color:"#ff9800",letterSpacing:3,marginBottom:2}}>LIVE ALERTS</div>
          <div style={{display:"flex",alignItems:"center",gap:7}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:"#4caf50",
              boxShadow:"0 0 5px #4caf50",animation:"pulse 2s infinite"}}/>
            <span style={{fontSize:13,fontWeight:800,color:"#e8eaf6"}}>即時通知</span>
          </div>
        </div>
        {alerts.length>0&&(
          <button onClick={()=>onDismiss("all")}
            style={{padding:"3px 8px",borderRadius:4,border:"1px solid #1a2035",
              background:"transparent",color:"#546e7a",cursor:"pointer",fontSize:10,fontFamily:"inherit"}}>
            清除全部
          </button>
        )}
      </div>

      {/* Content */}
      <div style={{flex:1,overflowY:"auto",padding:"8px 10px"}}>
        {alerts.length===0?(
          <div style={{textAlign:"center",color:"#263238",marginTop:40,fontSize:11}}>
            <div style={{fontSize:28,marginBottom:8}}>🔔</div>
            等待訊號中…<br/>
            <span style={{fontSize:9,color:"#1e293b"}}>掃描到進場/暴漲/暴跌<br/>訊號時會在這裡顯示</span>
          </div>
        ):(
          alerts.map((a,i)=>{
            const surge = isSurgeAlert(a), crash = isCrashAlert(a);
            const bc = crash?"#ef5350":surge?"#ff9800":"#4caf50";
            const bg = crash?"#1a050511":surge?"#1a100011":"#0d282011";
            const title = crash?"💥 暴跌預警":surge?"🚀 暴漲預警":"🚀 進場訊號";
            const reasons = crash?a.crash?.crashReasons:surge?a.surge?.surgeReasons:null;
            const dec = !surge&&!crash ? calcEntryDecision(a) : null;
            return(
              <div key={a.symbol+i} style={{
                background:bg,
                border:`1px solid ${bc}44`,
                borderLeft:`3px solid ${bc}`,
                borderRadius:7,
                padding:"10px 10px",
                marginBottom:8,
              }}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                  <div>
                    <div style={{fontSize:9,color:bc,letterSpacing:2,fontWeight:700,marginBottom:2}}>{title}</div>
                    <div style={{fontSize:17,fontWeight:800,color:"#e8eaf6",lineHeight:1}}>
                      {a.symbol.replace("USDT","")}
                      <span style={{fontSize:9,color:"#37474f",marginLeft:4}}>/USDT</span>
                    </div>
                  </div>
                  <button onClick={()=>onDismiss(i)}
                    style={{background:"none",border:"none",color:"#37474f",cursor:"pointer",fontSize:14,lineHeight:1}}>✕</button>
                </div>

                {/* Decision */}
                {dec&&(
                  <div style={{background:"#060c1a",borderRadius:5,padding:"6px 8px",
                    border:`1px solid ${dec.decisionColor}44`,marginBottom:7}}>
                    <div style={{fontSize:14,fontWeight:900,color:dec.decisionColor}}>{dec.decision}</div>
                    <div style={{fontSize:9,color:"#546e7a",marginTop:2}}>{dec.urgency}</div>
                  </div>
                )}

                {/* Score + SMC */}
                <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
                  <span style={{fontSize:10,color:"#ff9800",background:"#ff950018",
                    padding:"1px 6px",borderRadius:3,fontWeight:700}}>評{a.score}</span>
                  {a.vpt&&<span style={{fontSize:10,color:a.vpt.verdictColor,
                    background:a.vpt.verdictBg,padding:"1px 6px",borderRadius:3,fontWeight:700}}>
                    {a.vpt.verdictIcon}{a.vpt.verdict}</span>}
                  {a.smc&&<span style={{fontSize:10,color:a.smc.smcColor,
                    background:`${a.smc.smcColor}18`,padding:"1px 6px",borderRadius:3}}>
                    {a.smc.smcVerdict}</span>}
                </div>

                {/* Trade levels */}
                {!surge&&!crash&&a.trade&&(
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:6}}>
                    {[
                      {l:"📍進場",v:a.trade.entryIdeal,c:"#e8eaf6"},
                      {l:"🛑止損",v:`${a.trade.stopLoss}`,c:"#ef5350",s:`${a.trade.slPct}%`},
                      {l:"🎯 TP1",v:a.trade.tp1,c:"#8bc34a",s:`+${a.trade.tp1Pct}%`},
                      {l:"🎯 TP2",v:a.trade.tp2||"—",c:"#4caf50",s:a.trade.tp2?`+${a.trade.tp2Pct}%`:""},
                    ].map(item=>(
                      <div key={item.l} style={{background:"#060810",borderRadius:4,padding:"4px 6px"}}>
                        <div style={{fontSize:8,color:"#37474f"}}>{item.l}</div>
                        <div style={{fontSize:11,fontWeight:700,color:item.c,lineHeight:1.2}}>{item.v}</div>
                        {item.s&&<div style={{fontSize:9,color:"#455a64"}}>{item.s}</div>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Reasons */}
                {reasons&&reasons.slice(0,2).map((r,j)=>(
                  <div key={j} style={{fontSize:9,color:"#546e7a",marginBottom:2,display:"flex",gap:4,lineHeight:1.4}}>
                    <span style={{color:bc,minWidth:8}}>{crash?"▼":"▲"}</span>{r}
                  </div>
                ))}

                <div style={{fontSize:8,color:"#1e293b",marginTop:5}}>
                  {new Date().toLocaleTimeString("zh-TW")}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 新聞面板（保持 fixed，從右側滑出）
// ══════════════════════════════════════════════════════════════════
function NewsPanel({symbol,news,loading,onClose}) {
  return(
    <div style={{position:"fixed",top:0,right:0,width:340,height:"100vh",
      background:"#0b0f1c",borderLeft:"1px solid #1a2035",zIndex:1000,
      display:"flex",flexDirection:"column",boxShadow:"-6px 0 24px #00000088"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #1a2035",
        display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:9,color:"#ff9800",letterSpacing:2,marginBottom:3}}>LATEST NEWS</div>
          <div style={{fontSize:14,fontWeight:700,color:"#e8eaf6"}}>{symbol?.replace("USDT","")} 最新消息</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",color:"#546e7a",cursor:"pointer",fontSize:18}}>✕</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"12px 14px"}}>
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
  const [page,        setPage]        = useState("scanner");
  const [quickAdd,    setQuickAdd]    = useState(null);
  const abortRef=useRef(false), firstLoad=useRef(true), timerRef=useRef(null), seenAlerts=useRef(new Set());

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
              new Notification(`🚀 進場：${r.symbol.replace("USDT","")}`,{body:`評分${r.score}`,icon:"/icon-192.png"});
          }
          if(r.surge?.isSurge&&!seenAlerts.current.has(r.symbol+iv+"s")){
            seenAlerts.current.add(r.symbol+iv+"s");
            newAlerts.push({...r,alertType:"surge"});
          }
          if(r.crash?.isCrash&&!seenAlerts.current.has(r.symbol+iv+"c")){
            seenAlerts.current.add(r.symbol+iv+"c");
            newAlerts.push({...r,alertType:"crash"});
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
    if(autoRefresh){timerRef.current=setInterval(()=>runScan(),2*60*1000);}
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
    sidebar:{width:210,minWidth:210,background:"#0b0f1c",borderRight:"1px solid #0f1629",
      height:"100vh",overflowY:"auto",padding:"14px 12px",boxSizing:"border-box",
      display:"flex",flexDirection:"column",gap:12},
    main:{flex:1,overflowY:"auto",height:"100vh",background:"#07090f",padding:"12px 16px",boxSizing:"border-box"},
    sL:{fontSize:9,letterSpacing:3,color:"#1e3a5f",textTransform:"uppercase",marginBottom:7},
    ivB:(a)=>({width:"100%",padding:"6px 10px",borderRadius:5,textAlign:"left",marginBottom:3,
      border:`1px solid ${a?"#3949ab":"#0f1629"}`,background:a?"#1a2040":"transparent",
      color:a?"#9fa8da":"#37474f",cursor:"pointer",fontSize:11,fontFamily:"inherit"}),
    mB:(a)=>({width:"100%",padding:"7px 10px",borderRadius:5,textAlign:"left",marginBottom:3,
      border:`1px solid ${a?"#00897b":"#0f1629"}`,background:a?"#00695c22":"transparent",
      color:a?"#4dd0e1":"#37474f",cursor:"pointer",fontSize:11,fontFamily:"inherit",fontWeight:600}),
    sBtn:{width:"100%",padding:"8px",borderRadius:6,border:"none",
      background:"linear-gradient(135deg,#283593,#00695c)",
      color:"#fff",cursor:"pointer",fontSize:12,fontWeight:700,fontFamily:"inherit"},
    fB:(a,col)=>({padding:"4px 9px",borderRadius:4,fontSize:10,fontFamily:"inherit",cursor:"pointer",
      border:`1px solid ${a?(col||"#3949ab"):"#1a2035"}`,
      background:a?(col?col+"22":"#1a2040"):"transparent",
      color:a?(col||"#9fa8da"):(col?col+"66":"#37474f")}),
    card:(score,open,surge,crash)=>({background:open?"#0f1729":"#0c111e",borderRadius:7,marginBottom:4,
      cursor:"pointer",overflow:"hidden",
      border:`1px solid ${crash?.isCrash?"#ef535044":surge?.isSurge?"#ff980044":score>=85?"#3949ab":score>=70?"#2e3a5e":score>=50?"#1c2d35":"#111827"}`,
      boxShadow:open?"0 0 0 1px #3949ab44":crash?.isCrash?"0 0 8px #ef535022":surge?.isSurge?"0 0 8px #ff980022":score>=85?"0 0 12px #3949ab33":"none"}),
  };

  return(
    <div style={{display:"flex",height:"100vh",overflow:"hidden",
      fontFamily:"'SF Mono','Fira Code',ui-monospace,monospace",color:"#dde1f0"}}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-track{background:#07090f}
        ::-webkit-scrollbar-thumb{background:#1a2035;border-radius:2px} *{box-sizing:border-box}
      `}</style>

      {newsSymbol&&<NewsPanel symbol={newsSymbol} news={newsData} loading={newsLoading} onClose={()=>setNewsSymbol(null)}/>}

      {/* ── 左側欄 ── */}
      <div style={C.sidebar}>
        <div>
          <div style={{fontSize:9,letterSpacing:4,color:"#3d5afe",textTransform:"uppercase",marginBottom:4}}>FUTURES SCANNER</div>
          <div style={{fontSize:13,fontWeight:800,lineHeight:1.3,
            background:"linear-gradient(90deg,#7986cb,#4dd0e1)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
            合約爆發偵測器
          </div>
          <div style={{fontSize:8,color:"#263238",marginTop:2}}>10指標·SMC·K線·OI·日誌</div>
          <div style={{display:"flex",flexDirection:"column",gap:3,marginTop:10}}>
            {[["scanner","📊 掃描器"],["oi","📈 OI儀表板"],["journal","📋 交易日誌"]].map(([v,l])=>(
              <button key={v} onClick={()=>setPage(v)}
                style={{width:"100%",padding:"6px 10px",borderRadius:5,fontSize:11,fontFamily:"inherit",cursor:"pointer",
                  border:`1px solid ${page===v?"#5c6bc0":"#0f1629"}`,textAlign:"left",
                  background:page===v?"#1a2040":"transparent",
                  color:page===v?"#9fa8da":"#37474f",fontWeight:page===v?700:400}}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {page==="scanner"&&(
          <>
            <div>
              <div style={C.sL}>掃描模式</div>
              <button style={C.mB(mode==="top100")} onClick={()=>{setMode("top100");setShowCustom(false);runScan(interval,"top100",customSyms);}}>🏆 前100名</button>
              <button style={C.mB(mode==="custom")} onClick={()=>{setMode("custom");setShowCustom(true);}}>✏️ 自訂幣種</button>
              {showCustom&&(
                <div style={{marginTop:5}}>
                  <textarea value={customSyms} onChange={e=>setCustomSyms(e.target.value)}
                    style={{width:"100%",height:60,background:"#060810",border:"1px solid #1a2035",
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
              <span style={{fontSize:10,color:autoRefresh?"#4caf50":"#37474f"}}>
                {autoRefresh?"🔴 監控中(2min)":"自動監控"}
              </span>
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
                <div style={C.sL}>統計</div>
                {[["掃描",progress.total||results.length,"#7986cb"],
                  ["有效",results.length,"#7986cb"],
                  ["🚀進場",entryCount,"#4caf50"],
                  ["🚀暴漲",surgeCount,"#ff9800"],
                  ["💥暴跌",crashCount,"#ef5350"],
                  ["SMC多",smcBullCount,"#4dd0e1"],
                ].map(([k,v,col])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",color:"#455a64",marginBottom:3}}>
                    <span>{k}</span>
                    <span style={{color:v>0?col:"#37474f",fontWeight:700}}>{v}</span>
                  </div>
                ))}
                <div style={{color:"#263238",fontSize:9,marginTop:4}}>{lastScan}</div>
              </div>
            )}
          </>
        )}
        {error&&<div style={{fontSize:10,borderRadius:5,padding:"7px 9px",background:"#1a0a0a",border:"1px solid #c62828",color:"#ef9a9a"}}>⚠️ {error}</div>}
        <div style={{fontSize:8,color:"#111827",marginTop:"auto"}}>直連幣安合約</div>
      </div>

      {/* ── 主區 ── */}
      <div style={C.main}>
        {page==="oi" ? <OIDashboard/> :
         page==="journal" ? <TradingJournal quickAdd={quickAdd} onQuickAddDone={()=>setQuickAdd(null)}/> :
        (<>
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
            <div style={{display:"grid",
              gridTemplateColumns:"24px 40px 1fr 86px 86px 86px 86px 58px 78px 56px",
              gap:"0 6px",padding:"0 6px 5px",fontSize:9,color:"#263238",
              letterSpacing:1,textTransform:"uppercase",borderBottom:"1px solid #0f1629",marginBottom:4}}>
              <span>#</span><span>分</span><span>幣種</span>
              <span>現價</span><span>MA30</span><span>MA45</span><span>MA60</span>
              <span>訊號</span><span>SMC</span><span>記錄</span>
            </div>
          )}

          {loading&&results.length===0&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"55vh",gap:14}}>
              <div style={{width:40,height:40,border:"3px solid #1a2035",borderTopColor:"#7986cb",borderRadius:"50%",animation:"spin 1s linear infinite"}}/>
              <div style={{color:"#37474f",fontSize:12}}>{progress.total>0?`掃描中 ${progress.done}/${progress.total}…`:"連線幣安中…"}</div>
            </div>
          )}

          {filtered.map((r,idx)=>(
            <div key={r.symbol} style={C.card(r.score,expanded===r.symbol,r.surge,r.crash)}>
              <div style={{display:"grid",
                gridTemplateColumns:"24px 40px 1fr 86px 86px 86px 86px 58px 78px 56px",
                gap:"0 6px",padding:"8px 6px",alignItems:"center"}}
                onClick={()=>setExpanded(expanded===r.symbol?null:r.symbol)}>

                <span style={{color:"#1e293b",fontSize:9}}>#{idx+1}</span>

                <div style={{position:"relative",width:38,height:38}}>
                  <svg width="38" height="38" style={{transform:"rotate(-90deg)"}}>
                    <circle cx="19" cy="19" r="13" fill="none" stroke="#111827" strokeWidth="3"/>
                    <circle cx="19" cy="19" r="13" fill="none" stroke={r.gradeColor} strokeWidth="3"
                      strokeDasharray={`${(r.score/100)*81.7} 81.7`} strokeLinecap="round"/>
                  </svg>
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",
                    justifyContent:"center",fontSize:10,fontWeight:800,color:r.gradeColor}}>{r.score}</div>
                </div>

                <div>
                  <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,fontWeight:700,color:"#e8eaf6"}}>{r.symbol.replace("USDT","")}</span>
                    <span style={{fontSize:7,color:"#263238"}}>/USDT</span>
                    <span style={{fontSize:8,color:r.gradeColor,background:`${r.gradeColor}18`,padding:"1px 4px",borderRadius:3}}>{r.grade}</span>
                    {r.isEntry&&<span style={{fontSize:8,color:"#4caf50",background:"#4caf5022",padding:"1px 4px",borderRadius:3,fontWeight:700}}>🚀進場</span>}
                    {r.surge?.isSurge&&<span style={{fontSize:8,color:"#ff9800",background:"#ff980022",padding:"1px 4px",borderRadius:3,fontWeight:700}}>🚀暴漲</span>}
                    {r.crash?.isCrash&&<span style={{fontSize:8,color:"#ef5350",background:"#ef535022",padding:"1px 4px",borderRadius:3,fontWeight:700}}>💥暴跌</span>}
                    {r.maFan&&<span style={{fontSize:8,color:"#4dd0e1",background:"#00695c18",padding:"1px 4px",borderRadius:3}}>多↑</span>}
                  </div>
                </div>

                {[[r.price,"#90a4ae"],[r.ma30,"#7986cb"],[r.ma45,"#9575cd"],[r.ma60,"#26c6da"]].map(([v,c],i)=>(
                  <span key={i} style={{fontSize:10,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</span>
                ))}

                <div style={{display:"flex",gap:2,flexWrap:"wrap"}}>
                  {r.signals?.slice(0,10).map(s=>(
                    <div key={s.key} title={s.label} style={{width:6,height:6,borderRadius:"50%",
                      background:s.ok===true?"#00897b":s.ok==="warn"?"#ff9500":"#1e293b"}}/>
                  ))}
                </div>

                <span style={{fontSize:9,color:r.smc?.smcColor||"#37474f",
                  background:r.smc?.smcBias>=2?"#4caf5018":r.smc?.smcBias<=-2?"#ef535018":"transparent",
                  padding:"2px 5px",borderRadius:3,fontWeight:r.smc?.smcBias?700:400}}>
                  {r.smc?.smcVerdict||"—"}
                </span>

                <button
                  onClick={e=>{
                    e.stopPropagation();
                    setQuickAdd({
                      symbol:r.symbol,
                      direction:r.vpt?.verdict?.includes("空")?"short":"long",
                      entryPrice:r.trade?.entryIdeal||r.price,
                      stopLoss:r.trade?.stopLoss||"",
                      tp1:r.trade?.tp1||"",
                      tp2:r.trade?.tp2||"",
                      tp3:r.trade?.tp3||"",
                      score:String(r.score),
                      smcVerdict:r.smc?.smcVerdict||"",
                      vptVerdict:r.vpt?.verdict||"",
                      note:`評${r.score} · ${r.smc?.smcVerdict||""} · ${r.vpt?.verdict||""}`,
                    });
                    setPage("journal");
                  }}
                  style={{padding:"4px 8px",borderRadius:4,border:"1px solid #1a2035",
                    background:"#0c111e",color:"#7986cb",cursor:"pointer",
                    fontSize:10,fontFamily:"inherit"}}>
                  📋
                </button>
              </div>

              {expanded===r.symbol&&(
                <div style={{borderTop:"1px solid #0f1629",padding:"12px 14px"}}>
                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:9,color:"#7986cb",letterSpacing:2,marginBottom:6}}>K線圖 · MA · BB · SMC</div>
                    <KlineChart candles={r.candles?.slice(-60)||[]} ma30arr={r.ma30arr?.slice(-60)}
                      ma45arr={r.ma45arr?.slice(-60)} ma60arr={r.ma60arr?.slice(-60)}
                      bb={r.bb} trade={r.trade} smc={r.smc} height={240}/>
                    <div style={{display:"flex",gap:10,marginTop:5,flexWrap:"wrap"}}>
                      {[["MA30","#7986cb"],["MA45","#9575cd"],["MA60","#26c6da"],
                        ["OB","#4caf5077"],["FVG","#4caf5044"],["BOS","#4caf50"],
                        ["LIQ","#ff9800"],["SL","#ef5350"],["TP","#4caf50"]].map(([l,c])=>(
                        <span key={l} style={{fontSize:8,color:c,display:"flex",alignItems:"center",gap:2}}>
                          <span style={{width:12,height:2,background:c,display:"inline-block"}}/>
                          {l}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
                    {/* 左：10項指標 */}
                    <div>
                      <div style={{fontSize:9,color:"#3d5afe",letterSpacing:2,marginBottom:8}}>10項評分</div>
                      {r.signals?.map(s=>(
                        <div key={s.key} style={{display:"flex",gap:7,marginBottom:7}}>
                          <span style={{fontSize:12}}>{okIcon(s.ok)}</span>
                          <div style={{flex:1}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:1}}>
                              <span style={{fontSize:10,fontWeight:700,
                                color:s.ok===true?"#4dd0e1":s.ok==="warn"?"#ffb74d":"#455a64"}}>{s.label}</span>
                              <span style={{fontSize:9,color:"#263238"}}>{s.s}/{s.w}pt</span>
                            </div>
                            <div style={{fontSize:9,color:"#546e7a"}}>{s.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                    {/* 中：SMC + 量價 */}
                    <div>
                      <div style={{fontSize:9,color:"#ff9800",letterSpacing:2,marginBottom:8}}>SMC + 量價</div>
                      {r.smc&&(
                        <div style={{marginBottom:10}}>
                          <div style={{background:r.smc.smcBias>=2?"#1b5e2022":r.smc.smcBias<=-2?"#b71c1c22":"#1a2035",
                            borderRadius:7,padding:"8px 10px",border:`1px solid ${r.smc.smcColor}44`,marginBottom:7}}>
                            <div style={{fontSize:14,fontWeight:800,color:r.smc.smcColor}}>{r.smc.smcVerdict}</div>
                            <div style={{fontSize:9,color:"#37474f",marginTop:2}}>偏向 {r.smc.smcBias>0?"+":""}{r.smc.smcBias}</div>
                          </div>
                          {r.smc.smcReasons?.map((rs,j)=>(
                            <div key={j} style={{display:"flex",gap:5,marginBottom:4}}>
                              <span style={{fontSize:10,color:rs.t==="bull"?"#4caf50":"#ef5350",minWidth:10}}>{rs.t==="bull"?"▲":"▼"}</span>
                              <span style={{fontSize:10,color:"#546e7a",lineHeight:1.4}}>{rs.s}</span>
                            </div>
                          ))}
                          {r.smc.bos&&<div style={{fontSize:10,color:r.smc.bos.color,marginTop:4}}>📌 {r.smc.bos.label} @ {r.smc.bos.price?.toFixed(4)}</div>}
                          {r.smc.choch&&<div style={{fontSize:10,color:r.smc.choch.color,marginTop:3}}>🔄 {r.smc.choch.label}</div>}
                        </div>
                      )}
                      {r.vpt&&(
                        <>
                          <div style={{background:r.vpt.verdictBg,borderRadius:6,padding:"7px 9px",
                            border:`1px solid ${r.vpt.verdictColor}44`,marginBottom:6}}>
                            <div style={{fontSize:14,fontWeight:800,color:r.vpt.verdictColor}}>{r.vpt.verdictIcon} {r.vpt.verdict}</div>
                            <div style={{display:"flex",gap:8,marginTop:3}}>
                              <span style={{fontSize:9,color:"#4caf50"}}>多{r.vpt.bullScore}</span>
                              <span style={{fontSize:9,color:"#ef5350"}}>空{r.vpt.bearScore}</span>
                            </div>
                          </div>
                          {r.vpt.reasons?.map((rs,j)=>(
                            <div key={j} style={{display:"flex",gap:5,marginBottom:4}}>
                              <span style={{fontSize:9,color:rs.type==="bull"?"#4caf50":rs.type==="bear"?"#ef5350":"#90a4ae",minWidth:10}}>
                                {rs.type==="bull"?"▲":rs.type==="bear"?"▼":"◆"}
                              </span>
                              <span style={{fontSize:10,color:"#546e7a",lineHeight:1.4}}>{rs.text}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                    {/* 右：進場點位 */}
                    <div>
                      <div style={{marginBottom:10}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#37474f",marginBottom:4}}>
                          <span>評分</span><span style={{color:r.gradeColor,fontWeight:800,fontSize:14}}>{r.score}/100</span>
                        </div>
                        <div style={{height:4,background:"#111827",borderRadius:3}}>
                          <div style={{width:`${r.score}%`,height:"100%",borderRadius:3,background:`linear-gradient(90deg,#283593,${r.gradeColor})`}}/>
                        </div>
                      </div>
                      {(()=>{
                        const dec=calcEntryDecision(r);
                        if(!dec) return null;
                        return(
                          <div style={{background:dec.decisionBg,borderRadius:8,padding:"10px 12px",
                            border:`1px solid ${dec.decisionColor}44`,marginBottom:10}}>
                            <div style={{fontSize:18,fontWeight:900,color:dec.decisionColor,marginBottom:3}}>{dec.decision}</div>
                            <div style={{fontSize:10,color:"#546e7a",marginBottom:8}}>{dec.urgency}</div>
                            {dec.checks.map((ck,j)=>(
                              <div key={j} style={{display:"flex",gap:6,marginBottom:5}}>
                                <span style={{fontSize:12}}>{ck.ok?"✅":ck.must?"❌":"⚠️"}</span>
                                <div>
                                  <span style={{fontSize:10,fontWeight:700,
                                    color:ck.ok?"#4dd0e1":ck.must?"#ef5350":"#ff9800"}}>{ck.label}{ck.must?" ★":""}</span>
                                  <div style={{fontSize:9,color:"#546e7a"}}>{ck.note}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                      {r.trade&&(
                        <div style={{background:"#060c1a",borderRadius:7,padding:"10px 12px",border:"1px solid #4caf5044",marginBottom:8}}>
                          <div style={{fontSize:9,color:"#4caf50",letterSpacing:2,marginBottom:6}}>🚀 交易點位</div>
                          <div style={{fontSize:9,color:"#546e7a",marginBottom:6,background:"#0a1520",padding:"4px 7px",borderRadius:4}}>{r.trade.strategy}</div>
                          <div style={{display:"flex",gap:5,marginBottom:5}}>
                            {[{l:"市價",v:r.trade.entryIdeal,c:"#90a4ae"},{l:"回踩",v:r.trade.entryLimit,c:"#7986cb"}].map(item=>(
                              <div key={item.l} style={{flex:1,background:"#0d2137",borderRadius:4,padding:"5px 7px"}}>
                                <div style={{fontSize:8,color:"#37474f",marginBottom:1}}>{item.l}</div>
                                <div style={{fontSize:11,fontWeight:800,color:item.c}}>{item.v}</div>
                              </div>
                            ))}
                          </div>
                          <div style={{background:"#1a0a0a",borderRadius:4,padding:"5px 9px",border:"1px solid #ef535033",marginBottom:5,display:"flex",justifyContent:"space-between"}}>
                            <div><div style={{fontSize:8,color:"#37474f"}}>🛑 止損</div><div style={{fontSize:12,fontWeight:800,color:"#ef5350"}}>{r.trade.stopLoss}</div></div>
                            <div style={{fontSize:12,color:"#ef5350",fontWeight:700}}>{r.trade.slPct}%</div>
                          </div>
                          {[{l:`TP1(1.5R)`,v:r.trade.tp1,p:r.trade.tp1Pct},{l:`TP2(${r.trade.rr}R)`,v:r.trade.tp2,p:r.trade.tp2Pct},{l:"TP3",v:r.trade.tp3,p:r.trade.tp3Pct}].map((tp,ti)=>(
                            <div key={ti} style={{background:"#0d2820",borderRadius:4,padding:"5px 9px",border:"1px solid #4caf5033",display:"flex",justifyContent:"space-between",marginBottom:4}}>
                              <div><div style={{fontSize:8,color:"#2e7d32"}}>{tp.l}</div><div style={{fontSize:11,fontWeight:700,color:"#4caf50"}}>{tp.v}</div></div>
                              <div style={{fontSize:11,fontWeight:700,color:"#4caf50"}}>+{tp.p}%</div>
                            </div>
                          ))}
                          <div style={{display:"flex",gap:5,marginTop:5}}>
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
                      {r.extras?.length>0&&(
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:7}}>
                          {r.extras.map(ex=>(
                            <div key={ex.label} style={{background:"#060810",borderRadius:5,padding:"6px 9px",border:`1px solid ${ex.color}33`}}>
                              <div style={{fontSize:8,color:"#455a64",marginBottom:1}}>{ex.label}</div>
                              <div style={{fontSize:12,fontWeight:700,color:ex.color}}>{ex.value}</div>
                              <div style={{fontSize:8,color:"#37474f"}}>{ex.note}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      <button onClick={e=>{e.stopPropagation();openNews(r.symbol);}}
                        style={{width:"100%",padding:"7px",borderRadius:5,background:"#060c1a",
                          border:"1px solid #1a2035",color:"#ff9800",cursor:"pointer",fontSize:11,fontFamily:"inherit",marginBottom:6}}>
                        📰 {r.symbol.replace("USDT","")} 最新消息
                      </button>
                      {/* 一鍵記錄到交易日誌 */}
                      <button onClick={e=>{
                        e.stopPropagation();
                        setQuickAdd({
                          symbol:r.symbol,
                          direction:r.vpt?.verdict?.includes("空")?"short":"long",
                          entryPrice:r.trade?.entryIdeal||r.price,
                          stopLoss:r.trade?.stopLoss||"",
                          tp1:r.trade?.tp1||"",
                          tp2:r.trade?.tp2||"",
                          tp3:r.trade?.tp3||"",
                          score:String(r.score),
                          smcVerdict:r.smc?.smcVerdict||"",
                          vptVerdict:r.vpt?.verdict||"",
                          note:`評${r.score} · ${r.smc?.smcVerdict||""} · ${r.vpt?.verdict||""}`,
                        });
                        setPage("journal");
                      }}
                        style={{width:"100%",padding:"9px",borderRadius:6,
                          background:"linear-gradient(135deg,#283593,#1b5e20)",
                          border:"none",color:"#fff",cursor:"pointer",
                          fontSize:12,fontWeight:700,fontFamily:"inherit",marginBottom:6}}>
                        📋 一鍵記錄到交易日誌
                      </button>
                      <div style={{marginTop:4,fontSize:9,color:"#1e293b"}}>⚠️ 僅供參考，合約風險極高。</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}

          {!loading&&results.length>0&&filtered.length===0&&(
            <div style={{textAlign:"center",color:"#263238",marginTop:50,fontSize:12}}>沒有符合篩選條件的標的</div>
          )}
        </>)}
      </div>

      {/* ── 右側通知欄（固定在版面，不浮動）── */}
      <AlertPanel alerts={alerts} onDismiss={i=>{
        if(i==="all") setAlerts([]);
        else setAlerts(prev=>prev.filter((_,j)=>j!==i));
      }}/>
    </div>
  );
}
