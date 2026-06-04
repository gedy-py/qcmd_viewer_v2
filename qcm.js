// ═══════════════════════════════════════════════════════════════
//  QCM-D Viewer v2 — Client-side analysis tool
//  All code in one file for maximum hackability.
// ═══════════════════════════════════════════════════════════════

const getId = id => document.getElementById(id);

// ═══ STATE ════════════════════════════════════════════════════

const S = {
  raw: null, // { time:[], cols:{}, filename:'' }
  harmonics: { freq: [], diss: [] },
  markers: [],     // [{ id, time }]
  nextId: 0,
  stepNames: {},   // startMarkerId -> name
  customDeltas: [],// [{ id, fromId, toId }]
  nextDeltaId: 0,
  placementMode: false,
  programmaticRelayout: false,
  ts: { selFreq:[], selDiss:[], dataType:'both', tMin:null, tMax:null,
        smooth:false, smoothWin:21, smoothPoly:1, normalize:false },
  ddf: { harmonic:null, tMin:null, tMax:null, smooth:false, smoothWin:21, smoothPoly:1 }
};

const FREQ_COLORS = ['#93c5fd','#60a5fa','#3b82f6','#2563eb','#1d4ed8','#1e40af','#1e3a8a'];
const DISS_COLORS = ['#fca5a5','#f87171','#ef4444','#dc2626','#b91c1c','#991b1b','#7f1d1d'];
const STEP_COLORS = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd',
                     '#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'];
const PRIORITY = [7,5,3,9,11,13,1];

// ═══ UTILITIES ════════════════════════════════════════════════

function secondsToHHMM(s) {
  s = Math.round(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function secondsToHHMMSS(s) {
  s = Math.round(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function clockToSeconds(str) {
  if (!str || !str.trim()) return null;
  const p = str.trim().split(':').map(Number);
  if (p.some(isNaN)) return null;
  if (p.length === 2) return p[0]*3600 + p[1]*60;
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  return null;
}
function letterFor(i) {
  let s = '';
  do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i/26)-1; } while(i >= 0);
  return s;
}
function nearestIdx(arr, v) {
  let best = 0, d = Math.abs(arr[0]-v);
  for (let i=1; i<arr.length; i++) { const dd = Math.abs(arr[i]-v); if(dd<d){d=dd;best=i;} }
  return best;
}
function parseLimits(str) {
  if (!str) return null;
  const p = str.split(',').map(Number);
  return (p.length===2 && p.every(isFinite)) ? p : null;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }

// ═══ SAVITZKY-GOLAY ══════════════════════════════════════════

function savgolCoeffs(win, poly) {
  const half = Math.floor(win/2), ord = poly+1;
  // Build J^T J
  const A = Array.from({length:ord}, ()=>new Float64Array(ord));
  for (let i=0; i<win; i++) { const x=i-half; for(let j=0;j<ord;j++) for(let k=0;k<ord;k++) A[j][k]+=Math.pow(x,j+k); }
  // Solve A*c = e0 via Gauss-Jordan
  const aug = A.map((r,i)=>[...r, i===0?1:0]);
  for (let c=0; c<ord; c++) {
    let mx=c; for(let r=c+1;r<ord;r++) if(Math.abs(aug[r][c])>Math.abs(aug[mx][c])) mx=r;
    [aug[c],aug[mx]]=[aug[mx],aug[c]];
    const piv=aug[c][c]; for(let j=c;j<=ord;j++) aug[c][j]/=piv;
    for(let r=0;r<ord;r++) { if(r===c) continue; const f=aug[r][c]; for(let j=c;j<=ord;j++) aug[r][j]-=f*aug[c][j]; }
  }
  const x = aug.map(r=>r[ord]);
  const coeffs = new Float64Array(win);
  for (let i=0; i<win; i++) { const xi=i-half; let v=0; for(let k=0;k<ord;k++) v+=x[k]*Math.pow(xi,k); coeffs[i]=v; }
  return coeffs;
}

function savgol(data, win, poly) {
  if (data.length < win) return data.slice();
  win = Math.min(win, data.length%2===0 ? data.length-1 : data.length);
  if (win < poly+2) return data.slice();
  if (win%2===0) win--;
  if (win<3) return data.slice();
  const coeffs = savgolCoeffs(win, poly), half = Math.floor(win/2);
  const out = new Array(data.length);
  for (let i=0; i<data.length; i++) {
    if (i<half || i>=data.length-half) { out[i]=data[i]; continue; }
    let s=0; for(let j=0;j<win;j++) s+=coeffs[j]*data[i-half+j]; out[i]=s;
  }
  return out;
}

// ═══ DATA PARSING ════════════════════════════════════════════

function parseFile(file) {
  return new Promise((resolve, reject) => {
    const name = file.name.toLowerCase();
    const reader = new FileReader();
    if (name.endsWith('.csv')) {
      reader.onload = e => {
        try {
          let text = e.target.result;
          // Skip first row (metadata line in QCM-D exports)
          const firstNl = text.indexOf('\n');
          if (firstNl > 0) text = text.substring(firstNl+1);
          const parsed = Papa.parse(text.trim(), { delimiter:'\t', header:true, skipEmptyLines:true });
          if (!parsed.data.length) throw new Error('No data rows found');
          resolve(columnsFromRows(parsed.meta.fields, parsed.data, file.name));
        } catch(err) { reject(err); }
      };
      reader.readAsText(file, 'UTF-8');
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      reader.onload = e => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), {type:'array'});
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws);
          if (!rows.length) throw new Error('No data rows found');
          const fields = Object.keys(rows[0]);
          resolve(columnsFromRows(fields, rows, file.name));
        } catch(err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reject(new Error('Unsupported format. Expected CSV or XLSX.'));
    }
  });
}

