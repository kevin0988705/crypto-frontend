import { useState, useEffect, useRef, useCallback } from "react";

const FAPI = "https://fapi.binance.com";
const INTERVALS = [
  { label: "15分鐘", value: "15m" },
  { label: "1小時",  value: "1h"  },
  { label: "4小時",  value: "4h"  },
  { label: "日線",   value: "1d"  },
];

// ══════════════════════════════════════════════════════════════════
// 基礎指標
// ══════════════════════════════════════════════════════════════════
const sma = (arr, n) => arr.length < n ? null : arr.slice(-n).reduce((a, b) => a + b, 0) / n;

function ema(arr, n) {
  if (arr.length < n) return null;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function bollingerBands(closes, n = 20, mult = 2) {
  if (closes.length < n) return null;
  const sl = closes.slice(-n);
  const m = sl.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { mid: m, upper: m + mult * sd, lower: m - mult * sd, width: (mult * 2 * sd) / m };
}

function rsiCalc(closes, n = 14) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? g += d : l -= d;
  }
  return 100 - 100 / (1 + g / (l || 0.0001));
}

function macdCalc(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  return (!e12 || !e26) ? null : { line: e12 - e26, prev: ema(closes.slice(0, -1), 12) - ema(closes.slice(0, -1), 26) || 0 };
}

function stochRsi(closes, rLen = 14, sLen = 14) {
  if (closes.length < rLen + sLen + 1) return null;
  const rArr = [];
  for (let i = rLen; i <= closes.length; i++) {
    const sl = closes.slice(i - rLen - 1, i); let g = 0, l = 0;
    for (let j = 1; j < sl.length; j++) { const d = sl[j] - sl[j - 1]; d >= 0 ? g += d : l -= d; }
    rArr.push(100 - 100 / (1 + g / (l || 0.0001)));
  }
  if (rArr.length < sLen) return null;
  const sl = rArr.slice(-sLen), hi = Math.max(...sl), lo = Math.min(...sl);
  return hi === lo ? 50 : (rArr[rArr.length - 1] - lo) / (hi - lo) * 100;
}

function atrCalc(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = candles.slice(1).map((c, i) => Math.max(c.h - c.l, Math.abs(c.h - candles[i].c), Math.abs(c.l - candles[i].c)));
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function calcOBV(candles) {
  let o = 0; const a = [0];
  for (let i = 1; i < candles.length; i++) {
    o += candles[i].c > candles[i - 1].c ? candles[i].v : candles[i].c < candles[i - 1].c ? -candles[i].v : 0;
    a.push(o);
  }
  return a;
}

// ══════════════════════════════════════════════════════════════════
// SMC 分析引擎
// ══════════════════════════════════════════════════════════════════
function detectSMC(candles) {
  const len = candles.length;
  if (len < 30) return null;

  const swings = [];
  for (let i = 3; i < len - 3; i++) {
    const isHigh = candles[i].h > candles[i - 1].h && candles[i].h > candles[i - 2].h &&
                   candles[i].h > candles[i + 1].h && candles[i].h > candles[i + 2].h;
    const isLow  = candles[i].l < candles[i - 1].l && candles[i].l < candles[i - 2].l &&
                   candles[i].l < candles[i + 1].l && candles[i].l < candles[i + 2].l;
    if (isHigh) swings.push({ idx: i, type: "high", price: candles[i].h });
    if (isLow)  swings.push({ idx: i, type: "low", price: candles[i].l });
  }

  const lastPrice = candles[len - 1].c;
  const recentHighs = swings.filter(s => s.type === "high").slice(-5);
  const recentLows  = swings.filter(s => s.type === "low").slice(-5);
  const lastSwingHigh = recentHighs[recentHighs.length - 1];
  const lastSwingLow  = recentLows[recentLows.length - 1];

  let bos = null;
  if (lastSwingHigh && lastPrice > lastSwingHigh.price) {
    bos = { type: "bullish", price: lastSwingHigh.price, idx: lastSwingHigh.idx,
            label: "BOS 向上突破", color: "#4caf50" };
  } else if (lastSwingLow && lastPrice < lastSwingLow.price) {
    bos = { type: "bearish", price: lastSwingLow.price, idx: lastSwingLow.idx,
            label: "BOS 向下突破", color: "#ef5350" };
  }

  let choch = null;
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const hi1 = recentHighs[recentHighs.length - 1], hi2 = recentHighs[recentHighs.length - 2];
    const lo1 = recentLows[recentLows.length - 1],  lo2 = recentLows[recentLows.length - 2];
    if (hi1.price < hi2.price && lo1.price < lo2.price) {
      choch = { type: "bearish", label: "CHoCH 趨勢由多轉空", color: "#ef5350" };
    } else if (hi1.price > hi2.price && lo1.price > lo2.price) {
      choch = { type: "bullish", label: "CHoCH 趨勢由空轉多", color: "#4caf50" };
    }
  }

  const orderBlocks = [];
  for (let i = 5; i < len - 5; i++) {
    const c = candles[i];
    const isBear = c.c < c.o;
    const isBull = c.c > c.o;
    const afterUp   = candles.slice(i + 1, i + 6).every((x, j, a) => j === 0 || x.c >= a[j - 1].c);
    const afterDown = candles.slice(i + 1, i + 6).every((x, j, a) => j === 0 || x.c <= a[j - 1].c);
    if (isBear && afterUp && i > len - 40) {
      orderBlocks.push({ type: "bull", high: c.h, low: c.l, open: c.o, close: c.c, idx: i,
        label: "多頭OB", color: "#4caf50", colorBg: "#4caf5018" });
    }
    if (isBull && afterDown && i > len - 40) {
      orderBlocks.push({ type: "bear", high: c.h, low: c.l, open: c.o, close: c.c, idx: i,
        label: "空頭OB", color: "#ef5350", colorBg: "#ef535018" });
    }
  }
  const recentOBs = orderBlocks.slice(-4);

  const nearbyOB = recentOBs.filter(ob => {
    const mid = (ob.high + ob.low) / 2;
    return Math.abs(lastPrice - mid) / lastPrice < 0.02;
  });

  const fvgs = [];
  for (let i = 1; i < len - 1; i++) {
    const prev = candles[i - 1], curr = candles[i], next = candles[i + 1];
    if (next.l > prev.h && i > len - 50) {
      fvgs.push({ type: "bull", high: next.l, low: prev.h, idx: i,
        label: "看漲FVG", color: "#4caf50", colorBg: "#4caf5015" });
    }
    if (next.h < prev.l && i > len - 50) {
      fvgs.push({ type: "bear", high: prev.l, low: next.h, idx: i,
        label: "看跌FVG", color: "#ef5350", colorBg: "#ef535015" });
    }
  }
  const unfilledFVGs = fvgs.filter(f => {
    if (f.type === "bull") return lastPrice < f.high;
    return lastPrice > f.low;
  }).slice(-4);

  const liquidity = [];
  for (let i = 0; i < recentHighs.length - 1; i++) {
    const h1 = recentHighs[i], h2 = recentHighs[i + 1];
    if (Math.abs(h1.price - h2.price) / h1.price < 0.005) {
      liquidity.push({ type: "high", price: h1.price, label: "上方流動性（Equal Highs）",
        color: "#ff9800", note: "Smart Money 可能向上獵取" });
    }
  }
  for (let i = 0; i < recentLows.length - 1; i++) {
    const l1 = recentLows[i], l2 = recentLows[i + 1];
    if (Math.abs(l1.price - l2.price) / l1.price < 0.005) {
      liquidity.push({ type: "low", price: l1.price, label: "下方流動性（Equal Lows）",
        color: "#9c27b0", note: "Smart Money 可能向下獵取" });
    }
  }

  let smcBias = 0, smcReasons = [];
  if (bos?.type === "bullish") { smcBias += 3; smcReasons.push({ t: "bull", s: `BOS向上突破 ${bos.price.toFixed(4)}` }); }
  if (bos?.type === "bearish") { smcBias -= 3; smcReasons.push({ t: "bear", s: `BOS向下突破 ${bos.price.toFixed(4)}` }); }
  if (choch?.type === "bullish") { smcBias += 2; smcReasons.push({ t: "bull", s: choch.label }); }
  if (choch?.type === "bearish") { smcBias -= 2; smcReasons.push({ t: "bear", s: choch.label }); }
  nearbyOB.forEach(ob => {
    if (ob.type === "bull") { smcBias += 2; smcReasons.push({ t: "bull", s: `多頭OB支撐附近 ${ob.low.toFixed(4)}–${ob.high.toFixed(4)}` }); }
    if (ob.type === "bear") { smcBias -= 2; smcReasons.push({ t: "bear", s: `空頭OB壓制附近 ${ob.low.toFixed(4)}–${ob.high.toFixed(4)}` }); }
  });
  unfilledFVGs.slice(0, 2).forEach(f => {
    if (f.type === "bull") { smcBias += 1; smcReasons.push({ t: "bull", s: `看漲FVG未填補 ${f.low.toFixed(4)}–${f.high.toFixed(4)}` }); }
    if (f.type === "bear") { smcBias -= 1; smcReasons.push({ t: "bear", s: `看跌FVG未填補 ${f.low.toFixed(4)}–${f.high.toFixed(4)}` }); }
  });

  const smcVerdict = smcBias >= 3 ? "強勢多頭結構" : smcBias >= 1 ? "偏多結構" :
    smcBias <= -3 ? "強勢空頭結構" : smcBias <= -1 ? "偏空結構" : "中性結構";
  const smcColor = smcBias >= 2 ? "#4caf50" : smcBias <= -2 ? "#ef5350" : "#90a4ae";

  return { bos, choch, orderBlocks: recentOBs, fvgs: unfilledFVGs,
    liquidity, smcBias, smcVerdict, smcColor, smcReasons, swings };
}

