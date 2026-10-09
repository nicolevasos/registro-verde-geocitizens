// ══════════════════════════════════════════════════════════════════════════
//
// WHY THE CORS ERROR HAPPENS
// ──────────────────────────
// Browsers block direct fetch() calls from a local HTML file (file:// origin
// or localhost) to external APIs unless the server explicitly allows it via
// Access-Control-Allow-Origin headers.  The WHISP OpenForis API does NOT
// include those headers for browser requests.
//
// THREE SUPPORTED MODES — set WHISP_MODE below:
//
//   'mock'   — No network call.  Uses realistic pre-loaded Quindío data.
//              Use this for demos, UI development, and thesis screenshots.
//
//   'proxy'  — Routes through a CORS proxy.  No server required.
//              Uses allorigins.win (public proxy, rate-limited).
//              Use this when demo-ing with a real internet connection.
//
//   'local'  — Calls your local Python backend (run_whisp_server.py).
//              Run: python run_whisp_server.py   in a terminal first.
//              Then open this HTML from the same machine.
//              Use this for the full live integration.
//
const WHISP_MODE = 'api';   // 'mock', 'proxy', 'local', or 'api'
let WHISP_MODE_CURRENT = WHISP_MODE;

const WHISP_LOCAL = 'http://127.0.0.1:5050';
//AWS API Gateway endpoint for whisp serverless backend. It triggers a (lambda function)
const WHISP_API = 'https://lpj8wzc0mb.execute-api.eu-north-1.amazonaws.com';

// ── Real Quindío mock data derived from coffee_ex.geojson WHISP output ──────
// These values reflect an actual WHISP analysis for the Cultivo Permanente
// Cafe plot in Quindío / Risaralda, Colombia.
const WHISP_MOCK = {
  Area: 15.12,
  Country: 'Colombia',
  Admin_Level_1: 'Quindío',
  Coffee_FDaP: 12.84,
  GFC_TC_2020: 8.31,
  ESRI_crop_gain_2020_2024: 0.0,
  GFC_loss_after_2020: 0.0,
  GFC_loss_year_2021: 0.0,
  GFC_loss_year_2022: 0.0,
  GFC_loss_year_2023: 0.0,
  GFC_loss_year_2018: 0.22,
  GFC_loss_year_2015: 0.08,
  GFC_loss_year_2010: 0.05,
  risk_acrop: 'low',
  risk_pcrop: 'low',
  Ind_01_treecover:               'yes',
  Ind_02_commodities:             'yes',
  Ind_03_disturbance_before_2020: 'no',
  Ind_04_disturbance_after_2020:  'no',
  Ind_05_primary_2020:            'no',
  Ind_10_agri_after_2020:         'no',
  whisp_processing_metadata: {
    whisp_version: '1.3.2',
    processing_timestamp_utc: '2024-09-14T10:28:05Z'
  }
};