function columnsFromRows(fields, rows, filename) {
  fields = fields.map(f => f.trim());
  // Detect time column
  const timeField = fields.find(f => /time|temps/i.test(f)) || fields[0];
  const time = rows.map(r => parseNumericValue(r[timeField])).filter(v => !isNaN(v));
  const cols = {};
  for (const f of fields) {
    if (f === timeField) continue;
    const vals = rows.map(r => parseNumericValue(r[f]));
    if (vals.some(v => !isNaN(v))) cols[f.trim()] = vals;
  }
  return { time, cols, filename };
}

function parseNumericValue(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(',','.'));
}

function detectHarmonics(cols) {
  const freq = [], diss = [];
  for (const key of Object.keys(cols)) {
    let m;
    if ((m = key.match(/^f(\d+)\s*\[Hz\]/i))) freq.push(parseInt(m[1]));
    else if ((m = key.match(/^D(\d+)\s*\[ppm\]/i))) diss.push(parseInt(m[1]));
  }
  return { freq: freq.sort((a,b)=>a-b), diss: diss.sort((a,b)=>a-b) };
}

function getMetadata(data) {
  const t = data.time, n = t.length;
  const dur = n>1 ? t[n-1]-t[0] : 0;
  const diffs = []; for(let i=1;i<Math.min(n,200);i++) diffs.push(t[i]-t[i-1]);
  diffs.sort((a,b)=>a-b);
  const dt = diffs.length ? diffs[Math.floor(diffs.length/2)] : 0;
  const h = detectHarmonics(data.cols);
  return {
    duration: secondsToHHMMSS(dur),
    points: n.toLocaleString(),
    sampling: dt > 0 ? `~${(1/dt).toFixed(2)} Hz` : 'N/A',
    freqH: h.freq.map(n=>`H${n}`).join(', ') || '—',
    dissH: h.diss.map(n=>`H${n}`).join(', ') || '—'
  };
}

// ═══ DATA PROCESSING ══════════════════════════════════════════

function processData(opts) {
  // opts: { tMin, tMax, smooth, smoothWin, smoothPoly, normalize, freqSel, dissSel }
  let time = S.raw.time.slice();
  const allCols = {};
  for (const k of Object.keys(S.raw.cols)) allCols[k] = S.raw.cols[k].slice();

  // Time filter
  let mask = time.map(()=>true);
  if (opts.tMin != null) mask = mask.map((v,i)=> v && time[i]>=opts.tMin);
  if (opts.tMax != null) mask = mask.map((v,i)=> v && time[i]<=opts.tMax);
  time = time.filter((_,i)=>mask[i]);
  const cols = {};
  for (const k of Object.keys(allCols)) cols[k] = allCols[k].filter((_,i)=>mask[i]);

  // Normalize Δf/n
  if (opts.normalize) {
    for (const n of (opts.freqSel||[])) {
      const k = `f${n} [Hz]`;
      if (cols[k]) cols[k] = cols[k].map(v => v/n);
    }
  }

  // Smoothing
  if (opts.smooth && time.length >= 5) {
    let w = opts.smoothWin;
    if (w > time.length) w = time.length%2===1 ? time.length : time.length-1;
    if (w >= opts.smoothPoly+2 && w >= 3) {
      for (const k of Object.keys(cols)) cols[k] = savgol(cols[k], w, opts.smoothPoly);
    }
  }
  return { time, cols };
}

// Process for TS view using current state
function tsProcessed() {
  return processData({
    tMin: S.ts.tMin, tMax: S.ts.tMax,
    smooth: S.ts.smooth, smoothWin: S.ts.smoothWin, smoothPoly: S.ts.smoothPoly,
    normalize: S.ts.normalize, freqSel: S.ts.selFreq, dissSel: S.ts.selDiss
  });
}

// Process for DDF view using current state
function ddfProcessed() {
  const n = S.ddf.harmonic;
  return processData({
    tMin: S.ddf.tMin, tMax: S.ddf.tMax,
    smooth: S.ddf.smooth, smoothWin: S.ddf.smoothWin, smoothPoly: S.ddf.smoothPoly,
    normalize: false, freqSel: n?[n]:[], dissSel: n?[n]:[]
  });
}

// ═══ MARKER MANAGEMENT ═══════════════════════════════════════

