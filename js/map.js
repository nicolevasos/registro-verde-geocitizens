// GeoCitizens map rendering, editing, and repair review UI.
// ══════════════════════════════════════════════════════════════════════════
// REPAIR MODAL — OPEN
// ══════════════════════════════════════════════════════════════════════════
function openRepairModal(pendingPlot, stage1Result){
  startStudyTask(`repair:${pendingPlot.name}`);
  logStudyEvent('repair_review_opened',{error_count:stage1Result.errors.length,candidate_count:stage1Result.candidates.length,errors:stage1Result.errors.map(e=>e.type)},pendingPlot.name,`repair:${pendingPlot.name}`);
  repairPendingPlot  = pendingPlot;
  repairCandidates   = stage1Result.candidates;
  selectedCandidateIdx = 0;

  const {errors, candidates, origRing} = stage1Result;

  // Subtitle
  document.getElementById('repair-subtitle').textContent =
    `Se detectaron ${errors.length} problema${errors.length>1?'s':''} en "${pendingPlot.name}". `+
    `Compara ${candidates.length} alternativa${candidates.length!==1?'s':''} y elige la que más se parece al límite real.`;

  // Error pills
  document.getElementById('error-strip').innerHTML =
    errors.map(e=>`<div class="error-pill"><span class="ep-icon">${e.icon}</span>${e.label}</div>`).join('');

  const acceptButton=document.querySelector('.repair-btn-accept');
  const editButton=document.querySelector('.repair-btn-edit');
  if(acceptButton)acceptButton.disabled=candidates.length===0;
  if(editButton)editButton.disabled=candidates.length===0;
  if(candidates.length===0){
    document.getElementById('repair-subtitle').textContent=`El límite editado de "${pendingPlot.name}" no es válido y no se pudo generar una reparación segura. Vuelve al mapa y ajusta los vértices manualmente.`;
  }

  // Fill scores table for the recommended option
  const best = candidates[0];
  if(best){
    const sc = best.scores;
    document.getElementById('rs-v-orig').textContent   = sc.V_orig.toFixed(2);
    document.getElementById('rs-v-rep').textContent    = sc.V_rep.toFixed(2);
    const dV = sc.V_rep-sc.V_orig;
    document.getElementById('rs-v-delta').textContent  = (dV>=0?'+':'')+dV.toFixed(2);
    document.getElementById('rs-v-delta').className    = 'rs-delta '+(dV>0?'pos':dV<0?'neg':'neu');
    document.getElementById('rs-aps').textContent      = sc.APS.toFixed(2);
    const dAPS=sc.APS-1.0;
    document.getElementById('rs-aps-delta').textContent= (dAPS>=0?'+':'')+dAPS.toFixed(2);
    document.getElementById('rs-aps-delta').className  = 'rs-delta '+(dAPS>=-0.05?'pos':'neg');
    document.getElementById('rs-scs-orig').textContent = polsbyPopper(origRing).toFixed(3);
    document.getElementById('rs-scs-rep').textContent  = sc.SCS.toFixed(2);
    const dSCS=sc.SCS-polsbyPopper(origRing);
    document.getElementById('rs-scs-delta').textContent=(dSCS>=0?'+':'')+dSCS.toFixed(2);
    document.getElementById('rs-scs-delta').className  = 'rs-delta '+(dSCS>=0?'pos':'neg');
    const scoreOrig = 0.0; // original has validity=0
    document.getElementById('rs-total-orig').textContent = scoreOrig.toFixed(2);
    document.getElementById('rs-total-rep').textContent  = sc.score.toFixed(2);
    const dTot=sc.score-scoreOrig;
    document.getElementById('rs-total-delta').textContent=(dTot>=0?'+':'')+dTot.toFixed(2);
    document.getElementById('rs-total-delta').className  = 'rs-delta pos';
  }

  // Candidate list
  renderCandidateList(origRing);

  // Show modal
  document.getElementById('repair-overlay').classList.add('active');
  submitRepairCandidatesForLearning(pendingPlot, stage1Result);

  // Init maps after DOM is visible
  setTimeout(()=>initRepairMaps(origRing, candidates[0]?.ring || origRing), 80);
}

function repairCandidateDisplayLimit(){
  const condition=new URLSearchParams(location.search).get('condition');
  return condition==='single_candidate'?1:3;
}