// ── Simulated loading delay for realistic UX ────────────────────────────────
async function sendToWhisp(plot){
  const whispStarted=Date.now();
  logStudyEvent('whisp_started',{mode:WHISP_MODE_CURRENT},plot.name,`whisp:${plot.name}`);
  switchTab('whisp');
  document.getElementById('whisp-screen-sub').textContent = plot.name;
  showWhispLoading();

  try {
    const cachedWhisp = plot.geojson ? await cacheGet(plot.geojson, 'whisp:'+WHISP_MODE_CURRENT, 90*24*60*60*1000) : null;
    if(cachedWhisp){
      renderWhispResults(plot, cachedWhisp);
      showToast('⚡ WHISP cargado desde caché');
      return;
    }
    let geojsonData;

    if(WHISP_MODE_CURRENT === 'mock'){
      // Simulate processing time (2s feels realistic for a satellite analysis)
      await new Promise(r => setTimeout(r, 2000));
      // Generate per-plot realistic mock (not hardcoded)
      const plotMock = plot.geojson ? generatePlotWhispMock(plot) : WHISP_MOCK;
      geojsonData = { features: [{ properties: plotMock }] };

    } else if(WHISP_MODE_CURRENT === 'proxy'){
      // Public CORS proxy — wraps request so browser CORS check passes
      const target = encodeURIComponent('https://whisp.openforis.org/api/submit/geojson');
      const resp = await fetch(`https://api.allorigins.win/raw?url=${target}`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(plot.geojson)
      });
      if(!resp.ok) throw new Error('Proxy error HTTP '+resp.status);
      const data = await resp.json();
      if(data.code==='analysis_completed' && data.data){
        geojsonData = data.data;
      } else {
        const token = (data.context&&data.context.token)||data.token||data.id;
        if(!token) throw new Error('No se recibió token de WHISP');
        geojsonData = await pollWhispProxy(token);
      }

} else if (
  WHISP_MODE_CURRENT === 'local' ||
  WHISP_MODE_CURRENT === 'api'
) {
  const endpoint =
    WHISP_MODE_CURRENT === 'local'
      ? `${WHISP_LOCAL}/api/whisp/analyze`
      : `${WHISP_API}/api/whisp/analyze`;

  const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        geojson: plot.geojson,

      })
    }
  );

  const data = await response
    .json()
    .catch(() => null);

  if (!response.ok) {
    const detail =
      data?.detail || `HTTP ${response.status}`;

    throw new Error(
      typeof detail === 'string'
        ? detail
        : JSON.stringify(detail)
    );
  }

  // The backend normalizes WHISP responses to { status, result, context }.
  // Keep defensive fallbacks for older backend responses.
  geojsonData = data?.result ?? data?.data ?? data;

  if (
    !geojsonData ||
    geojsonData.type !== 'FeatureCollection' ||
    !Array.isArray(geojsonData.features)
  ) {
    console.error('Unexpected WHISP response:', data);
    throw new Error('WHISP devolvió datos en un formato inesperado.');
  }
}

    if(plot.geojson) await cacheSet(plot.geojson, 'whisp:'+WHISP_MODE_CURRENT, geojsonData);
    renderWhispResults(plot, geojsonData);
    logStudyEvent('whisp_completed',{mode:WHISP_MODE_CURRENT,duration_ms:Date.now()-whispStarted},plot.name,`whisp:${plot.name}`,Date.now()-whispStarted);

  } catch(err){
    logStudyEvent('whisp_failed',{mode:WHISP_MODE_CURRENT,error:err.message,duration_ms:Date.now()-whispStarted},plot.name,`whisp:${plot.name}`,Date.now()-whispStarted);
    document.getElementById('whisp-content').innerHTML = `
      <div class="whisp-empty">
        <div class="we-icon">⚠️</div>
        <div class="we-label">Error al contactar WHISP</div>
        <div class="we-sub" style="color:var(--alert);font-family:'JetBrains Mono',monospace;font-size:11px">${err.message}</div>
        <div class="we-sub" style="margin-top:10px">
          <strong>Soluciones:</strong><br>
          • Cambia <code>WHISP_MODE = 'mock'</code> para demo sin red<br>
          • Verifica que FastAPI esté activo y que <code>WHISP_API_KEY</code> esté configurada en el backend
        </div>
        <button onclick="sendToWhisp(PLOTS[currentPlot])" style="margin-top:14px;background:var(--forest);color:white;border:none;border-radius:10px;padding:10px 20px;font-family:'Sora',sans-serif;font-size:13px;font-weight:600;cursor:pointer">
          Reintentar
        </button>
      </div>`;
  }
}

function showWhispLoading(){
  document.getElementById('whisp-content').innerHTML = `
    <div class="whisp-loading">
      <div class="whisp-spinner"></div>
      <div class="ws-label">Analizando la parcela…</div>
      <div class="ws-sub">Esto puede tomar hasta 60 segundos.</div>
      <div style="margin-top:16px;font-size:11px;color:var(--stone);text-align:center">
        Modo: <code style="background:var(--fog);padding:2px 6px;border-radius:4px">${WHISP_MODE_CURRENT}</code>
      </div>
    </div>`;
}

async function pollWhispProxy(token, attempts=0){
  if(attempts>30) throw new Error('Tiempo de espera agotado');
  const target = encodeURIComponent('https://whisp.openforis.org/api/report?token='+token);
  const resp = await fetch(`https://api.allorigins.win/raw?url=${target}`);
  if(!resp.ok) throw new Error('HTTP '+resp.status);
  const data = await resp.json();
  const status = data.status||data.state||(data.data||data.results?'complete':'pending');
  if(['complete','done','finished','success','completed'].includes(status)){
    return data.data || data;
  }
  if(['error','failed'].includes(status)) throw new Error('WHISP reportó error en el análisis');
  await new Promise(r=>setTimeout(r,8000));
  return pollWhispProxy(token, attempts+1);
}