function addMarker(t) {
  S.markers.push({ id: S.nextId++, time: t });
}
function removeMarker(id) {
  S.markers = S.markers.filter(m => m.id !== id);
  delete S.stepNames[id];
}
function clearMarkers() {
  S.markers = []; S.stepNames = {}; S.customDeltas = [];
  refreshTS(); renderStepTable(); renderCustomDeltas();
}
function getOrderedMarkers() {
  return S.markers.slice().sort((a,b) => a.time - b.time);
}
function getSteps() {
  const ord = getOrderedMarkers();
  return ord.slice(0,-1).map((m,i) => ({
    name: S.stepNames[m.id] || `Step ${i+1}`,
    start: m.time, stop: ord[i+1].time,
    startId: m.id, stopId: ord[i+1].id, index: i
  }));
}

// ═══ CHART: QUICKLOOK ════════════════════════════════════════

function drawQuicklook() {
  const d = S.raw, h = S.harmonics;
  const prio = PRIORITY.find(n => h.freq.includes(n)) || h.freq[0];
  const prioD = PRIORITY.find(n => h.diss.includes(n)) || h.diss[0];
  const traces = [];
  // Freq traces
  h.freq.forEach((n,i) => {
    const key = `f${n} [Hz]`;
    if (!d.cols[key]) return;
    traces.push({ x:d.time, y:d.cols[key], name:`Δf${n}`, yaxis:'y',
      mode:'lines', line:{color:FREQ_COLORS[i%FREQ_COLORS.length], width: n===prio?2:1},
      opacity: n===prio ? 1 : 0.15 });
  });
  // Diss traces
  h.diss.forEach((n,i) => {
    const key = `D${n} [ppm]`;
    if (!d.cols[key]) return;
    traces.push({ x:d.time, y:d.cols[key], name:`ΔD${n}`, yaxis:'y2',
      mode:'lines', line:{color:DISS_COLORS[i%DISS_COLORS.length], width: n===prioD?2:1},
      opacity: n===prioD ? 1 : 0.15 });
  });
  const ticks = getTimeTicks(d.time[0], d.time[d.time.length-1]);
  Plotly.newPlot('quicklook-chart', traces, {
    xaxis: { tickvals:ticks.vals, ticktext:ticks.text, title:'Time' },
    yaxis: { title:'Δf [Hz]', titlefont:{color:'#2253A2'}, tickfont:{color:'#2253A2'}, side:'left' },
    yaxis2: { title:'ΔD [ppm]', titlefont:{color:'#A71B11'}, tickfont:{color:'#A71B11'},
              overlaying:'y', side:'right' },
    margin:{t:20,b:50,l:60,r:60}, showlegend:true,
    legend:{orientation:'h', y:-0.25, font:{size:10}}, hovermode:'closest'
  }, {responsive:true});
}

// ═══ CHART: TIME SERIES ══════════════════════════════════════

function drawTimeSeries() {
  const p = tsProcessed();
  const traces = [];
  const dt = S.ts.dataType;

  if (dt !== 'diss') {
    S.ts.selFreq.forEach((n,i) => {
      const k = `f${n} [Hz]`;
      if (!p.cols[k]) return;
      traces.push({ x:p.time, y:p.cols[k],
        name: S.ts.normalize ? `Δf/n ${n}` : `Δf${n}`,
        yaxis:'y', mode:'lines',
        line:{ color:FREQ_COLORS[i%FREQ_COLORS.length], width:1.5 },
        hovertemplate:'%{customdata}<br>%{y:.3f}<extra></extra>',
        customdata: p.time.map(secondsToHHMMSS)
      });
    });
  }
  if (dt !== 'freq') {
    S.ts.selDiss.forEach((n,i) => {
      const k = `D${n} [ppm]`;
      if (!p.cols[k]) return;
      traces.push({ x:p.time, y:p.cols[k], name:`ΔD${n}`,
        yaxis:'y2', mode:'lines',
        line:{ color:DISS_COLORS[i%DISS_COLORS.length], width:1.5 },
        opacity:0.8,
        hovertemplate:'%{customdata}<br>%{y:.5f}<extra></extra>',
        customdata: p.time.map(secondsToHHMMSS)
      });
    });
  }

  const tMin = p.time[0], tMax = p.time[p.time.length-1];
  const ticks = getTimeTicks(tMin||0, tMax||1);
  const shapes = getMarkerShapes();
  const annotations = getStepAnnotations();

  const layout = {
    xaxis: { tickvals:ticks.vals, ticktext:ticks.text, title:'Time (hh:mm)',
             rangeslider:{visible:true, thickness:0.08} },
    yaxis: { title: S.ts.normalize ? 'Δf/n [Hz]' : 'Frequency shift [Hz]',
             titlefont:{color:'#2253A2'}, tickfont:{color:'#2253A2'} },
    yaxis2: { title:'Dissipation shift [ppm]', titlefont:{color:'#A71B11'},
              tickfont:{color:'#A71B11'}, overlaying:'y', side:'right' },
    margin:{t:30,b:30,l:60,r:60}, showlegend:true,
    legend:{orientation:'h', y:-0.22, font:{size:11}},
    hovermode:'closest', shapes, annotations, height:440
  };

  Plotly.newPlot('ts-chart', traces, layout, {responsive:true}).then(() => {
    const el = getId('ts-chart');
    // Click handler for marker placement
    el.on('plotly_click', onTSClick);
    // Relayout handler for time sync
    el.on('plotly_relayout', onTSRelayout);
    // Hover for placement preview
    el.on('plotly_hover', onTSHover);
  });
}