function renderCandidateList(origRing){
  const list = document.getElementById('repair-cand-list');
  const labels=['Recomendada','Alternativa','Conservadora'];
  list.innerHTML = repairCandidates.slice(0,repairCandidateDisplayLimit()).map((c,i)=>{
    const areaOrig=polygonAreaHa(origRing);
    const areaDelta=areaOrig>0?((c.scores.areaHa-areaOrig)/areaOrig*100):0;
    const moved=Math.max(0,origRing.length-c.ring.length);
    const warning=Math.abs(areaDelta)>15?'⚠️ Cambio de área importante':'';
    return `<div class="repair-cand ${i===selectedCandidateIdx?'selected':''}" onclick="selectCandidate(${i})">
      <div class="rc-radio"></div>
      <div class="rc-body">
        <div class="rc-kicker">${labels[i]||'Opción '+(i+1)} · rango ${i+1}</div>
        <div class="rc-name">${c.name}</div>
        <div class="rc-desc">${c.desc}</div>
        <div class="rc-metrics">Área ${areaDelta>=0?'+':''}${areaDelta.toFixed(1)}% · ${c.ring.length} vértices · ${moved} eliminados · PP ${c.scores.pp.toFixed(3)}</div>
        ${warning?`<div class="rc-warning">${warning}</div>`:''}
      </div>
      <div class="rc-score" style="color:${c.scores.score>=0.7?'var(--leaf)':c.scores.score>=0.5?'var(--amber)':'var(--alert)'}">${(c.scores.score*100).toFixed(0)}</div>
    </div>`;
  }).join('');
}

function updateRepairScoreTable(origRing,candidate){
  if(!candidate) return;
  const sc=candidate.scores;
  const ppOrig=polsbyPopper(origRing);
  const pairs={
    'rs-v-orig':sc.V_orig.toFixed(2),'rs-v-rep':sc.V_rep.toFixed(2),
    'rs-aps':sc.APS.toFixed(2),'rs-scs-orig':ppOrig.toFixed(3),
    'rs-scs-rep':sc.SCS.toFixed(2),'rs-total-orig':'0.00','rs-total-rep':sc.score.toFixed(2)
  };
  Object.entries(pairs).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.textContent=val;});
  const deltas=[['rs-v-delta',sc.V_rep-sc.V_orig],['rs-aps-delta',sc.APS-1],['rs-scs-delta',sc.SCS-ppOrig],['rs-total-delta',sc.score]];
  deltas.forEach(([id,d])=>{const el=document.getElementById(id);if(!el)return;el.textContent=(d>=0?'+':'')+d.toFixed(2);el.className='rs-delta '+(d>0?'pos':d<0?'neg':'neu');});
}

function selectCandidate(idx){
  selectedCandidateIdx=idx;
  const selected=repairCandidates[idx];
  logStudyEvent('repair_candidate_selected',{rank:idx+1,candidate:selected?.name,score:selected?.scores?.score},repairPendingPlot?.name,`repair:${repairPendingPlot?.name}`,studyElapsed(`repair:${repairPendingPlot?.name}`));
  const origRing = repairPendingPlot._origRing;
  renderCandidateList(origRing);
  updateRepairScoreTable(origRing,repairCandidates[idx]);
  // Update after-map
  if(repairAfterLayer){ repairMapAfter.removeLayer(repairAfterLayer); repairAfterLayer=null; }
  const ring = repairCandidates[idx].ring;
  const closedRing=[...ring,ring[0]];
  repairAfterLayer = L.geoJSON({type:'Feature',geometry:{type:'Polygon',coordinates:[closedRing]}},{
    style:{color:'#2E8B57',weight:2.5,fillColor:'rgba(77,184,122,0.25)',fillOpacity:1}
  }).addTo(repairMapAfter);
  try{repairMapAfter.fitBounds(repairAfterLayer.getBounds(),{padding:[10,10]});}catch(e){}
}