// ══════════════════════════════════════════════════════════════════
// K線圖組件（Canvas）
// ══════════════════════════════════════════════════════════════════
function KlineChart({ candles, ma30arr, ma45arr, ma60arr, bb, trade, smc, height = 280 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !candles || candles.length < 2) return;
    const canvas = canvasRef.current;
    const ctx    = canvas.getContext("2d");
    const W = canvas.width, H = height;
    canvas.height = H;
    ctx.clearRect(0, 0, W, H);

    const display = candles.slice(-60);
    const n = display.length;
    const allH = display.map(c => c.h), allL = display.map(c => c.l);

    const maVals = [...(ma30arr || []), ...(ma45arr || []), ...(ma60arr || [])].filter(Boolean);
    const bbVals = bb ? [bb.upper, bb.lower] : [];
    const tpVals = trade ? [trade.tp3n, trade.stopLossN, trade.entryN].filter(Boolean) : [];

    const allVals = [...allH, ...allL, ...maVals, ...bbVals, ...tpVals];
    const hi = Math.max(...allVals), lo = Math.min(...allVals);
    const pad = (hi - lo) * 0.08;
    const yHi = hi + pad, yLo = lo - pad;

    const toY = v => H - ((v - yLo) / (yHi - yLo)) * H;
    const candleW = Math.max(3, Math.floor(W / n) - 1);
    const toX = i => i * (W / n) + (W / n - candleW) / 2;

    ctx.strokeStyle = "#1a2035"; ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = H * i / 4;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      const price = (yHi - (yHi - yLo) * i / 4);
      ctx.fillStyle = "#263238"; ctx.font = "9px monospace";
      ctx.fillText(price >= 1000 ? price.toFixed(1) : price >= 1 ? price.toFixed(3) : price.toFixed(5), 2, y - 2);
    }

    if (bb && display.length >= 20) {
      const bbDisp = candles.slice(-60);
      const bbSlice = candles.slice(-(60 + 20));
      ctx.fillStyle = "rgba(121,134,203,0.06)";
      ctx.beginPath();
      bbDisp.forEach((_, i) => {
        const sl = bbSlice.slice(i, i + 20).map(c => c.c);
        const m = sl.reduce((a, b) => a + b, 0) / 20;
        const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
        const u = m + 2 * sd;
        if (i === 0) ctx.moveTo(toX(i) + candleW / 2, toY(u));
        else ctx.lineTo(toX(i) + candleW / 2, toY(u));
      });
      for (let i = bbDisp.length - 1; i >= 0; i--) {
        const sl = bbSlice.slice(i, i + 20).map(c => c.c);
        const m = sl.reduce((a, b) => a + b, 0) / 20;
        const sd = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
        const l2 = m - 2 * sd;
        ctx.lineTo(toX(i) + candleW / 2, toY(l2));
      }
      ctx.closePath(); ctx.fill();
    }

    if (smc?.fvgs) {
      smc.fvgs.forEach(f => {
        const startIdx = Math.max(0, f.idx - (candles.length - 60));
        if (startIdx >= 0 && startIdx < n) {
          ctx.fillStyle = f.type === "bull" ? "rgba(76,175,80,0.12)" : "rgba(239,83,80,0.12)";
          ctx.fillRect(toX(startIdx), toY(f.high), W - toX(startIdx), toY(f.low) - toY(f.high));
          ctx.strokeStyle = f.type === "bull" ? "#4caf5044" : "#ef535044";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(toX(startIdx), toY(f.high), W - toX(startIdx), toY(f.low) - toY(f.high));
          ctx.fillStyle = f.type === "bull" ? "#4caf5088" : "#ef535088";
          ctx.font = "8px monospace"; ctx.fillText("FVG", toX(startIdx) + 2, toY(f.high) + 9);
        }
      });
    }

    if (smc?.orderBlocks) {
      smc.orderBlocks.forEach(ob => {
        const startIdx = Math.max(0, ob.idx - (candles.length - 60));
        if (startIdx >= 0 && startIdx < n) {
          ctx.fillStyle = ob.type === "bull" ? "rgba(76,175,80,0.15)" : "rgba(239,83,80,0.15)";
          ctx.fillRect(toX(startIdx), toY(ob.high), W - toX(startIdx), toY(ob.low) - toY(ob.high));
          ctx.strokeStyle = ob.type === "bull" ? "#4caf5077" : "#ef535077";
          ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
          ctx.strokeRect(toX(startIdx), toY(ob.high), W - toX(startIdx), toY(ob.low) - toY(ob.high));
          ctx.setLineDash([]);
          ctx.fillStyle = ob.type === "bull" ? "#4caf50bb" : "#ef5350bb";
          ctx.font = "8px monospace";
          ctx.fillText(ob.type === "bull" ? "OB↑" : "OB↓", toX(startIdx) + 2, toY(ob.high) + 9);
        }
      });
    }

    const drawMA = (arr, col) => {
      if (!arr || arr.length < 2) return;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      arr.slice(-60).forEach((v, i) => { if (!v) return; i === 0 ? ctx.moveTo(toX(i) + candleW / 2, toY(v)) : ctx.lineTo(toX(i) + candleW / 2, toY(v)); });
      ctx.stroke();
    };
    drawMA(ma30arr, "#7986cb"); drawMA(ma45arr, "#9575cd"); drawMA(ma60arr, "#26c6da");

    display.forEach((c, i) => {
      const x = toX(i), isBull = c.c >= c.o;
      const col = isBull ? "#4caf50" : "#ef5350";
      const bodyTop = toY(Math.max(c.o, c.c)), bodyBot = toY(Math.min(c.o, c.c));
      const bodyH = Math.max(1, bodyBot - bodyTop);
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + candleW / 2, toY(c.h)); ctx.lineTo(x + candleW / 2, bodyTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + candleW / 2, bodyBot); ctx.lineTo(x + candleW / 2, toY(c.l)); ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(x, bodyTop, candleW, bodyH);
    });

    if (smc?.liquidity) {
      smc.liquidity.slice(0, 3).forEach(liq => {
        ctx.strokeStyle = liq.type === "high" ? "#ff980088" : "#9c27b088";
        ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(0, toY(liq.price)); ctx.lineTo(W, toY(liq.price)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = liq.type === "high" ? "#ff9800" : "#9c27b0";
        ctx.font = "8px monospace"; ctx.fillText("LIQ", W - 28, toY(liq.price) - 2);
      });
    }

    if (smc?.bos) {
      ctx.strokeStyle = smc.bos.color + "88"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(0, toY(smc.bos.price)); ctx.lineTo(W, toY(smc.bos.price)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = smc.bos.color; ctx.font = "9px monospace";
      ctx.fillText("BOS", 4, toY(smc.bos.price) - 3);
    }

    if (trade) {
      const lines = [
        { v: trade.entryN, col: "#90a4ae", label: "進場" },
        { v: trade.stopLossN, col: "#ef5350", label: "SL" },
        { v: trade.tp1N, col: "#81c784", label: "TP1" },
        { v: trade.tp2N, col: "#4caf50", label: "TP2" },
        { v: trade.tp3N, col: "#2e7d32", label: "TP3" },
      ].filter(l => l.v);
      lines.forEach(l => {
        ctx.strokeStyle = l.col + "99"; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(0, toY(l.v)); ctx.lineTo(W, toY(l.v)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = l.col; ctx.font = "bold 9px monospace";
        ctx.fillText(l.label, W - 28, toY(l.v) - 3);
      });
    }

    const lastC = display[display.length - 1];
    ctx.strokeStyle = "#90a4ae44"; ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, toY(lastC.c)); ctx.lineTo(W, toY(lastC.c)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#90a4ae"; ctx.font = "9px monospace";
    ctx.fillText(lastC.c >= 1000 ? lastC.c.toFixed(2) : lastC.c >= 1 ? lastC.c.toFixed(4) : lastC.c.toFixed(6), 2, toY(lastC.c) - 3);

  }, [candles, ma30arr, ma45arr, ma60arr, bb, trade, smc, height]);

  return (
    <canvas ref={canvasRef} width={700} height={height}
      style={{ width: "100%", height: height, borderRadius: 6, background: "#060c1a",
        border: "1px solid #1a2035", display: "block" }} />
  );
}

// ══════════════════════════════════════════════════════════════════
// 量價分析
// ══════════════════════════════════════════════════════════════════
function volPriceTrend(candles) {
  const obv = calcOBV(candles), l = obv.length;
  const obvS5 = l >= 5 ? obv.slice(-5).reduce((a, b) => a + b, 0) / 5 : null;
  const obvS20 = l >= 20 ? obv.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const obvUp = obvS5 != null && obvS20 != null ? obvS5 > obvS20 : null;
  const vols = candles.map(c => c.v), closes = candles.map(c => c.c);
  const vol20avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const vr = vol20avg ? vols[vols.length - 1] / vol20avg : 1;
  const slope = closes.length >= 20 ? (closes[closes.length - 1] - closes[closes.length - 20]) / closes[closes.length - 20] : 0;

  let bull = 0, bear = 0; const reasons = [];
  if (obvUp === true) { bull += 3; reasons.push({ type: "bull", text: "OBV上升，資金淨流入" }); }
  if (obvUp === false) { bear += 3; reasons.push({ type: "bear", text: "OBV下降，資金流出" }); }
  const r5 = candles.slice(-5); let puvu = 0, puvd = 0, pdvd = 0, pdvu = 0;
  for (let i = 1; i < r5.length; i++) {
    const pu = r5[i].c > r5[i - 1].c, vu = r5[i].v > r5[i - 1].v;
    if (pu && vu) puvu++; else if (pu && !vu) puvd++; else if (!pu && vu) pdvu++; else pdvd++;
  }
  if (puvu >= 2) { bull += 2; reasons.push({ type: "bull", text: `${puvu}根價漲量增` }); }
  if (pdvd >= 2) { bull += 1; reasons.push({ type: "bull", text: `下跌量縮（${pdvd}根）` }); }
  if (puvd >= 2) { bear += 2; reasons.push({ type: "bear", text: `${puvd}根價漲量縮` }); }
  if (pdvu >= 2) { bear += 2; reasons.push({ type: "bear", text: `${pdvu}根下跌放量` }); }
  if (vr > 2 && slope > 0) { bull += 2; reasons.push({ type: "bull", text: `量比${vr.toFixed(1)}x放量上攻` }); }
  else if (vr > 2 && slope < 0) { bear += 2; reasons.push({ type: "bear", text: `量比${vr.toFixed(1)}x放量下跌` }); }

  const verdict = bull > bear + 2 ? "偏多" : bear > bull + 2 ? "偏空" : bull > bear ? "略偏多" : bear > bull ? "略偏空" : "中性";
  const verdictColor = verdict === "偏多" ? "#4caf50" : verdict === "偏空" ? "#ef5350" :
    verdict === "略偏多" ? "#8bc34a" : verdict === "略偏空" ? "#ff7043" : "#90a4ae";
  const verdictBg = verdict.includes("多") ? "#1b5e2022" : verdict.includes("空") ? "#b71c1c22" : "#1a2035";
  const verdictIcon = verdict === "偏多" ? "▲" : verdict === "偏空" ? "▼" : verdict === "略偏多" ? "△" : verdict === "略偏空" ? "▽" : "◆";
  return { verdict, verdictColor, verdictBg, verdictIcon, bullScore: bull, bearScore: bear,
    obvTrend: obvUp === true ? "up" : obvUp === false ? "down" : null, volRatioVal: vr?.toFixed(2), reasons };
}