function refreshTS() {
  drawTimeSeries();
  renderStepTable();
  renderCustomDeltas();
}

// ═══ CHART: ΔD vs Δf ═════════════════════════════════════════

function drawDDF() {
  const n = S.ddf.harmonic;
  if (!n) { Plotly.purge('ddf-chart'); return; }
  const p = ddfProcessed();
  const fk = `f${n} [Hz]`, dk = `D${n} [ppm]`;
  if (!p.cols[fk] || !p.cols[dk]) { Plotly.purge('ddf-chart'); return; }

  const steps = getSteps();
  const traces = [];

  if (steps.length === 0) {
    // Single trace, no steps
    traces.push({ x:p.cols[fk], y:p.cols[dk], mode:'lines',
      name:`n=${n}`, line:{color:'#2253A2', width:1.8} });
  } else {
    // Color by step
    steps.forEach((s,si) => {
      const mask = p.time.map(t => t >= s.start && t <= s.stop);
      const fx = p.cols[fk].filter((_,i)=>mask[i]);
      const fy = p.cols[dk].filter((_,i)=>mask[i]);
      if (!fx.length) return;
      const col = STEP_COLORS[si % STEP_COLORS.length];
      traces.push({ x:fx, y:fy, mode:'lines', name: s.name||`Step ${si+1}`,
        line:{color:col, width:1.8} });
    });
    // Transition points
    const bounds = [...new Set(steps.flatMap(s=>[s.start,s.stop]))].sort((a,b)=>a-b);
    bounds.forEach(t => {
      const fi = nearestIdx(p.time, t);
      traces.push({ x:[p.cols[fk][fi]], y:[p.cols[dk][fi]], mode:'markers',
        marker:{size:10, color:'black', symbol:'circle-open', line:{width:2}},
        showlegend:false, hovertemplate:`${secondsToHHMMSS(t)}<extra></extra>` });
    });
  }

  Plotly.newPlot('ddf-chart', traces, {
    xaxis:{title: S.ts.normalize ? 'Δf/n [Hz]':'Δf [Hz]'},
    yaxis:{title:'ΔD [ppm]'},
    margin:{t:30,b:50,l:60,r:30}, showlegend:true,
    legend:{font:{size:11}}, hovermode:'closest', height:480
  }, {responsive:true});
}

// ═══ TIME TICKS ══════════════════════════════════════════════

function getTimeTicks(tMin, tMax) {
  const span = Math.max(tMax - tMin, 1);
  let step;
  if (span <= 300) step = 60;
  else if (span <= 1200) step = 300;
  else if (span <= 3600) step = 600;
  else if (span <= 10800) step = 1800;
  else if (span <= 43200) step = 3600;
  else step = 7200;
  const start = Math.floor(tMin/step)*step;
  const vals=[], text=[];
  for (let t=start; t<=tMax+step; t+=step) { vals.push(t); text.push(secondsToHHMM(t)); }
  return {vals, text};
}

// ═══ SHAPES & ANNOTATIONS ════════════════════════════════════

function getMarkerShapes() {
  return getOrderedMarkers().map(m => ({
    type:'line', x0:m.time, x1:m.time, y0:0, y1:1, yref:'paper',
    line:{color:'rgba(100,100,100,0.6)', width:1.2, dash:'dot'}
  }));
}

function getStepAnnotations() {
  const steps = getSteps();
  const ord = getOrderedMarkers();
  const anns = [];
  // Step names centered between markers
  steps.forEach(s => {
    if (!s.name) return;
    anns.push({ x:(s.start+s.stop)/2, y:1.06, yref:'paper', xref:'x',
      text:s.name, showarrow:false, font:{size:11, color:'#333'},
      bgcolor:'rgba(255,255,255,0.8)', borderpad:2 });
  });
  // Marker letters at the top
  ord.forEach((m,i) => {
    anns.push({ x:m.time, y:1.12, yref:'paper', xref:'x',
      text:`<b>${letterFor(i)}</b>`, showarrow:false,
      font:{size:12, color:'#2253A2'} });
  });
  return anns;
}

// ═══ STEP TABLE ══════════════════════════════════════════════