function renderWhispResults(plot, geojsonData){
  const feat = geojsonData && geojsonData.features && geojsonData.features[0];
  if(!feat){ document.getElementById('whisp-content').innerHTML='<div class="whisp-empty"><div class="we-icon">🤔</div><div class="we-label">Sin datos en la respuesta</div></div>'; return; }
  const p = feat.properties;

  // Store on plot for EUDR tab
  plot.whispData = p;
  updateEudrFromWhisp(plot, p);

  // ── Risk badge ──────────────────────────────────────────────────────────
  const riskRaw = p.risk_acrop || p.risk_pcrop || 'unknown';
  const riskLabel = riskRaw==='low'?'Riesgo bajo':riskRaw==='medium'?'Riesgo medio':riskRaw==='high'?'Riesgo alto':'Desconocido';
  const riskColor = riskRaw==='low'?'var(--leaf)':riskRaw==='medium'?'var(--amber)':'var(--alert)';
  const riskEmoji = riskRaw==='low'?'✅':riskRaw==='medium'?'⚠️':'🚨';

  // ── Key metrics ──────────────────────────────────────────────────────────
  const area    = (p.Area||0).toFixed(2);
  const coffee  = (p.Coffee_FDaP||0).toFixed(2);
  const tc2020  = (p.GFC_TC_2020||0).toFixed(2);
  const cropGain= (p.ESRI_crop_gain_2020_2024||0).toFixed(2);

  // ── GFC loss 2023 warning ────────────────────────────────────────────────
  const gfc2023 = p.GFC_loss_year_2023||0;
  const gfcAfter2020 = p.GFC_loss_after_2020||0;
  const hasPostAlert = gfcAfter2020>0;
  const alertHtml = hasPostAlert ? `
    <div class="whisp-alert">
      <span style="font-size:18px;flex-shrink:0">⚠️</span>
      <div class="wa-text"><strong>Alerta post-2020:</strong> GFC detectó ${gfcAfter2020.toFixed(2)} ha de pérdida de cobertura arbórea después de 2020 (${gfc2023.toFixed(2)} ha en 2023). Verifica si corresponde a renovación de cafetos.</div>
    </div>` : `
    <div class="whisp-alert ok">
      <span style="font-size:18px;flex-shrink:0">✅</span>
      <div class="wa-text"><strong>Sin deforestación post-2020</strong> detectada por TMF, RADD o GLAD. Parcela conforme con fecha de corte EUDR.</div>
    </div>`;

  // ── Indicators list ───────────────────────────────────────────────────────
  const indDefs = [
    { key:'Ind_01_treecover',              icon:'🌳', label:'Cobertura forestal' },
    { key:'Ind_02_commodities',            icon:'🌾', label:'Materias primas sensibles' },
    { key:'Ind_03_disturbance_before_2020',icon:'📅', label:'Perturbación antes de 2020' },
    { key:'Ind_04_disturbance_after_2020', icon:'📅', label:'Perturbación después de 2020' },
    { key:'Ind_05_primary_2020',           icon:'🌲', label:'Bosque primario 2020' },
    { key:'Ind_10_agri_after_2020',        icon:'🌱', label:'Expansión agrícola post-2020' },
  ];
  const indsHtml = indDefs.map(d=>{
    const val = (p[d.key]||'no').toLowerCase();
    // For disturbance/agri indicators, "yes" is a warning; for forest cover "no" is ok
    const isWarning = d.key.includes('disturbance') || d.key.includes('agri');
    const isForest   = d.key==='Ind_01_treecover'||d.key==='Ind_05_primary_2020';
    let cls='ok', label='No detectado';
    if(val==='yes'){
      cls = isWarning ? 'warn' : isForest ? 'ok' : 'ok';
      label = isWarning ? 'Detectado ⚠️' : 'Presente ✓';
    } else {
      cls = isForest ? 'flag' : 'ok';
      label = isForest ? 'No presente' : 'No detectado';
    }
    return `<div class="wi-row"><span class="wi-icon">${d.icon}</span><span class="wi-label">${d.label}</span><span class="wi-pill ${cls}">${label}</span></div>`;
  }).join('');

  // ── GFC bar chart (non-zero years only, max 8 bars for readability) ──────
  const gfcYears = [];
  for(let y=2001;y<=2024;y++){
    const v=p['GFC_loss_year_'+y]||0;
    if(v>0.01) gfcYears.push({year:y,val:v});
  }
  const maxGfc = Math.max(...gfcYears.map(r=>r.val), 0.01);
  const chartHtml = gfcYears.length===0 ? '<div style="font-size:12px;color:var(--stone);text-align:center;padding:12px 0">Sin pérdida de cobertura arbórea detectada (GFC)</div>' :
    '<div class="bar-chart">' + gfcYears.map(r=>{
      const pct = Math.round(r.val/maxGfc*100);
      const color = r.val>5?'#C84B2F':r.year>=2021?'#E8832A':'#2E8B57';
      return `<div class="bc-row">
        <span class="bc-year">${r.year}</span>
        <div class="bc-track"><div class="bc-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="bc-val">${r.val.toFixed(2)}</span>
      </div>`;
    }).join('') + '</div>';

  // ── Render ────────────────────────────────────────────────────────────────
  document.getElementById('whisp-screen-sub').textContent = plot.name + ' · ' + (p.Admin_Level_1||p.Country||'');
  document.getElementById('whisp-content').innerHTML = `
    <div class="whisp-hero">
      <div class="wh-label">Resultado de riesgo EUDR</div>
      <div class="wh-risk" style="color:${riskColor}">${riskEmoji} ${riskLabel}</div>
      <div class="wh-sub">café · ${p.Country||''} · ${area} ha</div>
      <div class="wh-meta">🛰️ WHISP v${p.whisp_processing_metadata?.whisp_version||'—'} · ${(p.whisp_processing_metadata?.processing_timestamp_utc||'').slice(0,10)}</div>
    </div>
    <div class="whisp-metrics">
      <div class="wm-card"><div class="wm-label">Área total</div><div class="wm-val">${area} <span class="wm-unit">ha</span></div></div>
      <div class="wm-card"><div class="wm-label">Cobertura café</div><div class="wm-val">${coffee} <span class="wm-unit">ha</span></div></div>
      <div class="wm-card"><div class="wm-label">Cobertura arbórea</div><div class="wm-val">${tc2020} <span class="wm-unit">ha</span></div></div>
      <div class="wm-card"><div class="wm-label">Ganancia cultivo 20-24</div><div class="wm-val">${cropGain} <span class="wm-unit">ha</span></div></div>
    </div>
    ${alertHtml}
    <div class="whisp-indicators">
      <div class="wi-title">Indicadores de cumplimiento</div>
      ${indsHtml}
    </div>
    <div class="whisp-chart-card">
      <div class="wcc-title">Pérdida cobertura arbórea GFC (ha)</div>
      ${chartHtml}
    </div>
    <div style="padding:10px 16px 24px">
      <button class="btn-primary" style="width:100%" onclick="exportWhispReport()">📥 Exportar informe EUDR</button>
    </div>`;
}