// ══════════════════════════════════════════════════════════════════
// 10項評分
// ══════════════════════════════════════════════════════════════════
function scoreSymbol(candles, ma30, ma45, ma60) {
  const closes = candles.map(c => c.c), vols = candles.map(c => c.v), last = closes[closes.length - 1];
  const aboveAll = last > ma30 && last > ma45 && last > ma60, maFan = ma30 > ma45 && ma45 > ma60;
  let score = 0; const signals = [];

  if (aboveAll) { score += 20; signals.push({ key: "ma", label: "①均線排列", w: 20, s: 20, ok: true, detail: `站上MA30/45/60${maFan ? "，多頭✨" : ""}` }); }
  else { signals.push({ key: "ma", label: "①均線排列", w: 20, s: 0, ok: false, detail: "未站上三均線" }); }

  const vol10avg = vols.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
  const shrinkPct = vol10avg ? (vol10avg - vols[vols.length - 1]) / vol10avg : 0;
  const sp = (shrinkPct * 100).toFixed(1);
  if (shrinkPct > 0.25) { score += 12; signals.push({ key: "vol", label: "②縮量", w: 12, s: 12, ok: true, detail: `量縮${sp}%` }); }
  else if (shrinkPct > 0.1) { score += 6; signals.push({ key: "vol", label: "②縮量", w: 12, s: 6, ok: "warn", detail: `略縮${sp}%` }); }
  else { signals.push({ key: "vol", label: "②縮量", w: 12, s: 0, ok: false, detail: `無萎縮（${sp}%）` }); }

  const bb = bollingerBands(closes, 20);
  if (bb) {
    const bp = (bb.width * 100).toFixed(2);
    if (bb.width < 0.04) { score += 12; signals.push({ key: "bb", label: "③BB Squeeze", w: 12, s: 12, ok: true, detail: `帶寬${bp}%` }); }
    else if (bb.width < 0.07) { score += 6; signals.push({ key: "bb", label: "③BB收窄", w: 12, s: 6, ok: "warn", detail: `帶寬${bp}%` }); }
    else { signals.push({ key: "bb", label: "③BB收窄", w: 12, s: 0, ok: false, detail: `帶寬${bp}%` }); }
  }

  const rsi = rsiCalc(closes);
  if (rsi != null) {
    const r = rsi.toFixed(1);
    if (rsi >= 45 && rsi <= 62) { score += 10; signals.push({ key: "rsi", label: "④RSI蓄力", w: 10, s: 10, ok: true, detail: `RSI ${r}` }); }
    else if (rsi > 62 && rsi < 70) { score += 5; signals.push({ key: "rsi", label: "④RSI偏強", w: 10, s: 5, ok: "warn", detail: `RSI ${r}` }); }
    else if (rsi > 30 && rsi < 45) { score += 4; signals.push({ key: "rsi", label: "④RSI偏弱", w: 10, s: 4, ok: "warn", detail: `RSI ${r}` }); }
    else { signals.push({ key: "rsi", label: "④RSI", w: 10, s: 0, ok: false, detail: `RSI ${r}` }); }
  }

  const sl10 = candles.slice(-10), hi10 = Math.max(...sl10.map(c => c.h)), lo10 = Math.min(...sl10.map(c => c.l));
  const prPct = lo10 ? (hi10 - lo10) / lo10 : 1;
  const pp = (prPct * 100).toFixed(2);
  if (prPct < 0.04) { score += 10; signals.push({ key: "range", label: "⑤橫盤", w: 10, s: 10, ok: true, detail: `幅度${pp}%` }); }
  else if (prPct < 0.07) { score += 5; signals.push({ key: "range", label: "⑤橫盤", w: 10, s: 5, ok: "warn", detail: `幅度${pp}%` }); }
  else { signals.push({ key: "range", label: "⑤橫盤", w: 10, s: 0, ok: false, detail: `幅度${pp}%` }); }

  const macdR = macdCalc(closes);
  if (macdR) {
    if (macdR.line > 0 && macdR.prev < 0) { score += 8; signals.push({ key: "macd", label: "⑥MACD金叉", w: 8, s: 8, ok: true, detail: "穿越零軸" }); }
    else if (macdR.line > 0) { score += 5; signals.push({ key: "macd", label: "⑥MACD偏多", w: 8, s: 5, ok: "warn", detail: `${macdR.line.toFixed(4)}` }); }
    else { signals.push({ key: "macd", label: "⑥MACD偏空", w: 8, s: 0, ok: false, detail: `${macdR.line.toFixed(4)}` }); }
  }

  const stoch = stochRsi(closes);
  if (stoch != null) {
    const s = stoch.toFixed(1);
    if (stoch < 20) { score += 8; signals.push({ key: "stoch", label: "⑦StochRSI超賣", w: 8, s: 8, ok: true, detail: `${s}` }); }
    else if (stoch < 40) { score += 5; signals.push({ key: "stoch", label: "⑦StochRSI偏低", w: 8, s: 5, ok: "warn", detail: `${s}` }); }
    else if (stoch > 80) { signals.push({ key: "stoch", label: "⑦StochRSI超買", w: 8, s: 0, ok: false, detail: `${s}` }); }
    else { score += 3; signals.push({ key: "stoch", label: "⑦StochRSI中性", w: 8, s: 3, ok: "warn", detail: `${s}` }); }
  }

  const atrNow = atrCalc(candles);
  if (atrNow && last > 0) {
    const ap = (atrNow / last * 100).toFixed(2);
    if (atrNow / last < 0.02) { score += 8; signals.push({ key: "atr", label: "⑧ATR極低", w: 8, s: 8, ok: true, detail: `${ap}%` }); }
    else if (atrNow / last < 0.04) { score += 4; signals.push({ key: "atr", label: "⑧ATR收縮", w: 8, s: 4, ok: "warn", detail: `${ap}%` }); }
    else { signals.push({ key: "atr", label: "⑧ATR偏高", w: 8, s: 0, ok: false, detail: `${ap}%` }); }
  }

  const e9 = ema(closes, 9), e21 = ema(closes, 21), e9p = ema(closes.slice(0, -1), 9), e21p = ema(closes.slice(0, -1), 21);
  if (e9 && e21) {
    if (e9 > e21 && e9p && e9p <= e21p) { score += 6; signals.push({ key: "ema", label: "⑨EMA金叉", w: 6, s: 6, ok: true, detail: "EMA9穿EMA21" }); }
    else if (e9 > e21) { score += 4; signals.push({ key: "ema", label: "⑨EMA多頭", w: 6, s: 4, ok: "warn", detail: "9>21" }); }
    else { signals.push({ key: "ema", label: "⑨EMA空頭", w: 6, s: 0, ok: false, detail: "9<21" }); }
  }

  const obvArr = calcOBV(candles);
  const oS5 = obvArr.slice(-5).reduce((a, b) => a + b, 0) / 5, oS20 = obvArr.slice(-20).reduce((a, b) => a + b, 0) / 20;
  if (oS5 > oS20 * 1.02) { score += 6; signals.push({ key: "obv", label: "⑩OBV上升", w: 6, s: 6, ok: true, detail: "資金淨流入" }); }
  else if (oS5 > oS20) { score += 3; signals.push({ key: "obv", label: "⑩OBV略升", w: 6, s: 3, ok: "warn", detail: "小幅流入" }); }
  else { signals.push({ key: "obv", label: "⑩OBV下降", w: 6, s: 0, ok: false, detail: "資金流出" }); }

  const isEntry = score >= 70 && aboveAll && shrinkPct > 0.1 && (bb && bb.width < 0.07) && (rsi && rsi >= 40 && rsi <= 65);
  return { score, signals, aboveAll, maFan, isEntry, atrNow, rsi, shrinkPct, bb, candles };
}

// ══════════════════════════════════════════════════════════════════
// 進場點位計算
// ══════════════════════════════════════════════════════════════════
function calcTradeSetup(candles, last, atrNow, ma30, ma45, ma60, score) {
  if (!atrNow || !last) return null;
  const recent = candles.slice(-30);
  const pivotHi = Math.max(...recent.map(c => c.h)), pivotLo = Math.min(...recent.map(c => c.l));
  const recentLo5 = Math.min(...candles.slice(-5).map(c => c.l));
  const confidence = score >= 85 ? 3.0 : score >= 70 ? 2.0 : 1.5;
  const entry = last, entryLimit = Math.max(ma30, last * 0.998);
  const sl = Math.max(recentLo5 - atrNow * 0.5, ma45 - atrNow * 0.8, last * 0.97);
  const risk = entry - sl;
  const tp1 = entry + risk * 1.5, tp2 = entry + risk * confidence;
  const tp3 = Math.min(pivotHi * 1.002, entry + risk * (confidence + 1.5));
  const fmt = n => n >= 1000 ? n.toFixed(2) : n >= 10 ? n.toFixed(3) : n >= 1 ? n.toFixed(4) : n.toFixed(6);
  return {
    strategy: score >= 85 ? "突破追多" : score >= 70 ? "回踩做多" : "輕倉試多",
    entryIdeal: fmt(entry), entryLimit: fmt(entryLimit),
    stopLoss: fmt(sl), slPct: ((sl - entry) / entry * 100).toFixed(2),
    tp1: fmt(tp1), tp1Pct: ((tp1 - entry) / entry * 100).toFixed(2),
    tp2: fmt(tp2), tp2Pct: ((tp2 - entry) / entry * 100).toFixed(2),
    tp3: fmt(tp3), tp3Pct: ((tp3 - entry) / entry * 100).toFixed(2),
    rr: confidence.toFixed(1), pivotHi: fmt(pivotHi), pivotLo: fmt(pivotLo),
    positionPct: score >= 85 ? "5–8%" : score >= 70 ? "3–5%" : "1–3%",
    entryN: entry, stopLossN: sl, tp1N: tp1, tp2N: tp2, tp3N: tp3,
  };
}