function renderStepTable() {
  const area = getId('step-table-area');
  const steps = getSteps();
  const ord = getOrderedMarkers();
  if (ord.length < 2) { area.innerHTML = '<p style="color:#888;font-size:13px;">Add at least 2 markers to create steps.</p>'; return; }

  // Determine which harmonics to show
  const fSel = S.ts.selFreq, dSel = S.ts.selDiss;
  const p = tsProcessed(); // use processed data for delta computation

  // Build table HTML
  let html = '<div class="step-table-wrap"><table class="step-table"><thead><tr><th class="row-label"></th>';
  ord.forEach((m,i) => { html += `<th class="marker-hdr">${letterFor(i)}</th>`; if(i<steps.length) html += `<th></th>`; });
  html += '</tr></thead><tbody>';

  // Row builder helper
  const row = (label, vals) => {
    let r = `<tr><th class="row-label">${label}</th>`;
    ord.forEach((m,i) => {
      r += '<td class="marker-hdr"></td>';
      if (i < steps.length) r += `<td>${vals[i]}</td>`;
    });
    return r + '</tr>';
  };

  // Name row (editable)
  let nameRow = '<tr><th class="row-label">Name</th>';
  ord.forEach((m,i) => {
    nameRow += '<td class="marker-hdr"></td>';
    if (i < steps.length) {
      const nm = steps[i].name || '';
      nameRow += `<td><input class="step-name-input" value="${nm}" data-step="${i}" onchange="onStepRename(this)"></td>`;
    }
  });
  nameRow += '</tr>';
  html += nameRow;

  html += row('Start', steps.map(s => secondsToHHMMSS(s.start)));
  html += row('End', steps.map(s => secondsToHHMMSS(s.stop)));
  html += row('Duration', steps.map(s => secondsToHHMMSS(s.stop - s.start)));

  // Delta rows
  fSel.forEach(n => {
    const k = `f${n} [Hz]`;
    if (!p.cols[k]) return;
    const label = S.ts.normalize ? `Δf/n<sub>${n}</sub> [Hz]` : `Δf<sub>${n}</sub> [Hz]`;
    const vals = steps.map(s => {
      const v0 = p.cols[k][nearestIdx(p.time, s.start)];
      const v1 = p.cols[k][nearestIdx(p.time, s.stop)];
      return (v1-v0).toFixed(3);
    });
    html += row(label, vals);
  });
  dSel.forEach(n => {
    const k = `D${n} [ppm]`;
    if (!p.cols[k]) return;
    const vals = steps.map(s => {
      const v0 = p.cols[k][nearestIdx(p.time, s.start)];
      const v1 = p.cols[k][nearestIdx(p.time, s.stop)];
      return (v1-v0).toFixed(5);
    });
    html += row(`ΔD<sub>${n}</sub> [ppm]`, vals);
  });

  html += '</tbody></table></div>';
  area.innerHTML = html;
}

// ═══ CUSTOM DELTAS ═══════════════════════════════════════════

function renderCustomDeltas() {
  const area = getId('custom-delta-area');
  const ord = getOrderedMarkers();
  if (ord.length < 2) { area.innerHTML = ''; return; }

  let html = '<div class="custom-delta-section">';
  // Add button
  html += '<div style="margin-bottom:8px;">';
  html += '<button class="small" onclick="showAddCustomDelta()">+ Custom Δ</button>';
  html += '<span id="custom-delta-form" style="display:none; margin-left:10px;">';
  html += ' From <select id="cd-from">' + ord.map((m,i)=>`<option value="${m.id}">${letterFor(i)}</option>`).join('') + '</select>';
  html += ' → <select id="cd-to">' + ord.map((m,i)=>`<option value="${m.id}">${letterFor(i)}</option>`).join('') + '</select> ';
  html += '<button class="small primary" onclick="confirmCustomDelta()">Add</button>';
  html += '<button class="small" onclick="getId(\'custom-delta-form\').style.display=\'none\'">Cancel</button>';
  html += '</span></div>';

  // Existing custom deltas
  const p = tsProcessed();
  S.customDeltas.forEach(cd => {
    const mFrom = S.markers.find(m=>m.id===cd.fromId);
    const mTo = S.markers.find(m=>m.id===cd.toId);
    if (!mFrom || !mTo) return;
    const iFrom = ord.findIndex(m=>m.id===cd.fromId);
    const iTo = ord.findIndex(m=>m.id===cd.toId);
    const lFrom = iFrom>=0 ? letterFor(iFrom) : '?';
    const lTo = iTo>=0 ? letterFor(iTo) : '?';

    let deltas = '';
    S.ts.selFreq.forEach(n => {
      const k = `f${n} [Hz]`;
      if (!p.cols[k]) return;
      const v0 = p.cols[k][nearestIdx(p.time, mFrom.time)];
      const v1 = p.cols[k][nearestIdx(p.time, mTo.time)];
      const label = S.ts.normalize ? `Δf/n${n}` : `Δf${n}`;
      deltas += `<span class="delta-val"><b>${label}:</b> ${(v1-v0).toFixed(3)} Hz</span>`;
    });
    S.ts.selDiss.forEach(n => {
      const k = `D${n} [ppm]`;
      if (!p.cols[k]) return;
      const v0 = p.cols[k][nearestIdx(p.time, mFrom.time)];
      const v1 = p.cols[k][nearestIdx(p.time, mTo.time)];
      deltas += `<span class="delta-val"><b>ΔD${n}:</b> ${(v1-v0).toFixed(5)} ppm</span>`;
    });

    html += `<div class="custom-delta-item">
      <span class="range-label">←— ${lFrom} → ${lTo} —→</span>
      <div class="delta-values">${deltas}</div>
      <button class="small danger" onclick="removeCustomDelta(${cd.id})">×</button>
    </div>`;
  });

  html += '</div>';
  area.innerHTML = html;
}