// ══════════════════════════════════════════════════════════════════════════
// REPAIR MINI MAPS
// ══════════════════════════════════════════════════════════════════════════
function initRepairMaps(origRing, repairedRing){
  // Destroy existing maps
  if(repairMapBefore){ repairMapBefore.remove(); repairMapBefore=null; }
  if(repairMapAfter){ repairMapAfter.remove(); repairMapAfter=null; }
  document.getElementById('repair-map-before').innerHTML='';
  document.getElementById('repair-map-after').innerHTML='';

  const tileUrl='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  const tileOpts={attribution:'© Esri',maxZoom:19};

  repairMapBefore=L.map('repair-map-before',{zoomControl:false,attributionControl:false,
    scrollWheelZoom:false,doubleClickZoom:false,dragging:false}).setView([4.436,-75.780],14);
  L.tileLayer(tileUrl,tileOpts).addTo(repairMapBefore);

  repairMapAfter=L.map('repair-map-after',{zoomControl:false,attributionControl:false,
    scrollWheelZoom:false,doubleClickZoom:false,dragging:false}).setView([4.436,-75.780],14);
  L.tileLayer(tileUrl,tileOpts).addTo(repairMapAfter);

  // Draw original (broken — red dashed)
  const closedOrig=[...origRing,origRing[0]];
  repairBeforeLayer=L.geoJSON({type:'Feature',geometry:{type:'Polygon',coordinates:[closedOrig]}},{
    style:{color:'#C84B2F',weight:2,dashArray:'5 4',fillColor:'rgba(200,75,47,0.15)',fillOpacity:1}
  }).addTo(repairMapBefore);
  try{repairMapBefore.fitBounds(repairBeforeLayer.getBounds(),{padding:[10,10]});}catch(e){}

  // Draw repaired (green solid)
  const closedRep=[...repairedRing,repairedRing[0]];
  repairAfterLayer=L.geoJSON({type:'Feature',geometry:{type:'Polygon',coordinates:[closedRep]}},{
    style:{color:'#2E8B57',weight:2.5,fillColor:'rgba(77,184,122,0.25)',fillOpacity:1}
  }).addTo(repairMapAfter);
  try{repairMapAfter.fitBounds(repairAfterLayer.getBounds(),{padding:[10,10]});}catch(e){}

  // Sync views
  setTimeout(()=>{
    repairMapBefore.invalidateSize();
    repairMapAfter.invalidateSize();
    try{repairMapBefore.fitBounds(repairBeforeLayer.getBounds(),{padding:[10,10]});}catch(e){}
    try{repairMapAfter.fitBounds(repairAfterLayer.getBounds(),{padding:[10,10]});}catch(e){}
  },120);
}

// ══════════════════════════════════════════════════════════════════════════
// ACCEPT / REJECT REPAIR
// ══════════════════════════════════════════════════════════════════════════
async function submitRepairCandidatesForLearning(pendingPlot,stage1Result){
  try{
    const result=await requestActiveLearning('/repair-submissions',{
      method:'POST',body:JSON.stringify({
        plot_name:pendingPlot.name,
        original_feature:pendingPlot.geojson,
        errors:stage1Result.errors,
        candidates:stage1Result.candidates.slice(0,repairCandidateDisplayLimit()).map((c,i)=>({
          candidate_id:c.name.toLowerCase().replace(/[^a-z0-9]+/g,'_'),rank:i+1,name:c.name,
          feature:{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[...c.ring,c.ring[0]]]}},
          scores:c.scores,description:c.desc
        }))
      })
    });
    repairFeedbackId=result.submission_id;
  }catch(error){console.warn('Repair learning submission unavailable:',error);}
}

async function logRepairDecision(decision,chosen=null,edited=false){
  if(!repairFeedbackId) return;
  try{
    await requestActiveLearning(`/repair-submissions/${repairFeedbackId}/decision`,{
      method:'POST',body:JSON.stringify({
        decision,
        selected_candidate_id:chosen?chosen.name.toLowerCase().replace(/[^a-z0-9]+/g,'_'):null,
        selected_rank:chosen?selectedCandidateIdx+1:null,
        farmer_modified:edited,
        notes:''
      })
    });
  }catch(error){console.warn('Could not store repair decision:',error);}
}