// ══════════════════════════════════════════════════════════════════
// 暴漲/暴跌偵測
// ══════════════════════════════════════════════════════════════════
function detectSurge(candles, last, ma30, ma45, fr) {
  const closes = candles.map(c => c.c), vols = candles.map(c => c.v), highs = candles.map(c => c.h);
  const obv = calcOBV(candles); const obvNow = obv[obv.length - 1], obvPrev = obv[obv.length - 6] || 0;
  const obvSurge = obvPrev !== 0 ? (obvNow - obvPrev) / Math.abs(obvPrev) : 0;
  const vol20avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const vr = vol20avg ? vols[vols.length - 1] / vol20avg : 1;
  const hi30 = Math.max(...highs.slice(-30));
  const breakout = last >= hi30 * 0.998;
  const bw = bollingerBands(closes, 20)?.width;
  const bwPrev = bollingerBands(closes.slice(0, -3), 20)?.width;
  const squeezeBreak = bw && bwPrev && bwPrev < 0.05 && bw > bwPrev * 1.3 && vr > 2;
  const rsiNow = rsiCalc(closes), rsiPrev = rsiCalc(closes.slice(0, -3));
  const rsiSurge = rsiNow && rsiPrev && rsiNow - rsiPrev > 15 && rsiNow > 50;
  const slope = closes.length >= 6 ? (last - closes[closes.length - 6]) / closes[closes.length - 6] : 0;

  const reasons = []; let s = 0;
  if (vr > 3) { s += 3; reasons.push(`量比${vr.toFixed(1)}x異常爆量`); }
  else if (vr > 2) { s += 1; reasons.push(`量比${vr.toFixed(1)}x放量`); }
  if (obvSurge > 0.3) { s += 2; reasons.push(`OBV急升${(obvSurge * 100).toFixed(0)}%`); }
  if (breakout) { s += 3; reasons.push(`突破30日高點${hi30.toFixed(4)}`); }
  if (squeezeBreak) { s += 3; reasons.push("BB Squeeze後爆量突破"); }
  if (rsiSurge) { s += 2; reasons.push(`RSI急升+${(rsiNow - rsiPrev).toFixed(0)}pt`); }
  if (slope > 0.05) { s += 2; reasons.push(`近5根漲${(slope * 100).toFixed(1)}%`); }
  return { isSurge: s >= 5, surgeScore: s,
    surgeStrength: s >= 8 ? "🚀🚀 極強爆漲" : s >= 5 ? "🚀 暴漲預警" : "", surgeReasons: reasons };
}

function detectCrash(candles, last, ma30, ma45, fr) {
  const closes = candles.map(c => c.c), vols = candles.map(c => c.v);
  const highs = candles.map(c => c.h);
  const obv = calcOBV(candles);
  const hi10 = Math.max(...highs.slice(-10)), hi20 = Math.max(...highs.slice(-20, -10));
  const obvHi10 = Math.max(...obv.slice(-10)), obvHi20 = Math.max(...obv.slice(-20, -10));
  const obvDiverg = hi10 > hi20 && obvHi10 < obvHi20;
  const vol20avg = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const vr = vol20avg ? vols[vols.length - 1] / vol20avg : 1;
  const lastC = candles[candles.length - 1];
  const uShadow = lastC.h - Math.max(lastC.o, lastC.c);
  const body = Math.abs(lastC.c - lastC.o);
  const longUpper = uShadow > body * 2 && uShadow / lastC.h > 0.02;
  const rsiNow = rsiCalc(closes); const shrink = vol20avg ? (vol20avg - vols[vols.length - 1]) / vol20avg : 0;
  const rsiOB = rsiNow && rsiNow > 75 && shrink > 0.2;
  const maBelowBreak = closes[closes.length - 2] > ma30 && last < ma30;
  const slope = closes.length >= 6 ? (last - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
  const frOverheat = fr && fr > 0.08;

  const reasons = []; let s = 0;
  if (obvDiverg) { s += 3; reasons.push("OBV頂背離，資金偷跑"); }
  if (longUpper) { s += 3; reasons.push("高位長上影線，拉高出貨"); }
  if (rsiOB) { s += 3; reasons.push(`RSI超買${rsiNow?.toFixed(0)}+量縮`); }
  if (maBelowBreak) { s += 2; reasons.push("跌破MA30，趨勢轉弱"); }
  if (vr > 2 && slope < 0) { s += 3; reasons.push(`放量${vr.toFixed(1)}x下跌`); }
  if (frOverheat) { s += 2; reasons.push(`資金費率${fr?.toFixed(4)}%過熱`); }
  if (slope < -0.05) { s += 2; reasons.push(`近5根跌${(Math.abs(slope) * 100).toFixed(1)}%`); }
  return { isCrash: s >= 5, crashScore: s,
    crashStrength: s >= 8 ? "💥💥 極危" : s >= 5 ? "💥 暴跌預警" : "", crashReasons: reasons };
}

// ══════════════════════════════════════════════════════════════════
// 主分析函式
// ══════════════════════════════════════════════════════════════════
async function analyseSymbol(symbol, interval) {
  const [klRes, frRes, oiRes] = await Promise.allSettled([
    fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=120`).then(r => r.json()),
    fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`).then(r => r.json()),
    fetch(`${FAPI}/fapi/v1/openInterest?symbol=${symbol}`).then(r => r.json()),
  ]);
  if (klRes.status !== "fulfilled" || !Array.isArray(klRes.value) || klRes.value.length < 65) return null;
  const candles = klRes.value.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  const closes = candles.map(c => c.c), last = closes[closes.length - 1];
  const ma30 = sma(closes, 30), ma45 = sma(closes, 45), ma60 = sma(closes, 60);
  if (!ma30 || !ma45 || !ma60) return null;

  const ma30arr = closes.map((_, i) => i < 29 ? null : sma(closes.slice(0, i + 1), 30));
  const ma45arr = closes.map((_, i) => i < 44 ? null : sma(closes.slice(0, i + 1), 45));
  const ma60arr = closes.map((_, i) => i < 59 ? null : sma(closes.slice(0, i + 1), 60));

  const { score, signals, aboveAll, maFan, isEntry, atrNow } = scoreSymbol(candles, ma30, ma45, ma60);
  const vpt   = volPriceTrend(candles);
  const bb    = bollingerBands(closes, 20);
  const trade = isEntry ? calcTradeSetup(candles, last, atrNow, ma30, ma45, ma60, score) : null;
  const smc   = detectSMC(candles);

  let frVal = null;
  try {
    if (frRes.status === "fulfilled" && Array.isArray(frRes.value) && frRes.value[0])
      frVal = parseFloat(frRes.value[0].fundingRate) * 100;
  } catch (_) {}

  const surge = detectSurge(candles, last, ma30, ma45, frVal);
  const crash = detectCrash(candles, last, ma30, ma45, frVal);

  const extras = [];
  if (frVal != null) extras.push({ label: "資金費率", value: `${frVal.toFixed(4)}%`,
    note: frVal > 0.01 ? "正費率偏熱" : frVal < -0.01 ? "負費率潛在軋空" : "中性",
    color: frVal > 0.05 ? "#ef5350" : frVal < -0.01 ? "#ff9500" : "#4dd0e1" });
  try {
    if (oiRes.status === "fulfilled" && oiRes.value?.openInterest) {
      const oi = parseFloat(oiRes.value.openInterest);
      extras.push({ label: "未平倉量", value: oi > 1e9 ? `${(oi / 1e9).toFixed(2)}B` : `${(oi / 1e6).toFixed(1)}M`, note: "USDT", color: "#9fa8da" });
    }
  } catch (_) {}

  const gradeColor = score >= 85 ? "#ff4d4d" : score >= 70 ? "#ff9500" : score >= 50 ? "#f5c518" : "#455a64";
  const grade = score >= 85 ? "🔥 極強" : score >= 70 ? "⚡ 強訊號" : score >= 50 ? "👀 留意" : "😴 觀察";

  return { symbol, score, grade, gradeColor, price: last.toFixed(4),
    ma30: ma30.toFixed(4), ma45: ma45.toFixed(4), ma60: ma60.toFixed(4),
    aboveAll, maFan, isEntry, signals, extras, vpt, trade, surge, crash, smc,
    candles, ma30arr, ma45arr, ma60arr, bb, news: [] };
}

async function getTopSymbols(limit = 100) {
  const res = await fetch(`${FAPI}/fapi/v1/ticker/24hr`);
  const data = await res.json();
  return data.filter(d => d.symbol.endsWith("USDT") && !d.symbol.includes("_"))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, limit).map(d => d.symbol);
}