function showAddCustomDelta() { getId('custom-delta-form').style.display = 'inline'; }

function confirmCustomDelta() {
  const fromId = parseInt(getId('cd-from').value);
  const toId = parseInt(getId('cd-to').value);
  if (fromId === toId) return;
  S.customDeltas.push({ id: S.nextDeltaId++, fromId, toId });
  renderCustomDeltas();
  getId('custom-delta-form').style.display = 'none';
}

function removeCustomDelta(id) {
  S.customDeltas = S.customDeltas.filter(d => d.id !== id);
  renderCustomDeltas();
}

// ═══ EDITOR ══════════════════════════════════════════════════

function applyTSEditor() {
  const u = {};
  const title = getId('ts-ed-title').value;
  if (title) u['title'] = title;
  const yl = getId('ts-ed-yl').value; if(yl) u['yaxis.title'] = yl;
  const yr = getId('ts-ed-yr').value; if(yr) u['yaxis2.title'] = yr;
  const ylim = parseLimits(getId('ts-ed-ylim').value);
  if(ylim) u['yaxis.range'] = ylim;
  const y2lim = parseLimits(getId('ts-ed-y2lim').value);
  if(y2lim) u['yaxis2.range'] = y2lim;
  const fs = parseInt(getId('ts-ed-fs').value);
  u['font'] = {size: fs};
  const leg = getId('ts-ed-leg').value;
  if (leg==='hidden') u['showlegend'] = false;
  else { u['showlegend'] = true; if(leg==='outside') u['legend'] = {x:1.02,y:1,orientation:'v'}; }
  // Update line widths
  const lw = parseFloat(getId('ts-ed-lw').value);
  const el = getId('ts-chart');
  if (el.data) el.data.forEach((_,i) => { u[`data[${i}].line.width`]=lw; });
  S.programmaticRelayout = true;
  Plotly.relayout('ts-chart', u).then(()=>{ S.programmaticRelayout=false; });
}

function applyDDFEditor() {
  const u = {};
  const title = getId('ddf-ed-title').value; if(title) u['title']=title;
  const xl = getId('ddf-ed-xl').value; if(xl) u['xaxis.title']=xl;
  const yl = getId('ddf-ed-yl').value; if(yl) u['yaxis.title']=yl;
  const xlim = parseLimits(getId('ddf-ed-xlim').value); if(xlim) u['xaxis.range']=xlim;
  const ylim = parseLimits(getId('ddf-ed-ylim').value); if(ylim) u['yaxis.range']=ylim;
  const fs = parseInt(getId('ddf-ed-fs').value); u['font']={size:fs};
  const leg = getId('ddf-ed-leg').value;
  if(leg==='hidden') u['showlegend']=false;
  else { u['showlegend']=true; if(leg==='outside') u['legend']={x:1.02,y:1,orientation:'v'}; }
  const lw = parseFloat(getId('ddf-ed-lw').value);
  const el = getId('ddf-chart');
  if(el.data) el.data.forEach((_,i)=>{u[`data[${i}].line.width`]=lw;});
  Plotly.relayout('ddf-chart', u);
}

function copyEditorSettings(from, to) {
  const map = { lw:['lw'], fs:['fs'], leg:['leg'] };
  for (const [k, fields] of Object.entries(map)) {
    for (const f of fields) {
      const src = getId(`${from}-ed-${f}`);
      const dst = getId(`${to}-ed-${f}`);
      if (src && dst) dst.value = src.value;
    }
  }
  if (to==='ts') applyTSEditor(); else applyDDFEditor();
}

// ═══ EXPORT ══════════════════════════════════════════════════

function exportChart(divId, format) {
  Plotly.downloadImage(divId, { format, filename:`qcmd_${divId}_${Date.now()}`, scale:2 });
}