function acceptRepair(startEditing=false){
  const chosen = repairCandidates[selectedCandidateIdx];
  const p = repairPendingPlot;
  if(!chosen||!p){showToast('No hay una reparación automática disponible');return;}
  const repairedRing = chosen.ring;
  const closedRing   = [...repairedRing, repairedRing[0]];
  const sc = chosen.scores;
  p.geojson.features[0].geometry.coordinates[0] = closedRing;
  p.verts=String(repairedRing.length); p.area=sc.areaHa.toFixed(1)+' ha'; p.compact=sc.pp.toFixed(3);
  p.meta=sc.areaHa.toFixed(1)+' ha · reparado · café';
  p.note=`Opción ${selectedCandidateIdx+1} seleccionada: "${chosen.name}". V=${sc.V_rep.toFixed(2)}, APS=${sc.APS.toFixed(2)}, SCS=${sc.SCS.toFixed(2)}.`;
  p.needsRepair=false; p.validationState='recalculating'; p.tier='medium'; p.tierlabel='Revisión recomendada'; p.conf=0; p.ci='[—, —]';
  p.repairDecision={candidate:chosen.name,rank:selectedCandidateIdx+1,farmerModified:startEditing};
  const existingIndex=Number.isInteger(p._existingIndex)?p._existingIndex:-1;
  if(existingIndex>=0){PLOTS[existingIndex]=p;currentPlot=existingIndex;}else{PLOTS.push(p);currentPlot=PLOTS.length-1;}
  renderPlotList(); savePlots(); cacheSet(p.geojson,'repair',{method:chosen.name,rank:selectedCandidateIdx+1,scores:sc,geometry:p.geojson});
  logRepairDecision(startEditing?'edited_candidate':(selectedCandidateIdx===0?'accepted_recommended':'accepted_alternative'),chosen,startEditing);
  logStudyEvent('repair_decision',{decision:startEditing?'edited_candidate':(selectedCandidateIdx===0?'accepted_recommended':'accepted_alternative'),candidate:chosen.name,rank:selectedCandidateIdx+1,farmer_modified:startEditing,score:sc.score},p.name,`repair:${p.name}`,endStudyTask(`repair:${p.name}`));
  const targetIndex=currentPlot;
  closeRepairModal(); showToast(`✓ Opción ${selectedCandidateIdx+1}: ${chosen.name}`);
  setTimeout(async()=>{
    goToVerify(targetIndex);
    if(startEditing&&!editMode){setTimeout(toggleEditMode,180);return;}
    setStage2PendingState('Recalculando indicadores para la geometría reparada…');
    await runStage2Scoring(targetIndex,{forceRefresh:true,source:'repair'});
  },300);
}

function rejectRepair(){
  logStudyEvent('repair_rejected_all',{candidate_count:repairCandidates.length},repairPendingPlot?.name,`repair:${repairPendingPlot?.name}`,endStudyTask(`repair:${repairPendingPlot?.name}`));
  logRepairDecision('rejected_all',null,false);
  showToast(`✕ Ninguna opción elegida — redibuja "${repairPendingPlot.name}"`);
  closeRepairModal();
}

function closeRepairModal(){
  document.getElementById('repair-overlay').classList.remove('active');
  if(repairMapBefore){repairMapBefore.remove();repairMapBefore=null;}
  if(repairMapAfter){repairMapAfter.remove();repairMapAfter=null;}
  repairPendingPlot=null; repairCandidates=[]; repairFeedbackId=null;
}

// ══════════════════════════════════════════════════════════════════════════
// PLOT LIST & COMPLIANCE
// ══════════════════════════════════════════════════════════════════════════
function renderPlotList(){
  const list=document.getElementById('plot-list');
  const icons={high:'🌱',medium:'⚠️',low:'❌'};
  const labels={high:'Alta',medium:'Revisar',low:'Problema'};
  list.innerHTML=PLOTS.map((p,i)=>`
    <div class="plot-card ${p.tier}" onclick="goToVerify(${i})">
      <div class="plot-avatar ${p.tier}">${icons[p.tier]}</div>
      <div class="plot-info">
        <div class="plot-name">${p.name}</div>
        <div class="plot-meta">${p.meta} · C = ${p.conf.toFixed(2)}</div>
      </div>
      <span class="badge ${p.tier}">${labels[p.tier]}</span>
    </div>`).join('');
  const total=PLOTS.length, valid=PLOTS.filter(p=>p.tier==='high').length;
  document.getElementById('stat-total').textContent=total;
  document.getElementById('stat-valid').textContent=valid;
  document.getElementById('stat-pending').textContent=total-valid;
  renderComplianceList();
}
function renderComplianceList(){
  const cls=document.getElementById('compliance-list');
  const valid=PLOTS.filter(p=>p.tier==='high').length;
  document.getElementById('eudr-count').textContent=valid+' / '+PLOTS.length;
  const iconMap={high:'✅',medium:'⏳',low:'⚠️'};
  const clsMap={high:'ci-green',medium:'ci-amber',low:'ci-red'};
  const detMap={high:'Sin deforestación · WHISP conforme',medium:'Validación pendiente · revisar límite',low:'Límite con problema · re-dibujar'};
  const riskMap={};
  PLOTS.forEach(p=>{ if(p.whispData){ const r=p.whispData.risk_acrop||p.whispData.risk_pcrop; riskMap[p.name]=r==='low'?'Sin deforestación · WHISP conforme':r==='medium'?'WHISP: riesgo medio':r==='high'?'WHISP: riesgo alto':'WHISP analizado'; } });
  cls.innerHTML=PLOTS.map(p=>`
    <div class="compliance-item">
      <div class="compliance-icon ${clsMap[p.tier]}">${iconMap[p.tier]}</div>
      <div><div class="compliance-name">${p.name}</div><div class="compliance-detail">${riskMap[p.name]||detMap[p.tier]}</div></div>
      <div class="compliance-arrow">›</div>
    </div>`).join('');
}

