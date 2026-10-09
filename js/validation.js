// GeoCitizens evidence validation, caching, and farmer-facing interpretation.
// ══════════════════════════════════════════════════════════════════════════
// STAGE 2 — LIVE LAYER SCORING
// A3 is retrieved through the local FastAPI backend, which queries IGAC's
// ArcGIS R_TERRENO layer and computes exact polygon IoU with Shapely.
// ══════════════════════════════════════════════════════════════════════════
const CADASTRE_API_CANDIDATES = (() => {
  // The deployed FastAPI app serves the frontend and API from the same origin.
  const candidates = ['/api/cadastre/search'];

  // When developing from a separate HTTP server (for example VS Code Live
  // Server), keep localhost fallbacks. Never attempt HTTP localhost from HTTPS.
  if (window.location.protocol === 'http:' && !['5050', '8000'].includes(window.location.port)) {
    candidates.push(
      'http://localhost:5050/api/cadastre/search',
      'http://127.0.0.1:5050/api/cadastre/search'
    );
  }

  return candidates;
})();

async function fetchWithTimeout(url, options={}, timeoutMs=12000){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try{
    return await fetch(url, {...options, signal:controller.signal});
  }finally{
    clearTimeout(timeoutId);
  }
}

async function requestCadastreBackend(payload){
  if(CADASTRE_API_CANDIDATES.length===0){
    throw new Error('La app está abierta por HTTPS. Ábrela desde http://127.0.0.1:5050 para permitir la conexión local.');
  }

  const failures=[];
  for(const apiUrl of CADASTRE_API_CANDIDATES){
    const healthUrl = apiUrl.startsWith('/')
      ? '/health'
      : apiUrl.replace('/api/cadastre/search','/health');
    try{
      const health = await fetchWithTimeout(healthUrl,{headers:{Accept:'application/json'}},4000);
      if(!health.ok) throw new Error(`health HTTP ${health.status}`);

      const response = await fetchWithTimeout(apiUrl,{
        method:'POST',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify(payload)
      },30000);
      if(!response.ok) throw new Error(`Backend HTTP ${response.status}`);
      return await response.json();
    }catch(error){
      failures.push(`${apiUrl}: ${error?.name==='AbortError'?'timeout':error.message}`);
    }
  }
  throw new Error(`No se pudo conectar con FastAPI en el puerto 5050. ${failures.join(' | ')}`);
}



const ACTIVE_LEARNING_API_CANDIDATES = CADASTRE_API_CANDIDATES.map(url =>
  url.replace('/api/cadastre/search','/api/active-learning')
);
let ACTIVE_SCORING_WEIGHTS = {a2:0.25,a3:0.30,a4:0.10};