function exportTableCSV() {
  const steps = getSteps();
  if (!steps.length) return;
  const p = tsProcessed();
  const ord = getOrderedMarkers();
  let csv = 'Step,' + steps.map((_,i)=>`Step ${i+1}`).join(',') + '\n';
  csv += 'Name,' + steps.map(s=>s.name).join(',') + '\n';
  csv += 'Start,' + steps.map(s=>secondsToHHMMSS(s.start)).join(',') + '\n';
  csv += 'End,' + steps.map(s=>secondsToHHMMSS(s.stop)).join(',') + '\n';
  csv += 'Duration,' + steps.map(s=>secondsToHHMMSS(s.stop-s.start)).join(',') + '\n';
  S.ts.selFreq.forEach(n => {
    const k = `f${n} [Hz]`; if(!p.cols[k]) return;
    const label = S.ts.normalize ? `df_n_${n} [Hz]` : `df${n} [Hz]`;
    csv += label + ',' + steps.map(s => {
      return (p.cols[k][nearestIdx(p.time,s.stop)] - p.cols[k][nearestIdx(p.time,s.start)]).toFixed(4);
    }).join(',') + '\n';
  });
  S.ts.selDiss.forEach(n => {
    const k = `D${n} [ppm]`; if(!p.cols[k]) return;
    csv += `dD${n} [ppm],` + steps.map(s => {
      return (p.cols[k][nearestIdx(p.time,s.stop)] - p.cols[k][nearestIdx(p.time,s.start)]).toFixed(6);
    }).join(',') + '\n';
  });
  // Custom deltas
  S.customDeltas.forEach(cd => {
    const mF = S.markers.find(m=>m.id===cd.fromId), mT = S.markers.find(m=>m.id===cd.toId);
    if(!mF||!mT) return;
    const iF = ord.findIndex(m=>m.id===cd.fromId), iT = ord.findIndex(m=>m.id===cd.toId);
    csv += `\nCustom ${letterFor(iF)}->${letterFor(iT)}\n`;
    S.ts.selFreq.forEach(n => {
      const k=`f${n} [Hz]`; if(!p.cols[k]) return;
      csv += `df${n},${(p.cols[k][nearestIdx(p.time,mT.time)]-p.cols[k][nearestIdx(p.time,mF.time)]).toFixed(4)}\n`;
    });
    S.ts.selDiss.forEach(n => {
      const k=`D${n} [ppm]`; if(!p.cols[k]) return;
      csv += `dD${n},${(p.cols[k][nearestIdx(p.time,mT.time)]-p.cols[k][nearestIdx(p.time,mF.time)]).toFixed(6)}\n`;
    });
  });
  downloadText(csv, 'qcmd_steps.csv', 'text/csv');
}

function exportTablePNG() {
  const el = getId('step-table-area');
  if (!el.querySelector('table')) return;
  html2canvas(el).then(canvas => {
    canvas.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'qcmd_steps.png';
      a.click();
    });
  });
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], {type: mime});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ═══ UI EVENT HANDLERS ═══════════════════════════════════════

function onFileSelected(file) {
  parseFile(file).then(data => {
    S.raw = data;
    S.harmonics = detectHarmonics(data.cols);
    // Show validation panel
    const meta = getMetadata(data);
    getId('meta-grid').innerHTML = Object.entries(meta).map(([k,v]) =>
      `<div class="meta-item"><div class="label">${k}</div><div class="value">${v}</div></div>`
    ).join('');
    getId('validation-panel').style.display = 'block';
    getId('upload-zone').style.display = 'none';
    drawQuicklook();
  }).catch(err => {
    alert('Error loading file: ' + err.message);
  });
}

function resetUpload() {
  getId('validation-panel').style.display = 'none';
  getId('upload-zone').style.display = 'block';
  getId('file-input').value = '';
  S.raw = null;
}

function validateAndOpen() {
  if (!S.raw) return;
  getId('screen-upload').style.display = 'none';
  getId('screen-analysis').style.display = 'flex';
  getId('analysis-filename').textContent = S.raw.filename;
  populateControls();
  refreshTS();
}

function backToUpload() {
  getId('screen-analysis').style.display = 'none';
  getId('screen-upload').style.display = 'block';
  S.markers = []; S.stepNames = {}; S.customDeltas = [];
  resetUpload();
}

function switchTab(tab) {
  document.querySelectorAll('.tab-bar .tab').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.toggle('active', t.id===`tab-${tab}`));
  if (tab === 'ddf') drawDDF();
}

function populateControls() {
  const h = S.harmonics;
  // Time Series freq harmonics
  const prio = PRIORITY.find(n => h.freq.includes(n));
  getId('ts-freq-checks').innerHTML = h.freq.map(n =>
    `<label><input type="checkbox" value="${n}" ${n===prio?'checked':''} onchange="onTSHarmonicChange()">f${n}</label>`
  ).join('');
  const prioD = PRIORITY.find(n => h.diss.includes(n));
  getId('ts-diss-checks').innerHTML = h.diss.map(n =>
    `<label><input type="checkbox" value="${n}" ${n===prioD?'checked':''} onchange="onTSHarmonicChange()">D${n}</label>`
  ).join('');
  onTSHarmonicChange();

  // DDF harmonic selector
  const common = h.freq.filter(n => h.diss.includes(n));
  getId('ddf-harmonic').innerHTML = common.map(n => `<option value="${n}" ${n===prio?'selected':''}>n = ${n}</option>`).join('');
  S.ddf.harmonic = common.includes(prio) ? prio : common[0] || null;
}

function onTSHarmonicChange() {
  S.ts.selFreq = [...getId('ts-freq-checks').querySelectorAll('input:checked')].map(i=>parseInt(i.value));
  S.ts.selDiss = [...getId('ts-diss-checks').querySelectorAll('input:checked')].map(i=>parseInt(i.value));
  refreshTS();
}