// ══════════════════════════════════════════════════════════════════════════
// LOAD PLOT INTO VERIFY SCREEN
// ══════════════════════════════════════════════════════════════════════════
function loadPlot(idx){
  const p=PLOTS[idx];
  const TCOLOR={high:'var(--leaf)',medium:'var(--amber)',low:'var(--alert)'};
  const c=TCOLOR[p.tier];
  document.getElementById('verify-name').textContent=p.name;
  document.getElementById('verify-meta').textContent=p.meta;
  document.getElementById('sc-name').textContent=p.name;
  document.getElementById('map-tier-label').textContent=p.tierlabel;
  document.getElementById('map-dot').style.background=c;
  document.getElementById('conf-fill').style.width=(p.conf*100)+'%';
  document.getElementById('conf-fill').style.background=c;
  document.getElementById('conf-val').textContent=p.conf.toFixed(2);
  document.getElementById('conf-ci').textContent=p.ci;
  document.getElementById('verdict-note').textContent=p.note;
  document.getElementById('geo-area').textContent=p.area;
  document.getElementById('geo-compact').textContent=p.compact;
  document.getElementById('geo-verts').textContent=p.verts;
  document.getElementById('geo-topology').textContent=p.needsRepair?'⚠️ Inválida':'Válida ✓';
  document.getElementById('geo-topology').style.color=p.needsRepair?'var(--alert)':'var(--leaf)';
  const badge=document.getElementById('sc-badge');
  badge.className='badge '+p.tier;
  badge.textContent=p.tier==='high'?'Alta':p.tier==='medium'?'Revisar':'Problema';
  ['a2','a4'].forEach(k=>{
    const v=p[k];
    const bc=v>=0.70?'var(--leaf)':v>=0.45?'var(--amber)':'var(--alert)';
    document.getElementById(k+'-bar').style.width=(v*100)+'%';
    document.getElementById(k+'-bar').style.background=bc;
    document.getElementById(k+'-val').textContent=v.toFixed(2);
    document.getElementById(k+'-val').style.color='var(--ink)';
  });
  if(p.a3!==null){
    const bc=p.a3>=0.70?'var(--leaf)':p.a3>=0.45?'var(--amber)':'var(--alert)';
    document.getElementById('a3-bar').style.width=(p.a3*100)+'%';
    document.getElementById('a3-bar').style.background=bc;
    document.getElementById('a3-val').textContent=p.a3.toFixed(2);
    document.getElementById('a3-val').style.color='var(--ink)';
  } else {
    document.getElementById('a3-bar').style.width='30%';
    document.getElementById('a3-bar').style.background='#ccc';
    document.getElementById('a3-val').textContent='N/D';
    document.getElementById('a3-val').style.color='var(--stone)';
  }
  if(editMode) toggleEditMode();
  renderPlotOnMap(idx);
  // Plain language card
  updatePlainLanguageCard(p);
  // Compute live layer scores from geometry (async — updates UI progressively)
  if(p.geojson) runStage2Scoring(idx);
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN LEAFLET MAP
// ══════════════════════════════════════════════════════════════════════════
function initMap(){
  leafletMap=L.map('leaflet-map',{zoomControl:false,attributionControl:true,
    scrollWheelZoom:false,doubleClickZoom:false}).setView([4.436,-75.780],15);
  const tileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {attribution:'Tiles © Esri',maxZoom:19,errorTileUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='}).addTo(leafletMap);
  tileLayer.on('tileerror', ()=>{
    if(!navigator.onLine) document.getElementById('map-hint').textContent='📵 Mapa sin conexión — imagen no disponible';
  });
  renderPlotOnMap(0);
}
function renderPlotOnMap(idx){
  const p=PLOTS[idx];
  if(plotLayer){leafletMap.removeLayer(plotLayer);plotLayer=null;}
  clearVertexMarkers();
  if(p.geojson){
    const TS={high:'#4DB87A',medium:'#E8832A',low:'#C84B2F'};
    const TF={high:'rgba(77,184,122,0.18)',medium:'rgba(232,131,42,0.18)',low:'rgba(200,75,47,0.18)'};
    const invalid=Boolean(p.needsRepair||p.validationState==='invalid_topology');
    plotLayer=L.geoJSON(p.geojson,{
      style:{color:invalid?'#C84B2F':TS[p.tier],weight:invalid?3:2.5,dashArray:invalid?'4 4':'6 4',fillColor:invalid?'rgba(200,75,47,0.18)':TF[p.tier],fillOpacity:1}
    }).addTo(leafletMap);
    fitPlotOnMap();
    const ring=p.geojson.features[0].geometry.coordinates[0];
    editedCoords=ring.slice(0,-1).map(c=>[...c]);
    document.getElementById('map-hint').textContent='Imagen satelital · Esri World Imagery';
  } else {
    leafletMap.setView([4.436,-75.780],13);
    document.getElementById('map-hint').textContent='Sin geometría — cargue un GeoJSON';
    editedCoords=[];
  }
}
function fitPlotOnMap(){
  if(plotLayer) try{leafletMap.fitBounds(plotLayer.getBounds(),{padding:[20,20]});}catch(e){}
}

// ══════════════════════════════════════════════════════════════════════════
// VERTEX EDITING
// ══════════════════════════════════════════════════════════════════════════
function setEditUi(active){
  const primaryButton=document.getElementById('edit-toggle-btn');
  const secondaryButtons=document.querySelectorAll('[data-edit-vertices], .btn-secondary[onclick*="toggleEditMode"]');
  const infoBar=document.getElementById('edit-info-bar');
  const mapHint=document.getElementById('map-hint');

  if(primaryButton){
    primaryButton.classList.toggle('active',active);
    primaryButton.textContent=active?'✅ Guardar edición':'✏️ Editar vértices';
    primaryButton.setAttribute('aria-pressed',String(active));
  }
  secondaryButtons.forEach(button=>{
    button.classList.toggle('active',active);
    button.textContent=active?'✅ Guardar edición':'✏️ Ajustar vértices';
    button.setAttribute('aria-pressed',String(active));
  });
  if(infoBar) infoBar.classList.toggle('hidden',!active);
  if(mapHint) mapHint.textContent=active?'Arrastra un vértice para ajustar':'Imagen satelital · Esri World Imagery';
}

function getEditablePlot(){
  const plot=PLOTS?.[currentPlot];
  if(!plot){showToast('⚠️ No hay una parcela seleccionada');return null;}
  if(!plot.geojson?.features?.length){showToast('⚠️ Esta parcela no tiene geometría editable');return null;}
  const geometry=plot.geojson.features[0]?.geometry;
  if(!geometry||geometry.type!=='Polygon'||!Array.isArray(geometry.coordinates?.[0])){
    showToast('⚠️ Solo se pueden editar polígonos simples');
    return null;
  }
  return plot;
}

function refreshEditedCoordinatesFromPlot(plot){
  const ring=plot?.geojson?.features?.[0]?.geometry?.coordinates?.[0];
  if(!Array.isArray(ring)||ring.length<4) return false;
  editedCoords=ring.slice(0,-1).map(coord=>[Number(coord[0]),Number(coord[1])]);
  return editedCoords.every(coord=>Number.isFinite(coord[0])&&Number.isFinite(coord[1]));
}

async function toggleEditMode(){
  const plot=getEditablePlot();
  if(!plot) return;
  if(!leafletMap){showToast('⏳ El mapa todavía se está cargando');return;}

  if(!editMode){
    if(!refreshEditedCoordinatesFromPlot(plot)){
      showToast('⚠️ No se pudieron leer los vértices de la parcela');
      return;
    }
    editMode=true;
    setEditUi(true);
    drawVertexMarkers();
    if(vertexMarkers.length===0){
      editMode=false;
      setEditUi(false);
      showToast('⚠️ No se pudieron crear los controles de edición');
      return;
    }
    showToast(`✏️ ${vertexMarkers.length} vértices listos para editar`);
    logStudyEvent('vertex_edit_started',{vertex_count:vertexMarkers.length},plot.name,`plot:${currentPlot}`,studyElapsed(`plot:${currentPlot}`));
    return;
  }

  editMode=false;
  setEditUi(false);
  clearVertexMarkers();
  await commitEditedCoords();
}

function drawVertexMarkers(){
  const plot=getEditablePlot();
  if(!leafletMap||!plot||editedCoords.length===0) return;
  clearVertexMarkers();
  const TS={high:'#4DB87A',medium:'#E8832A',low:'#C84B2F'};
  const markerColor=TS[plot.tier]||'#4DB87A';

  editedCoords.forEach((coord,index)=>{
    const icon=L.divIcon({
      className:'geocitizens-vertex-icon',
      html:`<div class="vertex-marker" style="border-color:${markerColor}"></div>`,
      iconSize:[18,18],
      iconAnchor:[9,9]
    });
    const marker=L.marker([coord[1],coord[0]],{
      icon,
      draggable:true,
      keyboard:true,
      autoPan:true,
      zIndexOffset:2000,
      title:`Vértice ${index+1}`
    });
    marker.on('drag',event=>{
      const latLng=event.target.getLatLng();
      editedCoords[index]=[latLng.lng,latLng.lat];
      redrawEditPolygon();
    });
    marker.on('dragend',()=>{
      redrawEditPolygon();
      resetMapViewAfterEdit();
    });
    marker.addTo(leafletMap);
    vertexMarkers.push(marker);
  });
}

function resetMapViewAfterEdit(){
  if(leafletMap) requestAnimationFrame(()=>leafletMap.invalidateSize({pan:false}));
}

function clearVertexMarkers(){
  if(!leafletMap){vertexMarkers=[];return;}
  vertexMarkers.forEach(marker=>{
    try{leafletMap.removeLayer(marker);}catch(_error){}
  });
  vertexMarkers=[];
}

function redrawEditPolygon(){
  if(!leafletMap||editedCoords.length<3) return;
  if(plotLayer){leafletMap.removeLayer(plotLayer);plotLayer=null;}
  const plot=PLOTS[currentPlot];
  const TS={high:'#4DB87A',medium:'#E8832A',low:'#C84B2F'};
  const TF={high:'rgba(77,184,122,0.18)',medium:'rgba(232,131,42,0.18)',low:'rgba(200,75,47,0.18)'};
  const ring=[...editedCoords.map(coord=>[...coord]),[...editedCoords[0]]];
  plotLayer=L.geoJSON({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[ring]}}]}, {
    style:{color:TS[plot?.tier]||'#4DB87A',weight:2.5,dashArray:'6 4',fillColor:TF[plot?.tier]||'rgba(77,184,122,0.18)',fillOpacity:1}
  }).addTo(leafletMap);
}