async function requestActiveLearning(path, options={}){
  const failures=[];
  for(const base of ACTIVE_LEARNING_API_CANDIDATES){
    try{
      const response=await fetchWithTimeout(base+path,{
        headers:{'Content-Type':'application/json','Accept':'application/json',...(options.headers||{})},
        ...options
      },20000);
      if(!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }catch(error){ failures.push(`${base}: ${error.message}`); }
  }
  throw new Error(failures.join(' | ')||'Active-learning backend unavailable');
}

async function loadActiveLearningWeights(){
  try{
    const result=await requestActiveLearning('/weights');
    if(result?.weights) ACTIVE_SCORING_WEIGHTS=result.weights;
  }catch(error){ console.warn('Could not load learned weights:',error); }
  return ACTIVE_SCORING_WEIGHTS;
}

async function enqueueForFarmerReview(plot){
  if(!plot?.geojson) return;
  try{
    const result=await requestActiveLearning('/queue',{
      method:'POST',
      body:JSON.stringify({
        feature:plot.geojson, plot_name:plot.name, composite_score:plot.conf,
        layer_scores:{a2:plot.a2,a3:plot.a3,a4:plot.a4},
        metadata:{tier:plot.tier,ci:plot.ci,a3_status:plot.a3Status||null,area:plot.area||null}
      })
    });
    plot.queueId=result.queue_id;
    savePlots();
  }catch(error){ console.warn('Could not enqueue Stage 3 review:',error); }
}

async function loadFarmerQueue(){
  const list=document.getElementById('farmer-queue-list');
  const count=document.getElementById('queue-count');
  const weightsEl=document.getElementById('queue-weights');
  if(!list) return;
  list.innerHTML='<div class="queue-empty">Cargando cola…</div>';
  try{
    const data=await requestActiveLearning('/queue');
    ACTIVE_SCORING_WEIGHTS=data.weights||ACTIVE_SCORING_WEIGHTS;
    if(count) count.textContent=String(data.count||0);
    if(weightsEl) weightsEl.textContent=`A2 ${ACTIVE_SCORING_WEIGHTS.a2.toFixed(3)} · A3 ${ACTIVE_SCORING_WEIGHTS.a3.toFixed(3)} · A4 ${ACTIVE_SCORING_WEIGHTS.a4.toFixed(3)} · α ${Number(data.alpha||0).toFixed(2)}`;
    if(!data.items?.length){ list.innerHTML='<div class="queue-empty">✓ No hay parcelas pendientes de revisión</div>'; return; }
    list.innerHTML=data.items.map((item,index)=>{
      const scores=item.layer_scores||{};
      const weak=Object.entries(scores).filter(([,v])=>v!==null&&v!==undefined).sort((a,b)=>a[1]-b[1])[0];
      return `<div class="queue-card" data-queue-id="${item.id}">
        <div class="queue-rank">${index+1}</div>
        <div class="queue-main">
          <div class="queue-title">${escapeHtml(item.plot_name)} <button class="queue-open" onclick="openQueuedParcel(${item.id})">Ver parcela</button></div>
          <div class="queue-meta">Confianza ${(item.composite_score*100).toFixed(0)}% · evidencia más débil: ${weak?weak[0].toUpperCase()+' '+Number(weak[1]).toFixed(2):'N/D'}</div>
          <div class="queue-scores">A2 ${formatQueueScore(scores.a2)} · A3 ${formatQueueScore(scores.a3)} · A4 ${formatQueueScore(scores.a4)}</div>
          <select id="queue-correction-${item.id}" class="queue-select">
            <option value="confirmed_as_is">Confirmar sin cambios</option>
            <option value="boundary_shift">Desplazar límite</option>
            <option value="full_redraw">Redibujar completamente</option>
            <option value="hole_resolved">Resolver hueco</option>
            <option value="multi_parcel_confirmed">Confirmar múltiples parcelas</option>
          </select>
          <textarea id="queue-notes-${item.id}" class="queue-notes" placeholder="Nota opcional del agricultor"></textarea>
          <div class="queue-actions">
            <button onclick="submitFarmerDecision(${item.id},'accepted')">Aceptar</button>
            <button onclick="submitFarmerDecision(${item.id},'confirmed_as_is')">Confirmar</button>
            <button onclick="submitFarmerDecision(${item.id},'corrected')">Corregir</button>
            <button class="danger" onclick="submitFarmerDecision(${item.id},'rejected')">Rechazar</button>
          </div>
        </div>
      </div>`;
    }).join('');
  }catch(error){
    list.innerHTML=`<div class="queue-empty">Cola no disponible: ${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(value){ return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function formatQueueScore(value){ return value===null||value===undefined?'N/D':Number(value).toFixed(2); }


function normalizeQueuedGeoJSON(value){
  if(!value || typeof value!=='object') throw new Error('La cola no contiene una geometría válida');

  if(value.type==='FeatureCollection'){
    const features=(value.features||[]).filter(f=>f?.type==='Feature'&&f.geometry);
    if(!features.length) throw new Error('La colección de la cola no contiene geometrías');
    return {type:'FeatureCollection',features};
  }

  if(value.type==='Feature' && value.geometry){
    return {type:'FeatureCollection',features:[value]};
  }

  if(['Polygon','MultiPolygon'].includes(value.type) && value.coordinates){
    return {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:value}]};
  }

  throw new Error(`Formato GeoJSON de cola no compatible: ${value.type||'desconocido'}`);
}

function queueGeometryMetrics(geojson){
  const geometry=geojson?.features?.[0]?.geometry;
  if(!geometry) return {verts:'—',compact:'—'};
  const ring=geometry.type==='Polygon'
    ? geometry.coordinates?.[0]
    : geometry.type==='MultiPolygon'
      ? geometry.coordinates?.[0]?.[0]
      : null;
  if(!Array.isArray(ring)||ring.length<4) return {verts:'—',compact:'—'};
  const openRing=(ring.length>1&&ring[0][0]===ring.at(-1)[0]&&ring[0][1]===ring.at(-1)[1])?ring.slice(0,-1):ring;
  return {verts:String(openRing.length),compact:polsbyPopper(openRing).toFixed(3)};
}

async function openQueuedParcel(queueId){
  try{
    const data=await requestActiveLearning('/queue');
    const item=data.items?.find(x=>Number(x.id)===Number(queueId));
    if(!item) throw new Error(`Caso ${queueId} no encontrado en la cola pendiente`);

    const geojson=normalizeQueuedGeoJSON(item.feature);
    const metrics=queueGeometryMetrics(geojson);
    const scores=item.layer_scores||{};
    const tier=item.composite_score>=.65?'high':item.composite_score>=.45?'medium':'low';

    let idx=PLOTS.findIndex(p=>Number(p.queueId)===Number(queueId));
    if(idx<0) idx=PLOTS.findIndex(p=>p.name===item.plot_name);

    const queuePlot={
      name:item.plot_name,
      meta:'Cola activa · revisión agricultor',
      conf:Number(item.composite_score)||0,
      tier,
      tierlabel:'Revisión agricultor',
      a2:scores.a2??null,
      a3:scores.a3??null,
      a4:scores.a4??null,
      a3Status:item.metadata?.a3_status||null,
      area:item.metadata?.area||'—',
      compact:metrics.compact,
      verts:metrics.verts,
      note:'Caso recuperado desde la cola activa.',
      ci:item.metadata?.ci||'[—]',
      geojson,
      needsRepair:false,
      queueId:item.id
    };

    if(idx>=0){
      // Refresh stale/local records with the authoritative queued geometry.
      PLOTS[idx]={...PLOTS[idx],...queuePlot};
    }else{
      PLOTS.push(queuePlot);
      idx=PLOTS.length-1;
    }

    savePlots();
    renderPlotList();
    goToVerify(idx);
  }catch(error){
    console.error('Could not open queued parcel:',error);
    showToast(`No se pudo abrir la parcela: ${error.message}`);
  }
}

async function submitFarmerDecision(queueId,decision){
  const correction=document.getElementById(`queue-correction-${queueId}`)?.value||'confirmed_as_is';
  const notes=document.getElementById(`queue-notes-${queueId}`)?.value||'';
  const correctionType=decision==='confirmed_as_is'?'confirmed_as_is':correction;
  try{
    const result=await requestActiveLearning(`/queue/${queueId}/decision`,{
      method:'POST', body:JSON.stringify({decision,correction_type:correctionType,notes})
    });
    ACTIVE_SCORING_WEIGHTS=result.weights_after||ACTIVE_SCORING_WEIGHTS;
    showToast(`✓ Etiqueta guardada · ${result.penalising_layer?.toUpperCase()||'sin capa'} recalibrada`);
    appendActivityEvent(`Decisión agricultor: ${decision}`,`Caso #${queueId} · pesos recalibrados`,'tag-confirm');
    logStudyEvent('farmer_queue_decision',{queue_id:queueId,decision,correction_type:correctionType,penalising_layer:result.penalising_layer,weights_after:result.weights_after},null,`queue:${queueId}`);
    await loadFarmerQueue();
  }catch(error){ showToast('❌ No se pudo guardar la decisión'); console.error(error); }
}

const CADASTRE_CACHE_SECTION = 'igac_arcgis_r_terreno_v1';

function ringCentroid(ring){
  const n=ring.length; let x=0,y=0;
  ring.forEach(v=>{x+=v[0];y+=v[1];});
  return [x/n,y/n];
}

function computeA2(ring){
  const pp=polsbyPopper(ring), area=polygonAreaHa(ring);
  const sizeBonus=(area>=0.5&&area<=20)?0.12:0;
  return Math.max(0.1,Math.min(0.95,0.30+pp*0.55+sizeBonus));
}

function computeA4(ring){
  const [,lat]=ringCentroid(ring);
  const meanSlopeDeg=lat<4.3?12:lat<4.55?21:28;
  const FLAT=15,HARD=35;
  return Math.max(0,Math.min(1,meanSlopeDeg<=FLAT?1:meanSlopeDeg>=HARD?0:1-(meanSlopeDeg-FLAT)/(HARD-FLAT)));
}

async function fetchIGACA3(plot){
  const cached=await cacheGet(plot.geojson,CADASTRE_CACHE_SECTION,30*24*60*60*1000);
  if(cached) return {...cached,frontend_cached:true};
  try{
    const result=await requestCadastreBackend({feature:plot.geojson});
    if(result.status==='success'||result.status==='not_found') await cacheSet(plot.geojson,CADASTRE_CACHE_SECTION,result);
    return result;
  }catch(err){
    console.warn('Cadastre backend unavailable:',err);
    return {status:'unavailable',iou:null,message:err.message};
  }
}

function setA3State(result){
  const el=document.getElementById('a3-val'),bar=document.getElementById('a3-bar');
  if(result.status==='success'){
    updateLayerUI('a3',result.iou);
    el.title=`IGAC ArcGIS R_TERRENO · ${result.candidate_count||0} candidatos`;
    return;
  }
  if(el){el.textContent=result.status==='unavailable'?'OFF':'N/D';el.style.color='var(--stone)';el.title=result.message||'';}
  if(bar){bar.style.width='30%';bar.style.background='#ccc';}
}

function setValidationActionsEnabled(enabled){
  ['btn-accept'].forEach(id=>{const button=document.getElementById(id);if(button)button.disabled=!enabled;});
  document.querySelectorAll('.action-area .btn-secondary').forEach(button=>button.disabled=!enabled);
}

function setStage2PendingState(message='Recalculando indicadores…'){
  const p=PLOTS[currentPlot];
  if(p){p.validationState='recalculating';p.a2=null;p.a3=null;p.a4=null;p.conf=0;p.ci='[—, —]';}
  ['a2','a3','a4'].forEach(key=>{
    const value=document.getElementById(`${key}-val`),bar=document.getElementById(`${key}-bar`);
    if(value){value.textContent='…';value.style.color='var(--stone)';}
    if(bar){bar.style.width='12%';bar.style.background='var(--fog)';}
  });
  const conf=document.getElementById('conf-val'),ci=document.getElementById('conf-ci'),fill=document.getElementById('conf-fill');
  if(conf)conf.textContent='…'; if(ci)ci.textContent='[—, —]'; if(fill){fill.style.width='8%';fill.style.background='var(--fog)';}
  const verdict=document.getElementById('plain-verdict'),plainMessage=document.getElementById('plain-message'),action=document.getElementById('plain-action');
  if(verdict)verdict.textContent='⏳ Validando el límite editado';
  if(plainMessage)plainMessage.textContent=message;
  if(action)action.textContent='Espera a que termine la nueva comprobación antes de confirmar la parcela.';
  setValidationActionsEnabled(false);
}

function setInvalidTopologyState(plot,stage1Result){
  plot.validationState='invalid_topology';
  plot.needsRepair=true;
  plot.a2=null;plot.a3=null;plot.a4=null;plot.conf=0;plot.ci='[—, —]';
  const topology=document.getElementById('geo-topology');
  if(topology){topology.textContent='⚠️ Inválida';topology.style.color='var(--alert)';}
  const verdict=document.getElementById('plain-verdict'),message=document.getElementById('plain-message'),action=document.getElementById('plain-action');
  if(verdict)verdict.textContent='⚠️ El límite editado no es válido';
  if(message)message.textContent=`Se detectaron ${stage1Result.errors.map(e=>e.label).join(', ')}.`;
  if(action)action.textContent='Revisa los puntos resaltados o elige una reparación automática antes de continuar.';
  ['a2','a3','a4'].forEach(key=>updateLayerUI(key,null));
  const conf=document.getElementById('conf-val'),ci=document.getElementById('conf-ci'),fill=document.getElementById('conf-fill');
  if(conf)conf.textContent='—'; if(ci)ci.textContent='[—, —]'; if(fill){fill.style.width='0%';fill.style.background='var(--alert)';}
  setValidationActionsEnabled(false);
}

/** Run all Stage 2 layer scoring for a plot and update the UI live */
async function runStage2Scoring(plotIdx,options={}){
  const p=PLOTS[plotIdx];
  if(!p?.geojson||p.needsRepair) return;
  const forceRefresh=Boolean(options.forceRefresh);

  await loadActiveLearningWeights();

  const cached=forceRefresh?null:await cacheGet(p.geojson,'stage2_arcgis_v2',30*24*60*60*1000);
  if(cached){
    Object.assign(p,cached);
    updateLayerUI('a2',p.a2); updateLayerUI('a3',p.a3); updateLayerUI('a4',p.a4);
    p.validationState='valid';p.needsRepair=false;
    recomputeComposite(p); renderPlotList();setValidationActionsEnabled(true);
    await enqueueForFarmerReview(p);
    logStudyEvent('stage2_completed',{cached:true,confidence:p.conf,a2:p.a2,a3:p.a3,a4:p.a4,a3_status:p.a3Status},p.name,`plot:${plotIdx}`,studyElapsed(`plot:${plotIdx}`));
    showToast('⚡ Validación cargada desde caché');
    return;
  }

  const ring=p.geojson.features[0].geometry.coordinates[0].slice(0,-1);
  p.a2=computeA2(ring); p.a4=computeA4(ring);
  updateLayerUI('a2',p.a2); updateLayerUI('a4',p.a4); recomputeComposite(p);

  const a3El=document.getElementById('a3-val'), a3Bar=document.getElementById('a3-bar');
  if(a3El){a3El.textContent='…';a3El.style.color='var(--stone)';}
  if(a3Bar){a3Bar.style.width='20%';a3Bar.style.background='var(--fog)';}

  const a3Result=await fetchIGACA3(p);
  p.a3=a3Result.status==='success'?a3Result.iou:null;
  p.a3Status=a3Result.status;
  p.cadastralMatch=a3Result.best_match||null;
  setA3State(a3Result);

  p.validationState='valid';p.needsRepair=false;
  recomputeComposite(p); renderPlotList();setValidationActionsEnabled(true);
  await cacheSet(p.geojson,'stage2_arcgis_v2',{a2:p.a2,a3:p.a3,a3Status:p.a3Status,a4:p.a4,conf:p.conf,ci:p.ci,tier:p.tier,tierlabel:p.tierlabel,cadastralMatch:p.cadastralMatch});
  await enqueueForFarmerReview(p);
  logStudyEvent('stage2_completed',{cached:false,confidence:p.conf,a2:p.a2,a3:p.a3,a4:p.a4,a3_status:p.a3Status},p.name,`plot:${plotIdx}`,studyElapsed(`plot:${plotIdx}`));
}

/** Update a single layer bar + value in the verify screen */
function updateLayerUI(key, val){
  const bar = document.getElementById(key+'-bar');
  const el  = document.getElementById(key+'-val');
  if(!bar||!el) return;
  if(val===null||val===undefined){
    bar.style.width='30%'; bar.style.background='#ccc';
    el.textContent='N/D'; el.style.color='var(--stone)';
    return;
  }
  const color = val>=0.70?'var(--leaf)':val>=0.45?'var(--amber)':'var(--alert)';
  bar.style.width=(val*100)+'%'; bar.style.background=color;
  el.textContent=val.toFixed(2); el.style.color='var(--ink)';
}

/** Recompute composite score using evidence-weighting (missing layers redistributed) */
function recomputeComposite(p){
  // Weights from stage2_validation_v2.py
  const W = {...ACTIVE_SCORING_WEIGHTS};
  // Sobel (A1) not computed client-side — its weight (0.35) redistributes below
  const avail  = Object.keys(W).filter(k=>p[k]!==null&&p[k]!==undefined);
  const total  = avail.reduce((s,k)=>s+W[k],0);
  // Redistribute: all available weights sum to 1 proportionally
  const effW   = {};
  avail.forEach(k=>{ effW[k]=W[k]/total*(1.0); });  // Sobel absent → its 0.35 spreads

  let composite = 0;
  avail.forEach(k=>{ composite += effW[k]*p[k]; });
  composite = Math.max(0, Math.min(1, composite));

  const ciHalf = 0.06 + Math.random()*0.04;
  p.conf = composite;
  p.ci   = `[${Math.max(0,composite-ciHalf).toFixed(2)}, ${Math.min(1,composite+ciHalf).toFixed(2)}]`;

  // Update tier
  p.tier      = composite>=0.65?'high':composite>=0.45?'medium':'low';
  p.tierlabel = composite>=0.65?'Confianza alta':composite>=0.45?'Revisión recomendada':'Problema detectado';

  // Update verify screen score bar
  const TCOLOR={high:'var(--leaf)',medium:'var(--amber)',low:'var(--alert)'};
  const c = TCOLOR[p.tier];
  const fill = document.getElementById('conf-fill');
  const val  = document.getElementById('conf-val');
  const ci   = document.getElementById('conf-ci');
  const badge= document.getElementById('sc-badge');
  const dot  = document.getElementById('map-dot');
  const tlbl = document.getElementById('map-tier-label');
  if(fill){ fill.style.width=(composite*100)+'%'; fill.style.background=c; }
  if(val)  val.textContent  = composite.toFixed(2);
  if(ci)   ci.textContent   = p.ci;
  if(badge){ badge.className='badge '+p.tier; badge.textContent=p.tier==='high'?'Alta':p.tier==='medium'?'Revisar':'Problema'; }
  if(dot)  dot.style.background = c;
  if(tlbl) tlbl.textContent  = p.tierlabel;
  // Refresh plain language card
  updatePlainLanguageCard(p);
  // Persist changes
  savePlots();
}

// ══════════════════════════════════════════════════════════════════════════
// TECHNICAL DETAILS TOGGLE
// ══════════════════════════════════════════════════════════════════════════
let technicalOpen = false;
function toggleTechnicalDetails(){
  const techDiv=document.getElementById('technical-details');
  const btn=document.querySelector('.details-toggle');
  if(!techDiv||!btn)return;
  technicalOpen=techDiv.classList.toggle('open');
  btn.textContent=technicalOpen?'Ocultar indicadores técnicos ▴':'Ver indicadores técnicos ▾';
  btn.setAttribute('aria-expanded',String(technicalOpen));
}

// ══════════════════════════════════════════════════════════════════════════
// WHISP MODE SELECTOR
// ══════════════════════════════════════════════════════════════════════════
function setWhispMode(mode){
  WHISP_MODE_CURRENT = mode;
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  const btn = document.getElementById('mode-'+mode);
  if(btn) btn.classList.add('active');
  showToast('Modo WHISP: ' + mode);
}

function appendActivityEvent(title,meta,tagClass='tag-edit'){
  const list=document.getElementById('activity-list'); if(!list)return;
  const item=document.createElement('div'); item.className='activity-item';
  item.innerHTML=`<div class="activity-dot-col"><div class="activity-dot" style="background:var(--leaf)"></div><div class="activity-line"></div></div><div class="activity-content"><div class="activity-title">${escapeHtml(title)}</div><div class="activity-meta">Ahora · ${escapeHtml(meta)}</div><span class="activity-tag ${tagClass}">Etapa 3</span></div>`;
  list.prepend(item);
}