function onTSChange() {
  S.ts.dataType = getId('ts-data-type').value;
  S.ts.smooth = getId('ts-smooth-chk').checked;
  S.ts.smoothWin = parseInt(getId('ts-smooth-win').value);
  S.ts.smoothPoly = parseInt(getId('ts-smooth-poly').value);
  S.ts.normalize = getId('ts-normalize').checked;
  refreshTS();
}

function onTSTimeInput() {
  const mn = clockToSeconds(getId('ts-tmin').value);
  const mx = clockToSeconds(getId('ts-tmax').value);
  S.ts.tMin = mn; S.ts.tMax = mx;
  refreshTS();
}

function onTSRelayout(ed) {
  if (S.programmaticRelayout) return;
  if (ed['xaxis.range[0]'] != null) {
    S.ts.tMin = ed['xaxis.range[0]']; S.ts.tMax = ed['xaxis.range[1]'];
    getId('ts-tmin').value = secondsToHHMM(S.ts.tMin);
    getId('ts-tmax').value = secondsToHHMM(S.ts.tMax);
    // Update step table with new visible range
    renderStepTable(); renderCustomDeltas();
  }
  if (ed['xaxis.autorange']) {
    S.ts.tMin = null; S.ts.tMax = null;
    getId('ts-tmin').value = ''; getId('ts-tmax').value = '';
    renderStepTable(); renderCustomDeltas();
  }
}

function onDDFChange() {
  S.ddf.harmonic = parseInt(getId('ddf-harmonic').value) || null;
  S.ddf.tMin = clockToSeconds(getId('ddf-tmin').value);
  S.ddf.tMax = clockToSeconds(getId('ddf-tmax').value);
  S.ddf.smooth = getId('ddf-smooth-chk').checked;
  S.ddf.smoothWin = parseInt(getId('ddf-smooth-win').value);
  S.ddf.smoothPoly = parseInt(getId('ddf-smooth-poly').value);
  drawDDF();
}

function onStepRename(input) {
  const idx = parseInt(input.dataset.step);
  const steps = getSteps();
  if (steps[idx]) S.stepNames[steps[idx].startId] = input.value;
  // Update annotations on chart
  S.programmaticRelayout = true;
  Plotly.relayout('ts-chart', { annotations: getStepAnnotations() }).then(()=>{S.programmaticRelayout=false;});
}

// ═══ MARKER PLACEMENT MODE ═══════════════════════════════════

function enterPlacement() {
  S.placementMode = true;
  getId('btn-add-marker').disabled = true;
  getId('placement-hint').style.display = 'inline';
  getId('ts-main').classList.add('placement-active');
  const el = getId('ts-chart');
  if (el.querySelector('.nsewdrag')) el.querySelector('.nsewdrag').style.cursor = 'crosshair';
}

function exitPlacement() {
  S.placementMode = false;
  getId('btn-add-marker').disabled = false;
  getId('placement-hint').style.display = 'none';
  getId('ts-main').classList.remove('placement-active');
  const el = getId('ts-chart');
  if (el.querySelector('.nsewdrag')) el.querySelector('.nsewdrag').style.cursor = '';
  // Remove preview shape
  S.programmaticRelayout = true;
  Plotly.relayout('ts-chart', { shapes: getMarkerShapes(), annotations: getStepAnnotations() })
    .then(()=>{S.programmaticRelayout=false;});
}

function onTSClick(data) {
  if (!S.placementMode) return;
  if (!data.points || !data.points.length) return;
  const x = data.points[0].x;
  addMarker(x);
  exitPlacement();
  refreshTS();
}

const debouncedPreview = debounce(function(x) {
  const shapes = [...getMarkerShapes(), {
    type:'line', x0:x, x1:x, y0:0, y1:1, yref:'paper',
    line:{color:'rgba(0,0,0,0.5)', width:1.5, dash:'dash'}
  }];
  const anns = [...getStepAnnotations(), {
    x, y:1.12, yref:'paper', xref:'x',
    text:`<b>${secondsToHHMMSS(x)}</b>`, showarrow:false,
    font:{size:11}, bgcolor:'rgba(255,255,200,0.9)', borderpad:3
  }];
  S.programmaticRelayout = true;
  Plotly.relayout('ts-chart', { shapes, annotations: anns }).then(()=>{S.programmaticRelayout=false;});
}, 30);

function onTSHover(data) {
  if (!S.placementMode) return;
  if (!data.points || !data.points.length) return;
  debouncedPreview(data.points[0].x);
}

// ═══ INITIALIZATION ══════════════════════════════════════════

function init() {
  // File upload
  const zone = getId('upload-zone');
  const input = getId('file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) onFileSelected(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if(input.files.length) onFileSelected(input.files[0]); });

  // Escape key to exit placement mode
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && S.placementMode) exitPlacement();
  });
}

document.addEventListener('DOMContentLoaded', init);