async function commitEditedCoords(){
  const plot=getEditablePlot();
  if(!plot||editedCoords.length<3) return;

  const editedRing=editedCoords.map(coord=>[...coord]);
  const closedRing=[...editedRing,[...editedRing[0]]];
  plot.geojson.features[0].geometry.coordinates[0]=closedRing;
  plot.verts=String(editedRing.length);

  const area=polygonAreaHa(editedRing);
  const compact=polsbyPopper(editedRing);
  plot.area=area.toFixed(1)+' ha';
  plot.compact=compact.toFixed(3);
  plot.meta=area.toFixed(1)+' ha · edición · café';

  const areaEl=document.getElementById('geo-area');
  const compactEl=document.getElementById('geo-compact');
  const vertsEl=document.getElementById('geo-verts');
  const metaEl=document.getElementById('verify-meta');
  if(areaEl) areaEl.textContent=plot.area;
  if(compactEl) compactEl.textContent=plot.compact;
  if(vertsEl) vertsEl.textContent=plot.verts;
  if(metaEl) metaEl.textContent=plot.meta;

  setStage2PendingState('Comprobando primero que el nuevo límite no tenga errores geométricos…');
  const stage1=runStage1(editedRing);

  logStudyEvent('vertex_edit_committed',{
    vertex_count:editedRing.length,
    area_ha:area,
    compactness:compact,
    topology_valid:stage1.errors.length===0,
    topology_errors:stage1.errors.map(error=>error.type)
  },plot.name,`plot:${currentPlot}`,studyElapsed(`plot:${currentPlot}`));

  if(stage1.errors.length>0){
    setInvalidTopologyState(plot,stage1);
    renderPlotOnMap(currentPlot);
    savePlots();
    showToast('⚠️ La edición creó un error geométrico');
    plot._origRing=stage1.origRing;
    plot._existingIndex=currentPlot;
    setTimeout(()=>openRepairModal(plot,stage1),120);
    return;
  }

  plot.needsRepair=false;
  plot.validationState='recalculating';
  const topology=document.getElementById('geo-topology');
  if(topology){topology.textContent='Válida ✓';topology.style.color='var(--leaf)';}
  renderPlotOnMap(currentPlot);
  await cacheSet(plot.geojson,'geometry',{area:plot.area,verts:plot.verts,compact:plot.compact});

  try{
    await runStage2Scoring(currentPlot,{forceRefresh:true,source:'vertex_edit'});
    showToast('✓ Edición validada · indicadores actualizados');
  }catch(error){
    console.error('Could not recalculate edited geometry:',error);
    plot.validationState='recalculating';
    updatePlainLanguageCard(plot);
    showToast('⚠️ No se pudieron recalcular todos los indicadores');
  }
  savePlots();
}