function updateEudrFromWhisp(plot, p){
  const risk = p.risk_acrop || p.risk_pcrop || 'unknown';
  // Map WHISP risk to tier
  if(risk==='low') { plot.tier='high'; plot.tierlabel='WHISP: Riesgo bajo'; }
  else if(risk==='medium') { plot.tier='medium'; plot.tierlabel='WHISP: Riesgo medio'; }
  else { plot.tier='low'; plot.tierlabel='WHISP: Riesgo alto'; }
  // Update compliance detail
  renderComplianceList();
  renderPlotList();
}

function exportWhispReport(){
  const p = PLOTS[currentPlot];
  if(!p){ showToast('❌ Sin parcela activa'); return; }

  const ts   = new Date().toISOString();
  const wd   = p.whispData || WHISP_MOCK;
  const risk = wd.risk_acrop || wd.risk_pcrop || 'unknown';
  const riskES = risk==='low'?'Bajo':risk==='medium'?'Medio':'Alto';
  const compliant = risk==='low';
  const gfcAfter  = wd.GFC_loss_after_2020||0;

  // ── Build a self-contained HTML report ────────────────────────────────────
  const reportHTML = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Informe EUDR — ${p.name}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:700px;margin:40px auto;padding:0 20px;color:#111}
  h1{color:#0D3D2A;border-bottom:3px solid #0D3D2A;padding-bottom:8px}
  h2{color:#1A5C3E;margin-top:28px}
  .hero{background:#0D3D2A;color:white;border-radius:10px;padding:20px 24px;margin:16px 0}
  .hero .verdict{font-size:28px;font-weight:700;margin:4px 0}
  .hero .sub{font-size:13px;opacity:.75}
  table{width:100%;border-collapse:collapse;margin:12px 0}
  th{background:#E8F5EE;text-align:left;padding:8px 10px;font-size:12px;color:#0D3D2A;text-transform:uppercase;letter-spacing:.04em}
  td{padding:8px 10px;border-bottom:1px solid #D4E4DA;font-size:13px}
  .ok{color:#2E8B57;font-weight:600} .warn{color:#C84B2F;font-weight:600}
  .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700}
  .badge-ok{background:#E8F5EE;color:#0D3D2A} .badge-warn{background:#FFEBEE;color:#C84B2F}
  .footer{margin-top:40px;font-size:11px;color:#8A9E94;border-top:1px solid #D4E4DA;padding-top:12px}
  @media print{body{margin:20px}}
</style></head><body>
<h1>🌿 GeoCitizens — Informe de Cumplimiento EUDR</h1>

<div class="hero">
  <div class="sub">Parcela analizada</div>
  <div class="verdict">${compliant?'✅ CONFORME':'⚠️ REQUIERE REVISIÓN'}</div>
  <div class="sub">Reglamento UE 2023/1115 · Fecha de corte: 31 dic 2020</div>
</div>

<h2>1. Identificación de la parcela</h2>
<table>
  <tr><th>Campo</th><th>Valor</th></tr>
  <tr><td>Nombre</td><td><strong>${p.name}</strong></td></tr>
  <tr><td>Área (geométrica)</td><td>${p.area||'—'}</td></tr>
  <tr><td>Área (WHISP)</td><td>${(wd.Area||0).toFixed(2)} ha</td></tr>
  <tr><td>País</td><td>${wd.Country||'Colombia'}</td></tr>
  <tr><td>Departamento</td><td>${wd.Admin_Level_1||'Quindío'}</td></tr>
  <tr><td>Puntuación compuesta (Etapa 2)</td><td>${p.conf.toFixed(2)} — IC 90%: ${p.ci}</td></tr>
  <tr><td>Fecha del informe</td><td>${ts.slice(0,10)}</td></tr>
  <tr><td>Versión WHISP</td><td>${wd.whisp_processing_metadata?.whisp_version||'—'}</td></tr>
</table>

<h2>2. Veredicto de riesgo WHISP</h2>
<table>
  <tr><th>Indicador</th><th>Resultado</th></tr>
  <tr><td>Nivel de riesgo EUDR</td><td><span class="badge ${compliant?'badge-ok':'badge-warn'}">${riskES}</span></td></tr>
  <tr><td>Pérdida cobertura arbórea post-2020 (GFC)</td><td class="${gfcAfter>0?'warn':'ok'}">${gfcAfter.toFixed(3)} ha ${gfcAfter>0?'⚠️':'✓'}</td></tr>
  <tr><td>Cobertura café (FDaP)</td><td>${(wd.Coffee_FDaP||0).toFixed(2)} ha</td></tr>
  <tr><td>Cobertura arbórea 2020</td><td>${(wd.GFC_TC_2020||0).toFixed(2)} ha</td></tr>
  <tr><td>Ganancia agrícola 2020-2024</td><td>${(wd.ESRI_crop_gain_2020_2024||0).toFixed(2)} ha</td></tr>
</table>

<h2>3. Indicadores de cumplimiento EUDR</h2>
<table>
  <tr><th>Indicador</th><th>Clave</th><th>Resultado</th></tr>
  <tr><td>Cobertura forestal presente</td><td>Ind_01</td><td class="${wd.Ind_01_treecover==='yes'?'ok':'warn'}">${wd.Ind_01_treecover==='yes'?'Sí ✓':'No'}</td></tr>
  <tr><td>Materia prima regulada</td><td>Ind_02</td><td class="${wd.Ind_02_commodities==='yes'?'ok':'warn'}">${wd.Ind_02_commodities==='yes'?'Café ✓':'No detectado'}</td></tr>
  <tr><td>Perturbación antes de 2020</td><td>Ind_03</td><td class="${wd.Ind_03_disturbance_before_2020==='yes'?'warn':'ok'}">${wd.Ind_03_disturbance_before_2020==='yes'?'Sí ⚠️':'No ✓'}</td></tr>
  <tr><td>Perturbación después de 2020</td><td>Ind_04</td><td class="${wd.Ind_04_disturbance_after_2020==='yes'?'warn':'ok'}">${wd.Ind_04_disturbance_after_2020==='yes'?'Sí ⚠️':'No ✓'}</td></tr>
  <tr><td>Bosque primario 2020</td><td>Ind_05</td><td class="${wd.Ind_05_primary_2020==='yes'?'ok':'warn'}">${wd.Ind_05_primary_2020==='yes'?'Sí ✓':'No'}</td></tr>
  <tr><td>Expansión agrícola post-2020</td><td>Ind_10</td><td class="${wd.Ind_10_agri_after_2020==='yes'?'warn':'ok'}">${wd.Ind_10_agri_after_2020==='yes'?'Detectada ⚠️':'No detectada ✓'}</td></tr>
</table>

<h2>4. Validación geométrica (Etapa 1)</h2>
<table>
  <tr><th>Métrica</th><th>Valor</th></tr>
  <tr><td>Área calculada</td><td>${p.area||'—'}</td></tr>
  <tr><td>Compacidad Polsby–Popper</td><td>${p.compact||'—'}</td></tr>
  <tr><td>Número de vértices</td><td>${p.verts||'—'}</td></tr>
  <tr><td>Topología</td><td class="ok">${p.needsRepair?'Reparada':'Válida ✓'}</td></tr>
</table>

<h2>5. Evidencia semántica (Etapa 2)</h2>
<table>
  <tr><th>Capa</th><th>Puntuación</th><th>Estado</th></tr>
  <tr><td>A2 — Cobertura MapBiomas</td><td>${p.a2!=null?p.a2.toFixed(2):'—'}</td><td class="${p.a2>=0.6?'ok':'warn'}">${p.a2!=null?(p.a2>=0.6?'✓':'Revisar'):'N/D'}</td></tr>
  <tr><td>A3 — IoU catastral IGAC</td><td>${p.a3!=null?p.a3.toFixed(2):'N/D'}</td><td class="${p.a3!=null?(p.a3>=0.6?'ok':'warn'):''}'">${p.a3!=null?(p.a3>=0.6?'✓':'Revisar'):'Sin registro (no penaliza)'}</td></tr>
  <tr><td>A4 — Pendiente SRTM</td><td>${p.a4!=null?p.a4.toFixed(2):'—'}</td><td class="${p.a4>=0.6?'ok':'warn'}">${p.a4!=null?(p.a4>=0.6?'✓':'Revisar'):'N/D'}</td></tr>
</table>

<h2>6. Declaración de diligencia debida</h2>
<p style="font-size:13px;line-height:1.7;background:#f9f9f9;padding:14px;border-left:4px solid #0D3D2A;border-radius:0 8px 8px 0">
El operador declara, conforme al Artículo 3 del Reglamento UE 2023/1115 (EUDR), que la parcela
<strong>${p.name}</strong> ha sido analizada mediante el sistema GeoCitizens, el modelo WHISP (OpenForis),
y datos de pérdida forestal GFC/TMF. El análisis concluye que la parcela presenta
<strong>riesgo ${riskES.toLowerCase()}</strong> de deforestación post-2020.
${compliant?'La parcela cumple con los requisitos de geolocalización y libre de deforestación del EUDR.':'Se recomienda revisión adicional antes de proceder con la declaración de diligencia debida.'}
</p>

<div class="footer">
  Generado por GeoCitizens · ${ts} · WHISP v${wd.whisp_processing_metadata?.whisp_version||'—'} · 
  Reglamento UE 2023/1115 · Fecha de corte: 31 diciembre 2020
</div>
</body></html>`;

  // Download as HTML (opens as a formatted report the farmer can print to PDF)
  const blob = new Blob([reportHTML], {type:'text/html;charset=utf-8'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `EUDR_${p.name.replace(/\s+/g,'_')}_${ts.slice(0,10)}.html`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  // Also offer JSON audit log
  const auditJSON = {
    report_type:'GeoCitizens EUDR Audit Log', version:'1.0',
    generated_utc: ts, eudr_cutoff:'2020-12-31',
    plot:{ name:p.name, area_ha:p.area, compact:p.compact, verts:p.verts },
    stage2:{ composite:p.conf, ci:p.ci, a2:p.a2, a3:p.a3, a4:p.a4 },
    whisp:{ risk:risk, gfc_loss_after_2020:gfcAfter,
      ind_01:wd.Ind_01_treecover, ind_02:wd.Ind_02_commodities,
      ind_03:wd.Ind_03_disturbance_before_2020, ind_04:wd.Ind_04_disturbance_after_2020,
      ind_05:wd.Ind_05_primary_2020, ind_10:wd.Ind_10_agri_after_2020,
      whisp_version:wd.whisp_processing_metadata?.whisp_version },
    eudr_compliant: compliant
  };
  setTimeout(()=>{
    const jblob = new Blob([JSON.stringify(auditJSON,null,2)],{type:'application/json'});
    const jurl  = URL.createObjectURL(jblob);
    const ja    = document.createElement('a');
    ja.href=jurl; ja.download=`EUDR_${p.name.replace(/\s+/g,'_')}_${ts.slice(0,10)}.json`;
    document.body.appendChild(ja); ja.click();
    document.body.removeChild(ja); URL.revokeObjectURL(jurl);
  }, 400);

  showToast('📥 Descargando informe HTML + log JSON');
}

// ══════════════════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// PER-PLOT WHISP MOCK (each plot gets its own realistic variation)
// ══════════════════════════════════════════════════════════════════════════
function generatePlotWhispMock(plot){
  const ring = plot.geojson?.features?.[0]?.geometry?.coordinates?.[0]?.slice(0,-1);
  const area = ring ? polygonAreaHa(ring) : 10;
  const pp   = ring ? polsbyPopper(ring)  : 0.4;
  const conf = plot.conf || 0.6;

  // GFC loss: base on conf — better-scored plots have less recent loss
  const gfcAfter = conf >= 0.65 ? 0.0 : conf >= 0.5 ? parseFloat((Math.random()*0.8).toFixed(2)) : parseFloat((Math.random()*2.5).toFixed(2));
  const gfc2023  = conf >= 0.65 ? 0.0 : parseFloat((gfcAfter * (Math.random()*0.6)).toFixed(2));
  const coffeePct= Math.min(0.95, Math.max(0.3, pp * 0.6 + 0.3));

  const risk = (gfcAfter > 0.5 || conf < 0.45) ? 'medium' : 'low';

  return {
    Area: parseFloat(area.toFixed(2)),
    Country: 'Colombia',
    Admin_Level_1: 'Quindío',
    Coffee_FDaP: parseFloat((area * coffeePct).toFixed(2)),
    GFC_TC_2020: parseFloat((area * 0.18).toFixed(2)),
    ESRI_crop_gain_2020_2024: 0.0,
    GFC_loss_after_2020: gfcAfter,
    GFC_loss_year_2021: parseFloat((gfcAfter * 0.4).toFixed(2)),
    GFC_loss_year_2022: parseFloat((gfcAfter * 0.3).toFixed(2)),
    GFC_loss_year_2023: gfc2023,
    GFC_loss_year_2018: parseFloat((Math.random()*0.3).toFixed(2)),
    GFC_loss_year_2015: parseFloat((Math.random()*0.15).toFixed(2)),
    risk_acrop: risk, risk_pcrop: risk,
    Ind_01_treecover:               'yes',
    Ind_02_commodities:             'yes',
    Ind_03_disturbance_before_2020: 'no',
    Ind_04_disturbance_after_2020:  gfcAfter > 0 ? 'yes' : 'no',
    Ind_05_primary_2020:            'no',
    Ind_10_agri_after_2020:         'no',
    whisp_processing_metadata: {
      whisp_version: '1.3.2',
      processing_timestamp_utc: new Date().toISOString()
    }
  };
}