// ══════════════════════════════════════════════════════════════════
// 立刻進場決策引擎
// ══════════════════════════════════════════════════════════════════
function calcEntryDecision(r) {
  if (!r) return null;
  const checks = [];

  const c1 = r.aboveAll;
  checks.push({ label: "站上MA30/45/60", ok: c1, must: true,
    note: c1 ? "三條均線全部站上✅" : "未站上均線，禁止進場❌" });

  const c2 = r.score >= 70;
  checks.push({ label: "綜合評分≥70", ok: c2, must: true,
    note: c2 ? `評分${r.score}分✅` : `評分只有${r.score}分，條件不足❌` });

  const c3 = r.vpt?.verdict?.includes("多");
  checks.push({ label: "量價偏多", ok: c3, must: true,
    note: c3 ? `${r.vpt.verdict}✅` : `量價${r.vpt?.verdict || "不明"}，方向不對❌` });

  const c4 = r.crash?.isCrash !== true;
  checks.push({ label: "無暴跌預警", ok: c4, must: true,
    note: c4 ? "無暴跌預警✅" : "⚠️ 偵測到暴跌訊號，禁止做多❌" });

  const b1 = r.smc?.smcBias >= 1;
  checks.push({ label: "SMC結構偏多", ok: b1, must: false,
    note: b1 ? `${r.smc.smcVerdict}✅` : "SMC結構中性或偏空⚠️" });

  const b2 = r.bb?.width < 0.07;
  checks.push({ label: "布林帶收窄", ok: b2, must: false,
    note: b2 ? `帶寬${(r.bb?.width * 100).toFixed(2)}%✅` : "布林帶未收窄⚠️" });

  const b3 = r.surge?.isSurge;
  checks.push({ label: "有爆漲訊號", ok: b3, must: false,
    note: b3 ? `${r.surge.surgeStrength}✅` : "無爆漲前兆（普通進場）" });

  const b4 = r.smc?.bos?.type === "bullish";
  checks.push({ label: "BOS向上突破", ok: b4, must: false,
    note: b4 ? "結構向上突破確認✅" : "無BOS突破" });

  const mustFail = checks.filter(c => c.must && !c.ok).length;
  const bonusOk  = checks.filter(c => !c.must && c.ok).length;
  const bonusTotal = checks.filter(c => !c.must).length;

  let decision, decisionColor, decisionBg, urgency;

  if (mustFail > 0) {
    decision = "❌ 禁止進場";
    decisionColor = "#ef5350";
    decisionBg = "#1a0505";
    urgency = "必要條件未達標，等待機會";
  } else if (bonusOk >= 3) {
    decision = "🚀 立刻進場";
    decisionColor = "#4caf50";
    decisionBg = "#0d2820";
    urgency = "所有條件齊備，這是最佳機會";
  } else if (bonusOk >= 2) {
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

function AlertSidebar({ alerts, onDismiss }) {
  if (!alerts.length) return null;

  return (
    <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", gap: 12, maxWidth: 400 }}>
      {alerts.map((a, i) => {
        const isSurge = a.alertType === "surge", isCrash = a.alertType === "crash";
        const bc = isCrash ? "#ef5350" : isSurge ? "#ff9800" : "#4caf50";
        const bg = isCrash ? "linear-gradient(135deg,#1a0505,#1a0a00)" :
                   isSurge ? "linear-gradient(135deg,#1a1000,#1a1500)" :
                   "linear-gradient(135deg,#0d2137,#0d2820)";
        const title = isCrash ? "💥 暴跌預警" : isSurge ? "🚀 暴漲預警" : "🚀 進場訊號";
        const reasons = isCrash ? a.crash?.crashReasons : isSurge ? a.surge?.surgeReasons : null;
        const dec = !isSurge && !isCrash ? calcEntryDecision(a) : null;
        return (
          <div key={a.symbol + i} style={{ background: bg, border: `2px solid ${bc}`, borderRadius: 14, padding: "16px 18px", boxShadow: `0 10px 40px #00000099,0 0 24px ${bc}55` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: bc, letterSpacing: 3, marginBottom: 5, fontWeight: 700 }}>{title}</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#e8eaf6", marginBottom: 8, lineHeight: 1.1 }}>
                  {a.symbol.replace("USDT", "")}
                  <span style={{ fontSize: 13, color: "#37474f", marginLeft: 8 }}>/USDT</span>
                </div>
                {dec && (
                  <div style={{ background: dec.decisionBg, borderRadius: 10, padding: "10px 14px", border: `1px solid ${dec.decisionColor}55`, marginBottom: 10 }}>
                    <div style={{ fontSize: 20, fontWeight: 900, color: dec.decisionColor, marginBottom: 4 }}>{dec.decision}</div>
                    <div style={{ fontSize: 12, color: "#546e7a" }}>{dec.urgency}</div>
                  </div>
                )}
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: "#ff9800", background: "#ff950022", padding: "3px 9px", borderRadius: 5, fontWeight: 700 }}>評分 {a.score}/100</span>
                  {a.smc && <span style={{ fontSize: 13, color: a.smc.smcColor, background: `${a.smc.smcColor}18`, padding: "3px 9px", borderRadius: 5, fontWeight: 700 }}>{a.smc.smcVerdict}</span>}
                  {a.vpt && <span style={{ fontSize: 13, color: a.vpt.verdictColor, background: a.vpt.verdictBg, padding: "3px 9px", borderRadius: 5, fontWeight: 700 }}>{a.vpt.verdictIcon} {a.vpt.verdict}</span>}
                </div>
                {!isSurge && !isCrash && a.trade && (
                  <div style={{ background: "#060c1a", borderRadius: 8, padding: "10px 12px", border: `1px solid ${bc}44`, fontSize: 13 }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 6 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: "#37474f", marginBottom: 2 }}>📍 進場</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#e8eaf6" }}>{a.trade.entryIdeal}</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: "#37474f", marginBottom: 2 }}>🛑 止損</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#ef5350" }}>{a.trade.stopLoss}</div>
                        <div style={{ fontSize: 11, color: "#546e7a" }}>{a.trade.slPct}%</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 10, color: "#37474f", marginBottom: 2 }}>🎯 TP1</div>
                        <div style={{ fontSize: 15, fontWeight: 800, color: "#4caf50" }}>{a.trade.tp1}</div>
                        <div style={{ fontSize: 11, color: "#546e7a" }}>+{a.trade.tp1Pct}%</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#455a64", borderTop: "1px solid #1a2035", paddingTop: 6 }}>
                      <span>風報比 1:{a.trade.rr}</span>
                      <span>倉位 {a.trade.positionPct}</span>
                    </div>
                  </div>
                )}
                {reasons && (
                  <div style={{ marginTop: 8 }}>
                    {reasons.slice(0, 3).map((r, j) => (
                      <div key={j} style={{ fontSize: 12, color: "#546e7a", marginBottom: 3 }}>
                        {isCrash ? "▼" : "▲"} {r}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => onDismiss(i)} style={{ background: "none", border: "none", color: "#37474f", cursor: "pointer", fontSize: 20, padding: "0 4px", marginLeft: 8 }}>✕</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 交易日誌 + 自動回測系統
// ══════════════════════════════════════════════════════════════════
const JOURNAL_KEY = "trading_journal_v1";
let _memJournal = [];

function loadJournal() {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) { _memJournal = parsed; return [...parsed]; }
    }
  } catch (_) {}
  try {
    const raw = sessionStorage.getItem(JOURNAL_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) { _memJournal = parsed; return [...parsed]; }
    }
  } catch (_) {}
  return [..._memJournal];
}

function saveJournal(trades) {
  if (!Array.isArray(trades)) return;
  _memJournal = [...trades];
  const json = JSON.stringify(trades);
  try { localStorage.setItem(JOURNAL_KEY, json); return; } catch (_) {}
  try { sessionStorage.setItem(JOURNAL_KEY, json); } catch (_) {}
}

async function checkTradeResult(trade) {
  try {
    const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${trade.symbol}&interval=15m&limit=200`);
    const klines = await res.json();
    if (!Array.isArray(klines)) return null;

    const entryTime = new Date(trade.entryTime).getTime();
    const candles = klines.map(k => ({ time: +k[0], high: +k[2], low: +k[3], close: +k[4] })).filter(c => c.time >= entryTime);

    if (candles.length === 0) return null;

    const entry = parseFloat(trade.entryPrice);
    const sl    = parseFloat(trade.stopLoss);
    const tp1   = parseFloat(trade.tp1);
    const tp2   = parseFloat(trade.tp2);
    const tp3   = parseFloat(trade.tp3);
    const dir   = trade.direction === "long" ? 1 : -1;

    let result = null, resultCandle = null, maxProfit = 0, maxLoss = 0;

    for (const c of candles) {
      const touchSL  = dir === 1 ? c.low  <= sl  : c.high >= sl;
      const touchTP1 = dir === 1 ? c.high >= tp1 : c.low  <= tp1;
      const touchTP2 = dir === 1 ? c.high >= tp2 : c.low  <= tp2;
      const touchTP3 = dir === 1 ? c.high >= tp3 : c.low  <= tp3;

      const pnl = dir === 1 ? (c.close - entry) / entry * 100 : (entry - c.close) / entry * 100;
      if (pnl > maxProfit) maxProfit = pnl;
      if (pnl < maxLoss)   maxLoss   = pnl;

      if (!result) {
        if (touchTP3) { result = "TP3"; resultCandle = c; }
        else if (touchTP2) { result = "TP2"; resultCandle = c; }
        else if (touchTP1) { result = "TP1"; resultCandle = c; }
        else if (touchSL)  { result = "SL";  resultCandle = c; }
      }
    }

    const lastClose = candles[candles.length - 1].close;
    const currentPnl = dir === 1 ? (lastClose - entry) / entry * 100 : (entry - lastClose) / entry * 100;

    return {
      result: result || "持倉中",
      resultTime: resultCandle ? new Date(resultCandle.time).toLocaleString("zh-TW") : null,
      currentPnl: currentPnl.toFixed(2),
      maxProfit:  maxProfit.toFixed(2),
      maxLoss:    maxLoss.toFixed(2),
      lastPrice:  lastClose.toFixed(4),
      candleCount: candles.length,
    };
  } catch (e) {
    return { result: "錯誤", error: e.message };
  }
}

function TradingJournal({ quickAdd, onQuickAddDone }) {
  const [trades, setTrades] = useState(loadJournal);
  const [showForm, setShowForm] = useState(false);
  const [checking, setChecking] = useState({});
  const [form, setForm] = useState({
    symbol: "BTCUSDT", direction: "long",
    entryPrice: "", stopLoss: "", tp1: "", tp2: "", tp3: "",
    entryTime: new Date().toISOString().slice(0, 16),
    note: "", score: "", smcVerdict: "", vptVerdict: ""
  });

  useEffect(() => {
    if (!quickAdd) return;
    setForm({
      symbol:       quickAdd.symbol      || "BTCUSDT",
      direction:    quickAdd.direction   || "long",
      entryPrice:   quickAdd.entryPrice  || "",
      stopLoss:     quickAdd.stopLoss    || "",
      tp1:          quickAdd.tp1         || "",
      tp2:          quickAdd.tp2         || "",
      tp3:          quickAdd.tp3         || "",
      entryTime:    new Date().toISOString().slice(0, 16),
      note:         quickAdd.note        || "",
      score:        quickAdd.score       || "",
      smcVerdict:   quickAdd.smcVerdict  || "",
      vptVerdict:   quickAdd.vptVerdict  || "",
    });
    setShowForm(true);
    if (onQuickAddDone) onQuickAddDone();
  }, [quickAdd, onQuickAddDone]);

  const closed  = trades.filter(t => ["TP1", "TP2", "TP3", "SL"].includes(t.result?.result));
  const wins    = closed.filter(t => t.result?.result?.startsWith("TP"));
  const losses  = closed.filter(t => t.result?.result === "SL");
  const winRate = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(0) : "-";
  const avgWin  = wins.length > 0 ? (wins.reduce((a, t) => {
    const r = t.result?.result;
    const pct = r === "TP3" ? parseFloat(t.tp3Pct) : r === "TP2" ? parseFloat(t.tp2Pct) : parseFloat(t.tp1Pct);
    return a + (isNaN(pct) ? 0 : pct);
  }, 0) / wins.length).toFixed(1) : "-";
  const avgLoss = losses.length > 0 ? Math.abs(parseFloat(losses.reduce((a, t) => a + parseFloat(t.slPct || 0), 0) / losses.length)).toFixed(1) : "-";

  const formRef = useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);

  const handleAddTrade = () => {
    const f = formRef.current;
    if (!f.symbol || !f.entryPrice || !f.stopLoss || !f.tp1) {
      alert("請確認填入：幣種、進場價格、止損、TP1");
      return;
    }
    const ep  = parseFloat(f.entryPrice);
    const sl  = parseFloat(f.stopLoss);
    const t1  = parseFloat(f.tp1);
    const t2  = f.tp2 ? parseFloat(f.tp2) : null;
    const t3  = f.tp3 ? parseFloat(f.tp3) : null;
    const dir = f.direction === "long" ? 1 : -1;

    if (isNaN(ep) || isNaN(sl) || isNaN(t1)) {
      alert("價格格式有誤，請輸入數字");
      return;
    }

    const slPct  = ((sl - ep) / ep * 100 * dir * -1).toFixed(2);
    const tp1Pct = ((t1 - ep) / ep * 100 * dir).toFixed(2);
    const tp2Pct = t2 ? ((t2 - ep) / ep * 100 * dir).toFixed(2) : "";
    const tp3Pct = t3 ? ((t3 - ep) / ep * 100 * dir).toFixed(2) : "";

    const newTrade = {
      ...f,
      id: Date.now(),
      slPct, tp1Pct, tp2Pct, tp3Pct,
      result: null,
      addedAt: new Date().toISOString()
    };

    const existing = loadJournal();
    const updated = [newTrade, ...existing];
    saveJournal(updated);
    setTrades(updated);
    setShowForm(false);
    setForm(f => ({ ...f, entryPrice: "", stopLoss: "", tp1: "", tp2: "", tp3: "", note: "", score: "" }));
  };

  const checkResult = async (trade) => {
    setChecking(c => ({ ...c, [trade.id]: true }));
    const result = await checkTradeResult(trade);
    const existing = loadJournal();
    const updated = existing.map(t => t.id === trade.id ? { ...t, result, checkedAt: new Date().toISOString() } : t);
    saveJournal(updated);
    setTrades(updated);
    setChecking(c => ({ ...c, [trade.id]: false }));
  };

  async function checkAll() {
    const pending = trades.filter(t => !["TP1", "TP2", "TP3", "SL"].includes(t.result?.result));
    for (const t of pending) await checkResult(t);
  }

  const deleteTrade = (id) => {
    const existing = loadJournal();
    const updated = existing.filter(t => t.id !== id);
    saveJournal(updated);
    setTrades(updated);
  };

  const resultColor = r => r === "TP3" ? "#2e7d32" : r === "TP2" ? "#4caf50" : r === "TP1" ? "#8bc34a" : r === "SL" ? "#ef5350" : r === "持倉中" ? "#ff9800" : "#37474f";
  const resultLabel = r => r === "TP3" ? "🎯🎯 TP3達標" : r === "TP2" ? "🎯 TP2達標" : r === "TP1" ? "✅ TP1達標" : r === "SL" ? "🛑 止損" : r === "持倉中" ? "⏳ 持倉中" : "—";
  const inp = (key, ph, type = "text") => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: "#37474f" }}>{ph}</span>
      <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        style={{ background: "#060810", border: "1px solid #1a2035", borderRadius: 5, color: "#90a4ae", fontSize: 12, padding: "6px 8px", fontFamily: "inherit", outline: "none" }} />
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: "auto", height: "100vh", background: "#07090f", padding: "16px 20px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: 3, color: "#7986cb", textTransform: "uppercase", marginBottom: 3 }}>TRADING JOURNAL</div>
          <div style={{ fontSize: 20, fontWeight: 800, background: "linear-gradient(90deg,#7986cb,#4caf50)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>交易日誌 · 自動回測</div>
          <div style={{ fontSize: 10, color: "#37474f", marginTop: 2 }}>記錄進場點位，系統自動回測是否觸發止盈止損</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={checkAll} style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #1a2035", background: "#0c111e", color: "#9fa8da", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>🔄 全部回測</button>
          <button onClick={() => setTrades(loadJournal())} style={{ padding: "8px 14px", borderRadius: 6, border: "1px solid #1a2035", background: "#0c111e", color: "#7986cb", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>🔄 同步</button>
          <button onClick={() => setShowForm(!showForm)} style={{ padding: "8px 18px", borderRadius: 6, border: "none", background: "linear-gradient(135deg,#283593,#00695c)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>+ 新增交易</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginBottom: 16 }}>
        {[
          { label: "總交易數", val: trades.length, col: "#7986cb" },
          { label: "已結算", val: closed.length, col: "#90a4ae" },
          { label: "勝率", val: `${winRate}%`, col: winRate >= 60 ? "#4caf50" : winRate >= 45 ? "#ff9800" : "#ef5350" },
          { label: "平均獲利", val: avgWin !== "-" ? `+${avgWin}%` : "-", col: "#4caf50" },
          { label: "平均虧損", val: avgLoss !== "-" ? `-${avgLoss}%` : "-", col: "#ef5350" },
        ].map(c => (
          <div key={c.label} style={{ background: "#0c111e", borderRadius: 8, padding: "12px 14px", border: "1px solid #1a2035" }}>
            <div style={{ fontSize: 10, color: "#37474f", marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.col }}>{c.val}</div>
          </div>
        ))}
      </div>

      {showForm && (
        <div style={{ background: "#0c111e", borderRadius: 10, padding: "16px 18px", border: "1px solid #1a2035", marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#7986cb", letterSpacing: 2, marginBottom: 12 }}>新增交易記錄</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 10 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10, color: "#37474f" }}>幣種</span>
              <input value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} placeholder="BTCUSDT" style={{ background: "#060810", border: "1px solid #1a2035", borderRadius: 5, color: "#90a4ae", fontSize: 12, padding: "6px 8px", fontFamily: "inherit", outline: "none" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10, color: "#37474f" }}>方向</span>
              <div style={{ display: "flex", gap: 6 }}>
                {["long", "short"].map(d => (
                  <button key={d} onClick={() => setForm(f => ({ ...f, direction: d }))} style={{ flex: 1, padding: "6px", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "inherit", border: `1px solid ${form.direction === d ? (d === "long" ? "#4caf50" : "#ef5350") : "#1a2035"}`, background: form.direction === d ? (d === "long" ? "#1b5e2022" : "#b71c1c22") : "transparent", color: form.direction === d ? (d === "long" ? "#4caf50" : "#ef5350") : "#37474f", fontWeight: 700 }}>
                    {d === "long" ? "▲ 做多" : "▼ 做空"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10, color: "#37474f" }}>進場時間</span>
              <input type="datetime-local" value={form.entryTime} onChange={e => setForm(f => ({ ...f, entryTime: e.target.value }))} style={{ background: "#060810", border: "1px solid #1a2035", borderRadius: 5, color: "#90a4ae", fontSize: 11, padding: "6px 8px", fontFamily: "inherit", outline: "none" }} />
            </div>
            {inp("note", "備注（訊號原因）")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginBottom: 12 }}>
            {inp("entryPrice", "進場價格", "number")}
            {inp("stopLoss", "止損 SL", "number")}
            {inp("tp1", "止盈 TP1", "number")}
            {inp("tp2", "止盈 TP2（選填）", "number")}
            {inp("tp3", "止盈 TP3（選填）", "number")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 12 }}>
            {inp("score", "系統評分（選填）")}
            {inp("smcVerdict", "SMC判斷（選填）")}
            {inp("vptVerdict", "量價判斷（選填）")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleAddTrade} style={{ padding: "9px 22px", borderRadius: 6, border: "none", background: "linear-gradient(135deg,#283593,#00695c)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: "inherit" }}>✅ 確認記錄</button>
            <button onClick={() => setShowForm(false)} style={{ padding: "9px 16px", borderRadius: 6, border: "1px solid #1a2035", background: "transparent", color: "#546e7a", cursor: "pointer", fontSize: 12, fontFamily: "inherit" }}>取消</button>
          </div>
        </div>
      )}

      {trades.length === 0 ? (
        <div style={{ textAlign: "center", color: "#37474f", marginTop: 60, fontSize: 13 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <div>還沒有交易記錄</div>
          <div style={{ fontSize: 11, marginTop: 6 }}>點「+ 新增交易」記錄你的第一筆進場</div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "90px 50px 80px 80px 70px 70px 70px 1fr 100px 100px 60px", gap: "0 8px", padding: "0 8px 6px", fontSize: 9, color: "#263238", letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #0f1629", marginBottom: 6 }}>
            <span>幣種/時間</span><span>方向</span><span>進場價</span><span>止損SL</span>
            <span>TP1</span><span>TP2</span><span>TP3</span><span>備注</span>
            <span>回測結果</span><span>損益%</span><span>操作</span>
          </div>

          {trades.map(t => {
            const res = t.result;
            const isWin  = res?.result?.startsWith("TP");
            const isSL   = res?.result === "SL";
            const isOpen = res?.result === "持倉中" || !res;
            return (
              <div key={t.id} style={{ display: "grid", gridTemplateColumns: "90px 50px 80px 80px 70px 70px 70px 1fr 100px 100px 60px", gap: "0 8px", padding: "9px 8px", alignItems: "center", marginBottom: 4, background: isWin ? "#0d2820" : isSL ? "#1a0505" : "#0c111e", borderRadius: 6, border: `1px solid ${isWin ? "#4caf5033" : isSL ? "#ef535033" : "#111827"}` }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eaf6" }}>{t.symbol.replace("USDT", "")}</div>
                  <div style={{ fontSize: 9, color: "#37474f" }}>{new Date(t.entryTime).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: t.direction === "long" ? "#4caf50" : "#ef5350" }}>{t.direction === "long" ? "▲多" : "▼空"}</span>
                <span style={{ fontSize: 11, color: "#90a4ae" }}>{t.entryPrice}</span>
                <div>
                  <div style={{ fontSize: 11, color: "#ef5350", fontWeight: 700 }}>{t.stopLoss}</div>
                  <div style={{ fontSize: 9, color: "#546e7a" }}>{t.slPct}%</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#8bc34a" }}>{t.tp1}</div>
                  <div style={{ fontSize: 9, color: "#546e7a" }}>{t.tp1Pct ? `+${t.tp1Pct}%` : ""}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#4caf50" }}>{t.tp2 || "—"}</div>
                  <div style={{ fontSize: 9, color: "#546e7a" }}>{t.tp2Pct ? `+${t.tp2Pct}%` : ""}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#2e7d32" }}>{t.tp3 || "—"}</div>
                  <div style={{ fontSize: 9, color: "#546e7a" }}>{t.tp3Pct ? `+${t.tp3Pct}%` : ""}</div>
                </div>
                <div style={{ fontSize: 10, color: "#546e7a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.note || "—"}
                  {t.score && <span style={{ marginLeft: 4, color: "#7986cb" }}>評{t.score}</span>}
                </div>
                <div>
                  {res ? (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 700, color: resultColor(res.result) }}>{resultLabel(res.result)}</div>
                      {res.resultTime && <div style={{ fontSize: 9, color: "#37474f" }}>{res.resultTime}</div>}
                      {isOpen && <div style={{ fontSize: 9, color: "#37474f" }}>現價 {res.lastPrice}</div>}
                    </>
                  ) : <div style={{ fontSize: 10, color: "#37474f" }}>未回測</div>}
                </div>
                <div>
                  {res && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 800, color: parseFloat(res.currentPnl) > 0 ? "#4caf50" : parseFloat(res.currentPnl) < 0 ? "#ef5350" : "#90a4ae" }}>
                        {parseFloat(res.currentPnl) > 0 ? "+" : ""}{res.currentPnl}%
                      </div>
                      <div style={{ fontSize: 9, color: "#37474f" }}>最高+{res.maxProfit}% / 最低{res.maxLoss}%</div>
                    </>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <button onClick={() => checkResult(t)} disabled={checking[t.id]} style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #1a2035", background: "#060c1a", color: "#7986cb", cursor: "pointer", fontSize: 10, fontFamily: "inherit" }}>
                    {checking[t.id] ? "..." : "回測"}
                  </button>
                  <button onClick={() => deleteTrade(t.id)} style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #1a2035", background: "transparent", color: "#546e7a", cursor: "pointer", fontSize: 10, fontFamily: "inherit" }}>刪除</button>
                </div>
              </div>
            );
          })}

          {closed.length >= 3 && (
            <div style={{ marginTop: 20, background: "#0c111e", borderRadius: 10, padding: "16px 18px", border: "1px solid #1a2035" }}>
              <div style={{ fontSize: 10, color: "#7986cb", letterSpacing: 2, marginBottom: 12 }}>📊 回測分析報告</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#37474f", marginBottom: 8 }}>勝率分佈</div>
                  <div style={{ height: 8, background: "#111827", borderRadius: 4, overflow: "hidden", display: "flex", marginBottom: 6 }}>
                    <div style={{ width: `${winRate}%`, background: "#4caf50", transition: "width .6s" }} />
                    <div style={{ flex: 1, background: "#ef5350" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span style={{ color: "#4caf50" }}>獲利 {wins.length} 筆 ({winRate}%)</span>
                    <span style={{ color: "#ef5350" }}>止損 {losses.length} 筆</span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#37474f", marginBottom: 8 }}>期望值估算</div>
                  {avgWin !== "-" && avgLoss !== "-" && (() => {
                    const wr = parseFloat(winRate) / 100;
                    const ev = (wr * parseFloat(avgWin) - (1 - wr) * parseFloat(avgLoss)).toFixed(2);
                    const positive = parseFloat(ev) > 0;
                    return (
                      <div>
                        <div style={{ fontSize: 22, fontWeight: 800, color: positive ? "#4caf50" : "#ef5350" }}>
                          {positive ? "+" : ""}{ev}%
                        </div>
                        <div style={{ fontSize: 10, color: "#37474f", marginTop: 3 }}>
                          {positive ? "正期望值，長期盈利" : "負期望值，需要改善"}
                        </div>
                      </div>
                    );
                  })()}
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#37474f", marginBottom: 8 }}>止盈分佈</div>
                  {["TP1", "TP2", "TP3"].map(tp => {
                    const cnt = wins.filter(t => t.result?.result === tp).length;
                    return cnt > 0 ? (
                      <div key={tp} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: "#4caf50" }}>{tp}</span>
                        <span style={{ fontSize: 11, color: "#90a4ae" }}>{cnt} 筆</span>
                      </div>
                    ) : null;
                  })}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// OI 儀表板
// ══════════════════════════════════════════════════════════════════
async function fetchOIData(symbols) {
  const results = await Promise.allSettled(
    symbols.map(async sym => {
      const [ticker, oi, fr, oiHist] = await Promise.allSettled([
        fetch(`${FAPI}/fapi/v1/ticker/24hr?symbol=${sym}`).then(r => r.json()),
        fetch(`${FAPI}/fapi/v1/openInterest?symbol=${sym}`).then(r => r.json()),
        fetch(`${FAPI}/fapi/v1/fundingRate?symbol=${sym}&limit=3`).then(r => r.json()),
        fetch(`${FAPI}/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=24`).then(r => r.json()),
      ]);
      const t  = ticker.status === "fulfilled" ? ticker.value : {};
      const o  = oi.status === "fulfilled" ? oi.value : {};
      const fr2 = fr.status === "fulfilled" && Array.isArray(fr.value) ? fr.value : [];
      const oh = oiHist.status === "fulfilled" && Array.isArray(oiHist.value) ? oiHist.value : [];

      const price    = parseFloat(t.lastPrice || 0);
      const oiNow    = parseFloat(o.openInterest || 0);
      const vol24h   = parseFloat(t.quoteVolume || 0);
      const change24 = parseFloat(t.priceChangePercent || 0);
      const frNow    = fr2[0] ? parseFloat(fr2[0].fundingRate) * 100 : null;

      const oiHr1 = oh.length >= 2 ? parseFloat(oh[oh.length - 2].sumOpenInterest) : oiNow;
      const oiHr4 = oh.length >= 5 ? parseFloat(oh[oh.length - 5].sumOpenInterest) : oiNow;
      const oiChg1h = oiHr1 ? ((oiNow - oiHr1) / oiHr1 * 100) : 0;
      const oiChg4h = oiHr4 ? ((oiNow - oiHr4) / oiHr4 * 100) : 0;

      let divergence = "neutral", divColor = "#90a4ae", divNote = "";
      if (change24 > 1 && oiChg4h > 5) {
        divergence = "bullAccum"; divColor = "#4caf50"; divNote = "價漲OI升，多頭積累（健康）";
      } else if (change24 > 1 && oiChg4h < -5) {
        divergence = "shortCover"; divColor = "#ff9800"; divNote = "價漲OI降，空頭回補（拉升可能減弱）";
      } else if (change24 < -1 && oiChg4h > 5) {
        divergence = "bearAccum"; divColor = "#ef5350"; divNote = "價跌OI升，新空單進場（繼續下跌風險）";
      } else if (change24 < -1 && oiChg4h < -5) {
        divergence = "longSqueezeEnd"; divColor = "#ffb74d"; divNote = "價跌OI降，多頭止損出場（可能近底）";
      } else if (Math.abs(change24) < 0.5 && Math.abs(oiChg4h) > 8) {
        divergence = "coil"; divColor = "#7986cb"; divNote = "價格橫盤但OI急變，方向即將決定🔥";
      }

      const frExtreme = frNow != null && Math.abs(frNow) > 0.08;
      const oiHigh    = oiNow * price > 5e8;
      const squeezeRisk = frExtreme && oiHigh;

      return { sym, price, oiNow, oiChg1h, oiChg4h, vol24h, change24,
        frNow, divergence, divColor, divNote, squeezeRisk, frExtreme,
        oiHist: oh.map(x => parseFloat(x.sumOpenInterest)) };
    })
  );
  return results.filter(r => r.status === "fulfilled").map(r => r.value);
}

function OISparkline({ data, color = "#7986cb" }) {
  if (!data || data.length < 2) return null;
  const w = 80, h = 24;
  const min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const pts = data.map((v, i) => `${i * (w / (data.length - 1))},${h - (v - min) / range * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function OIDashboard() {
  const [oiData, setOiData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState("oiChg1h");
  const [filterDiv, setFilterDiv] = useState("all");
  const [lastUpdate, setLastUpdate] = useState(null);

  const TOP_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "DOGEUSDT",
    "LINKUSDT", "DOTUSDT", "MATICUSDT", "LTCUSDT", "ATOMUSDT", "NEARUSDT", "APTUSDT",
    "ARBUSDT", "OPUSDT", "INJUSDT", "SUIUSDT", "TIAUSDT", "WIFUSDT", "JUPUSDT", "FETUSDT",
    "RNDRUSDT", "LDOUSDT", "MKRUSDT", "AAVEUSDT", "UNIUSDT", "SEIUSDT", "STRKUSDT"
  ];

  async function refresh() {
    setLoading(true);
    try {
      const data = await fetchOIData(TOP_SYMBOLS);
      setOiData(data);
      setLastUpdate(new Date().toLocaleTimeString("zh-TW"));
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  useEffect(() => { refresh(); }, []);

  const sorted = [...oiData]
    .filter(d => {
      if (filterDiv === "coil")      return d.divergence === "coil";
      if (filterDiv === "bearAccum") return d.divergence === "bearAccum";
      if (filterDiv === "bullAccum") return d.divergence === "bullAccum";
      if (filterDiv === "squeeze")   return d.squeezeRisk;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "oiChg1h") return Math.abs(b.oiChg1h) - Math.abs(a.oiChg1h);
      if (sortBy === "oiChg4h") return Math.abs(b.oiChg4h) - Math.abs(a.oiChg4h);
      if (sortBy === "fr")      return Math.abs(b.frNow || 0) - Math.abs(a.frNow || 0);
      if (sortBy === "vol")     return b.vol24h - a.vol24h;
      return 0;
    });

  const coilCount    = oiData.filter(d => d.divergence === "coil").length;
  const bearCount    = oiData.filter(d => d.divergence === "bearAccum").length;
  const bullCount    = oiData.filter(d => d.divergence === "bullAccum").length;
  const squeezeCount = oiData.filter(d => d.squeezeRisk).length;

  const fmtOI  = v => v > 1e9 ? `${(v / 1e9).toFixed(2)}B` : v > 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}K`;
  const fmtChg = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";

  return (
    <div style={{ flex: 1, overflowY: "auto", height: "100vh", background: "#07090f", padding: "14px 18px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div>
          <div style={{ fontSize: 9, letterSpacing: 3, color: "#ff9800", textTransform: "uppercase", marginBottom: 3 }}>OI DASHBOARD</div>
          <div style={{ fontSize: 18, fontWeight: 800, background: "linear-gradient(90deg,#ff9800,#ef5350)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>未平倉量儀表板</div>
          <div style={{ fontSize: 9, color: "#37474f", marginTop: 2 }}>預測「將發生」而非「已發生」· 背離偵測 · 費率矩陣</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {lastUpdate && <span style={{ fontSize: 10, color: "#263238" }}>更新 {lastUpdate}</span>}
          <button onClick={refresh} disabled={loading} style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: "linear-gradient(135deg,#e65100,#b71c1c)", color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit" }}>
            {loading ? "更新中…" : "🔄 立即更新"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
        {[
          { label: "🔥 蓄勢待爆發", val: coilCount, note: "OI急變+價格橫盤", col: "#7986cb", key: "coil" },
          { label: "🚀 多頭積累", val: bullCount, note: "價漲OI升，健康上漲", col: "#4caf50", key: "bullAccum" },
          { label: "💥 空頭積累", val: bearCount, note: "價跌OI升，繼續下跌", col: "#ef5350", key: "bearAccum" },
          { label: "⚡ 軋倉風險", val: squeezeCount, note: "費率極端+OI高", col: "#ff9800", key: "squeeze" },
        ].map(card => (
          <div key={card.key} onClick={() => setFilterDiv(filterDiv === card.key ? "all" : card.key)}
            style={{ background: filterDiv === card.key ? `${card.col}18` : "#0c111e", borderRadius: 8, padding: "12px 14px", cursor: "pointer", border: `1px solid ${filterDiv === card.key ? card.col : "#1a2035"}`, boxShadow: filterDiv === card.key ? `0 0 12px ${card.col}33` : "none" }}>
            <div style={{ fontSize: 11, color: card.col, marginBottom: 4 }}>{card.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: card.col }}>{card.val}</div>
            <div style={{ fontSize: 9, color: "#37474f", marginTop: 3 }}>{card.note}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "#37474f" }}>排序</span>
        {[["oiChg1h", "OI 1H變化"], ["oiChg4h", "OI 4H變化"], ["fr", "資金費率"], ["vol", "交易量"]].map(([k, l]) => (
          <button key={k} onClick={() => setSortBy(k)} style={{ padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: "inherit", cursor: "pointer", border: `1px solid ${sortBy === k ? "#ff9800" : "#1a2035"}`, background: sortBy === k ? "#ff980022" : "transparent", color: sortBy === k ? "#ff9800" : "#37474f" }}>
            {l}
          </button>
        ))}
        {filterDiv !== "all" && (
          <button onClick={() => setFilterDiv("all")} style={{ padding: "4px 10px", borderRadius: 4, fontSize: 10, fontFamily: "inherit", cursor: "pointer", border: "1px solid #37474f", background: "transparent", color: "#546e7a" }}>
            ✕ 清除篩選
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "100px 80px 70px 70px 70px 80px 90px 80px 1fr", gap: "0 8px", padding: "0 8px 6px", fontSize: 9, color: "#263238", letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid #0f1629", marginBottom: 6 }}>
        <span>幣種</span><span>現價</span><span>OI 1H%</span><span>OI 4H%</span>
        <span>24H%</span><span>資金費率</span><span>OI量</span><span>OI走勢</span><span>背離訊號</span>
      </div>

      {loading && oiData.length === 0 && (
        <div style={{ textAlign: "center", color: "#37474f", marginTop: 60, fontSize: 13 }}>
          <div style={{ width: 32, height: 32, border: "3px solid #1a2035", borderTopColor: "#ff9800", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px" }} />
          抓取OI數據中…
        </div>
      )}

      {sorted.map(d => {
        const oiColor = d.oiChg1h > 5 ? "#4caf50" : d.oiChg1h < -5 ? "#ef5350" : "#90a4ae";
        const o4Color = d.oiChg4h > 5 ? "#4caf50" : d.oiChg4h < -5 ? "#ef5350" : "#90a4ae";
        const frColor = d.frNow == null ? "#37474f" : d.frNow > 0.05 ? "#ef5350" : d.frNow > 0.01 ? "#ff9800" : d.frNow < -0.01 ? "#4caf50" : "#4dd0e1";
        const isCoil  = d.divergence === "coil";
        return (
          <div key={d.sym} style={{ display: "grid", gridTemplateColumns: "100px 80px 70px 70px 70px 80px 90px 80px 1fr", gap: "0 8px", padding: "8px 8px", alignItems: "center", marginBottom: 3, background: isCoil ? "#1a1535" : d.squeezeRisk ? "#1a0d00" : "#0c111e", borderRadius: 6, border: `1px solid ${isCoil ? "#7986cb33" : d.squeezeRisk ? "#ff980033" : "#111827"}`, boxShadow: isCoil ? "0 0 8px #7986cb22" : "none" }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#e8eaf6" }}>{d.sym.replace("USDT", "")}</div>
              {d.squeezeRisk && <div style={{ fontSize: 8, color: "#ff9800", marginTop: 1 }}>⚡軋倉風險</div>}
              {isCoil && <div style={{ fontSize: 8, color: "#7986cb", marginTop: 1 }}>🔥即將爆發</div>}
            </div>
            <span style={{ fontSize: 11, color: "#90a4ae", fontVariantNumeric: "tabular-nums" }}>{d.price >= 1000 ? d.price.toFixed(1) : d.price >= 1 ? d.price.toFixed(3) : d.price.toFixed(6)}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: oiColor }}>{fmtChg(d.oiChg1h)}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: o4Color }}>{fmtChg(d.oiChg4h)}</span>
            <span style={{ fontSize: 11, color: d.change24 > 0 ? "#4caf50" : d.change24 < 0 ? "#ef5350" : "#90a4ae", fontWeight: 700 }}>{fmtChg(d.change24)}</span>
            <span style={{ fontSize: 11, color: frColor, fontWeight: 700 }}>{d.frNow != null ? `${d.frNow.toFixed(4)}%` : "—"}</span>
            <span style={{ fontSize: 10, color: "#546e7a" }}>{fmtOI(d.oiNow * d.price)}</span>
            <OISparkline data={d.oiHist} color={d.oiChg4h > 0 ? "#4caf50" : "#ef5350"} />
            <div>
              <span style={{ fontSize: 10, color: d.divColor, fontWeight: d.divergence !== "neutral" ? 700 : 400 }}>{d.divNote || "—"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 主應用程式入口 (App Component)
// ══════════════════════════════════════════════════════════════════
export default function App() {
  const [symbols, setSymbols] = useState([]);
  const [interval, setIntervalVal] = useState("1h");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [selectedResult, setSelectedResult] = useState(null);
  const [activeTab, setActiveTab] = useState("scanner");
  const [alerts, setAlerts] = useState([]);
  const [quickAddTrade, setQuickAddTrade] = useState(null);

  useEffect(() => {
    getTopSymbols(30).then(setSymbols);
  }, []);

  const handleScan = async () => {
    if (!symbols.length) return;
    setLoading(true);
    setProgress(0);
    setResults([]);
    const list = [];
    const newAlerts = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const res = await analyseSymbol(sym, interval);
      if (res) {
        list.push(res);
        if (res.isEntry) newAlerts.push({ ...res, alertType: "entry" });
        else if (res.surge?.isSurge) newAlerts.push({ ...res, alertType: "surge" });
        else if (res.crash?.isCrash) newAlerts.push({ ...res, alertType: "crash" });
      }
      setProgress(Math.round(((i + 1) / symbols.length) * 100));
    }

    list.sort((a, b) => b.score - a.score);
    setResults(list);
    if (list.length) setSelectedResult(list[0]);
    if (newAlerts.length) setAlerts(newAlerts);
    setLoading(false);
  };

  const handleQuickAdd = (r) => {
    setQuickAddTrade({
      symbol: r.symbol,
      direction: "long",
      entryPrice: r.trade?.entryIdeal || r.price,
      stopLoss: r.trade?.stopLoss || "",
      tp1: r.trade?.tp1 || "",
      tp2: r.trade?.tp2 || "",
      tp3: r.trade?.tp3 || "",
      note: `${r.grade} | ${r.smc?.smcVerdict || ""} | ${r.vpt?.verdict || ""}`,
      score: r.score,
      smcVerdict: r.smc?.smcVerdict,
      vptVerdict: r.vpt?.verdict
    });
    setActiveTab("journal");
  };

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh", background: "#060913", color: "#e8eaf6", fontFamily: "sans-serif", overflow: "hidden" }}>
      {/* 導覽列 */}
      <div style={{ width: 60, background: "#0a0f1d", borderRight: "1px solid #1a2035", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 20, gap: 20 }}>
        <div style={{ fontSize: 20, cursor: "pointer" }} title="掃描器" onClick={() => setActiveTab("scanner")}>🔍</div>
        <div style={{ fontSize: 20, cursor: "pointer" }} title="OI 儀表板" onClick={() => setActiveTab("oi")}>📊</div>
        <div style={{ fontSize: 20, cursor: "pointer" }} title="交易日誌" onClick={() => setActiveTab("journal")}>📋</div>
      </div>

      {/* 主內容區 */}
      {activeTab === "scanner" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 20, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 20, alignItems: "center" }}>
            <button onClick={handleScan} disabled={loading} style={{ padding: "10px 20px", background: "#283593", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>
              {loading ? `掃描中 (${progress}%)` : "🚀 開始掃描"}
            </button>
            {INTERVALS.map(i => (
              <button key={i.value} onClick={() => setIntervalVal(i.value)} style={{ padding: "8px 12px", background: interval === i.value ? "#3949ab" : "#1a2035", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>
                {i.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 20, flex: 1 }}>
            {/* 幣種清單 */}
            <div style={{ width: 300, background: "#0a0f1d", border: "1px solid #1a2035", borderRadius: 8, padding: 10, overflowY: "auto", height: "calc(100vh - 100px)" }}>
              {results.map(r => (
                <div key={r.symbol} onClick={() => setSelectedResult(r)} style={{ padding: 10, borderBottom: "1px solid #1a2035", cursor: "pointer", background: selectedResult?.symbol === r.symbol ? "#1a2035" : "transparent", borderRadius: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 700 }}>{r.symbol}</span>
                    <span style={{ color: r.gradeColor }}>{r.grade} ({r.score}分)</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#90a4ae", marginTop: 4 }}>${r.price}</div>
                </div>
              ))}
            </div>

            {/* 詳細分析圖表與資訊 */}
            {selectedResult && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 15, overflowY: "auto" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0a0f1d", padding: 15, borderRadius: 8, border: "1px solid #1a2035" }}>
                  <div>
                    <h2 style={{ margin: 0 }}>{selectedResult.symbol} - {selectedResult.price}</h2>
                    <span style={{ color: selectedResult.gradeColor }}>{selectedResult.grade} (評分: {selectedResult.score})</span>
                  </div>
                  <button onClick={() => handleQuickAdd(selectedResult)} style={{ padding: "8px 15px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 700 }}>
                    + 快速帶入日誌
                  </button>
                </div>

                <KlineChart candles={selectedResult.candles} ma30arr={selectedResult.ma30arr} ma45arr={selectedResult.ma45arr} ma60arr={selectedResult.ma60arr} bb={selectedResult.bb} trade={selectedResult.trade} smc={selectedResult.smc} height={300} />

                {/* 交易建議面板 */}
                {selectedResult.trade && (
                  <div style={{ background: "#0a0f1d", padding: 15, borderRadius: 8, border: "1px solid #1a2035", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                    <div><span style={{ fontSize: 12, color: "#90a4ae" }}>策略:</span> <br/><b>{selectedResult.trade.strategy}</b></div>
                    <div><span style={{ fontSize: 12, color: "#90a4ae" }}>建議進場:</span> <br/><b style={{ color: "#e8eaf6" }}>{selectedResult.trade.entryIdeal}</b></div>
                    <div><span style={{ fontSize: 12, color: "#90a4ae" }}>止損 (SL):</span> <br/><b style={{ color: "#ef5350" }}>{selectedResult.trade.stopLoss} ({selectedResult.trade.slPct}%)</b></div>
                    <div><span style={{ fontSize: 12, color: "#90a4ae" }}>止盈 (TP1):</span> <br/><b style={{ color: "#4caf50" }}>{selectedResult.trade.tp1} (+{selectedResult.trade.tp1Pct}%)</b></div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "oi" && <OIDashboard />}
      {activeTab === "journal" && <TradingJournal quickAdd={quickAddTrade} onQuickAddDone={() => setQuickAddTrade(null)} />}

      <AlertSidebar alerts={alerts} onDismiss={(idx) => setAlerts(a => idx === "all" ? [] : a.filter((_, i) => i !== idx))} />
    </div>
  );
}