function bindVertexEditingControls(){
  const controls=[
    document.getElementById('edit-toggle-btn'),
    ...document.querySelectorAll('[data-edit-vertices]')
  ].filter(Boolean);
  controls.forEach(control=>{
    if(control.dataset.editBound==='1') return;
    control.dataset.editBound='1';
    control.removeAttribute('onclick');
    control.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      toggleEditMode().catch(error=>{
        console.error('Vertex editing failed:',error);
        editMode=false;
        setEditUi(false);
        clearVertexMarkers();
        showToast('⚠️ No fue posible iniciar la edición');
      });
    });
  });
}

window.toggleEditMode=toggleEditMode;
window.addEventListener('DOMContentLoaded',bindVertexEditingControls);

// ══════════════════════════════════════════════════════════════════════════
// CLEAR ALL
// ══════════════════════════════════════════════════════════════════════════
function confirmClearAll(){
  if(PLOTS.length===0){showToast('No hay parcelas que eliminar');return;}
  if(window._clearPending){
    PLOTS=[];renderPlotList();
    if(plotLayer){leafletMap.removeLayer(plotLayer);plotLayer=null;}
    clearVertexMarkers();
    localStorage.removeItem(STORAGE_KEY);
    savePlots();
    showToast('🗑️ Todas las parcelas eliminadas');
    window._clearPending=false;
  } else {
    window._clearPending=true;
    showToast('Toca de nuevo para confirmar eliminación');
    setTimeout(()=>{window._clearPending=false;},3000);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// VERIFY SCREEN ACTIONS
// ══════════════════════════════════════════════════════════════════════════
function handleAccept(){
  const p=PLOTS[currentPlot];
  if(!p||p.needsRepair||p.validationState==='invalid_topology'||p.validationState==='recalculating'){
    showToast(p?.needsRepair?'⚠️ Repara el límite antes de confirmar':'⏳ Espera a que termine la validación');
    return;
  }
  logStudyEvent('validation_decision',{decision:'accepted',confidence:p.conf,a2:p.a2,a3:p.a3,a4:p.a4},p.name,`plot:${currentPlot}`,endStudyTask(`plot:${currentPlot}`));
  p.tier='high';p.tierlabel='Confianza alta';
  renderPlotList();
  savePlots();
  showToast('✓ '+p.name+' — enviando a WHISP…');
  if(p.geojson) sendToWhisp(p);
}
function handleReject(){const p=PLOTS[currentPlot];logStudyEvent('validation_decision',{decision:'rejected',confidence:p?.conf,a2:p?.a2,a3:p?.a3,a4:p?.a4},p?.name,`plot:${currentPlot}`,endStudyTask(`plot:${currentPlot}`));showToast('✕ '+PLOTS[currentPlot].name+' rechazada — re-dibujar requerido');}

function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2800);
}
