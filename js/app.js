// GeoCitizens application state, navigation, imports, persistence, reports, and startup.
// ══════════════════════════════════════════════════════════════════════════
// DEFAULT GEOMETRY
// ══════════════════════════════════════════════════════════════════════════
const DEFAULT_GEOJSON = {
  type:"FeatureCollection", name:"coffee_ex",
  features:[{
    type:"Feature",
    properties:{ogc_fid:854, name:"Cultivo Permanente Cafe", farm_id:"3270aa41"},
    geometry:{
      type:"Polygon",
      coordinates:[[
        [-75.779937185,4.438409225],[-75.777846085,4.43862978],
        [-75.777556689,4.438293757],[-75.777446864,4.438034095],
        [-75.777969389,4.437675958],[-75.778337731,4.437462725],
        [-75.780128585,4.43635844],[-75.780337819,4.435515208],
        [-75.781858965,4.434513562],[-75.783049195,4.434179368],
        [-75.782423583,4.438218175],[-75.781216042,4.438226743],
        [-75.780616977,4.438358796],[-75.779937185,4.438409225]
      ]]
    }
  }]
};

// ══════════════════════════════════════════════════════════════════════════
// PLOTS STORE
// ══════════════════════════════════════════════════════════════════════════
let PLOTS = [
  { name:'Cultivo Permanente Cafe', meta:'~12 ha · Armenia · café',
    conf:0.78, tier:'high', tierlabel:'Confianza alta',
    a2:0.74, a3:null, a4:0.82,
    area:'~12 ha', compact:'0.521', verts:'14',
    note:'Parcela real de café. Buena alineación con transiciones de cobertura MapBiomas. Sin registro catastral disponible.',
    ci:'[0.67, 0.86]', geojson:DEFAULT_GEOJSON, needsRepair:false },
  { name:'Lote central', meta:'8.4 ha · Calarcá · café',
    conf:0.54, tier:'medium', tierlabel:'Revisión recomendada',
    a2:0.41, a3:null, a4:0.71,
    area:'8.4 ha', compact:'0.412', verts:'9',
    note:'A2 indica alineación débil. Revisar con imagen satelital.',
    ci:'[0.43, 0.65]', geojson:null, needsRepair:false },
  { name:'Finca el roble', meta:'22.7 ha · Montenegro · café',
    conf:0.83, tier:'high', tierlabel:'Confianza alta',
    a2:0.78, a3:0.79, a4:0.88,
    area:'22.7 ha', compact:'0.621', verts:'18',
    note:'Alineación sólida en todas las fuentes. IoU catastral 0.79.',
    ci:'[0.74, 0.90]', geojson:null, needsRepair:false },
  { name:'Terreno sur', meta:'5.2 ha · Armenia · café',
    conf:0.31, tier:'low', tierlabel:'Problema detectado',
    a2:0.28, a3:null, a4:0.38,
    area:'5.2 ha', compact:'0.089', verts:'6',
    note:'Compacidad muy baja y alineación débil. Se requiere re-dibujar.',
    ci:'[0.21, 0.43]', geojson:null, needsRepair:false }
];

let currentPlot = 0;
let leafletMap = null, plotLayer = null;
let vertexMarkers = [], editMode = false, editedCoords = [];

// Repair state
let repairMapBefore = null, repairMapAfter = null;
let repairBeforeLayer = null, repairAfterLayer = null;
let repairPendingPlot = null; // the raw parsed plot waiting for user decision
let selectedCandidateIdx = 0;
let repairCandidates = [];
let repairFeedbackId = null;

// ══════════════════════════════════════════════════════════════════════════
// CLOCK
// ══════════════════════════════════════════════════════════════════════════
function updateClock(){
  const n=new Date();
  document.getElementById('clock').textContent=
    n.getHours().toString().padStart(2,'0')+':'+n.getMinutes().toString().padStart(2,'0');
}
updateClock(); setInterval(updateClock,30000);

// ══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════════════════
function switchTab(tab){
  logStudyEvent('tab_opened',{tab});
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const m={plots:'s-plots',verify:'s-verify',eudr:'s-eudr',activity:'s-activity',whisp:'s-whisp'};
  document.getElementById(m[tab]).classList.add('active');
  document.getElementById('nav-'+tab).classList.add('active');
  if(tab==='activity') loadFarmerQueue();
  if(tab==='verify') setTimeout(()=>{if(leafletMap){leafletMap.invalidateSize();fitPlotOnMap();}},50);
}
function goToVerify(idx){currentPlot=idx;const p=PLOTS[idx];startStudyTask(`plot:${idx}`);logStudyEvent('plot_opened',{plot_index:idx,confidence:p?.conf,tier:p?.tier},p?.name,`plot:${idx}`);loadPlot(idx);switchTab('verify');}
function goBack(){switchTab('plots');}

// ══════════════════════════════════════════════════════════════════════════
// FILE UPLOAD  →  runs Stage 1
// ══════════════════════════════════════════════════════════════════════════
const FORMAT_IMPORTS = {
  shpjs: null,
  flatgeobuf: null,
  sqljs: null,
  proj4: null
};

async function loadFormatLibrary(key){
  if(FORMAT_IMPORTS[key]) return FORMAT_IMPORTS[key];
  const urls={
    shpjs:'https://cdn.jsdelivr.net/npm/shpjs@6.2.0/+esm',
    flatgeobuf:'https://cdn.jsdelivr.net/npm/flatgeobuf@4.4.0/lib/mjs/geojson.js',
    sqljs:'https://cdn.jsdelivr.net/npm/sql.js@1.13.0/+esm',
    proj4:'https://cdn.jsdelivr.net/npm/proj4@2.19.10/+esm'
  };
  FORMAT_IMPORTS[key]=import(urls[key]);
  return FORMAT_IMPORTS[key];
}

function extensionOf(name){
  const match=String(name||'').toLowerCase().match(/\.([^.]+)$/);
  return match?match[1]:'';
}

function featureCollectionFrom(value){
  if(!value) return {type:'FeatureCollection',features:[]};
  if(Array.isArray(value)){
    return {type:'FeatureCollection',features:value.flatMap(v=>featureCollectionFrom(v).features)};
  }
  if(value.type==='FeatureCollection') return value;
  if(value.type==='Feature') return {type:'FeatureCollection',features:[value]};
  if(value.type && value.coordinates){
    return {type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:value}]};
  }
  return {type:'FeatureCollection',features:[]};
}

function polygonFeaturesOnly(collection){
  const fc=featureCollectionFrom(collection);
  return {
    type:'FeatureCollection',
    features:fc.features.filter(f=>f?.geometry && ['Polygon','MultiPolygon'].includes(f.geometry.type))
  };
}

function parseDelimitedLine(line, delimiter){
  const values=[];
  let value='', quoted=false;
  for(let i=0;i<line.length;i++){
    const char=line[i];
    if(char==='"'){
      if(quoted && line[i+1]==='"'){value+='"';i++;}
      else quoted=!quoted;
    } else if(char===delimiter && !quoted){values.push(value);value='';}
    else value+=char;
  }
  values.push(value);
  return values.map(v=>v.trim());
}

function detectDelimiter(header){
  const candidates=[',',';','\t','|'];
  return candidates.sort((a,b)=>header.split(b).length-header.split(a).length)[0];
}

function parseWktGeometry(wkt){
  const text=String(wkt||'').trim();
  const match=text.match(/^\s*(POLYGON|MULTIPOLYGON)\s*(?:Z|M|ZM)?\s*\((.*)\)\s*$/i);
  if(!match) return null;
  const type=match[1].toUpperCase();
  const body=match[2];
  const parseRing=ring=>ring.split(',').map(pair=>pair.trim().split(/\s+/).slice(0,2).map(Number)).filter(c=>c.length===2&&c.every(Number.isFinite));
  const groups=[];
  let depth=0,start=-1;
  for(let i=0;i<body.length;i++){
    if(body[i]==='('){if(depth===0) start=i+1;depth++;}
    else if(body[i]===')'){depth--;if(depth===0&&start>=0){groups.push(body.slice(start,i));start=-1;}}
  }
  if(type==='POLYGON'){
    const rings=(groups.length?groups:[body]).map(g=>parseRing(g.replace(/^\(+|\)+$/g,''))).filter(r=>r.length>=3);
    return rings.length?{type:'Polygon',coordinates:rings}:null;
  }
  const polygons=[];
  for(const group of groups){
    const rings=[];let d=0,s=-1;
    for(let i=0;i<group.length;i++){
      if(group[i]==='('){if(d===0)s=i+1;d++;}
      else if(group[i]===')'){d--;if(d===0&&s>=0){rings.push(parseRing(group.slice(s,i)));s=-1;}}
    }
    if(rings.length) polygons.push(rings);
  }
  return polygons.length?{type:'MultiPolygon',coordinates:polygons}:null;
}

function csvToGeoJSON(text, filename){
  const lines=String(text).replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim());
  if(lines.length<2) throw new Error('El CSV no contiene filas de datos');
  const delimiter=detectDelimiter(lines[0]);
  const headers=parseDelimitedLine(lines[0],delimiter);
  const normalized=headers.map(h=>h.toLowerCase().trim().replace(/[\s-]+/g,'_'));
  const indexOf=(names)=>{for(const n of names){const i=normalized.indexOf(n);if(i>=0)return i;}return -1;};
  const geometryIdx=indexOf(['geometry','geom','wkt','geojson','the_geom']);
  const lonIdx=indexOf(['longitude','lon','lng','x']);
  const latIdx=indexOf(['latitude','lat','y']);
  const idIdx=indexOf(['name','nombre','plot_name','parcel_name','id']);
  const features=[];
  for(let rowIndex=1;rowIndex<lines.length;rowIndex++){
    const values=parseDelimitedLine(lines[rowIndex],delimiter);
    if(values.every(v=>!v)) continue;
    const properties={};
    headers.forEach((h,i)=>{if(i!==geometryIdx) properties[h]=values[i]??'';});
    let geometry=null;
    if(geometryIdx>=0 && values[geometryIdx]){
      const raw=values[geometryIdx].trim();
      if(raw.startsWith('{')){
        const parsed=JSON.parse(raw);
        geometry=parsed.type==='Feature'?parsed.geometry:parsed;
      } else geometry=parseWktGeometry(raw);
    } else if(lonIdx>=0&&latIdx>=0){
      const lon=Number(values[lonIdx]),lat=Number(values[latIdx]);
      if(Number.isFinite(lon)&&Number.isFinite(lat)) geometry={type:'Point',coordinates:[lon,lat]};
    }
    if(geometry) features.push({type:'Feature',properties:{...properties,name:properties.name||properties.nombre||values[idIdx]||`${filename} ${rowIndex}`},geometry});
  }
  if(!features.length) throw new Error('No se encontró geometría. Usa WKT/GeoJSON o columnas longitude/latitude. La app requiere polígonos para validación.');
  return {type:'FeatureCollection',features};
}

async function shapefileToGeoJSON(files){
  const mod=await loadFormatLibrary('shpjs');
  const shp=mod.default||mod;
  const zip=files.find(f=>extensionOf(f.name)==='zip');
  if(zip){
    const result=await shp(await zip.arrayBuffer());
    return featureCollectionFrom(result);
  }
  const shpFile=files.find(f=>extensionOf(f.name)==='shp');
  if(!shpFile) throw new Error('Selecciona un .zip o al menos el archivo .shp');
  const dbfFile=files.find(f=>extensionOf(f.name)==='dbf');
  const prjFile=files.find(f=>extensionOf(f.name)==='prj');
  const cpgFile=files.find(f=>extensionOf(f.name)==='cpg');
  const parseShp=mod.parseShp||shp.parseShp;
  const parseDbf=mod.parseDbf||shp.parseDbf;
  const combine=mod.combine||shp.combine;
  if(!parseShp||!combine) throw new Error('La biblioteca Shapefile no expone el lector esperado');
  const geometry=parseShp(await shpFile.arrayBuffer(),prjFile?await prjFile.text():undefined);
  const attributes=dbfFile&&parseDbf?parseDbf(await dbfFile.arrayBuffer(),cpgFile?await cpgFile.text():'utf-8'):geometry.map(()=>({}));
  return featureCollectionFrom(combine([geometry,attributes]));
}

async function flatGeobufToGeoJSON(file){
  const mod=await loadFormatLibrary('flatgeobuf');
  const bytes=new Uint8Array(await file.arrayBuffer());
  const features=[];
  try{
    for await(const feature of mod.deserialize(bytes)) features.push(feature);
  }catch(firstError){
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
    try{for await(const feature of mod.deserialize(url)) features.push(feature);}
    finally{URL.revokeObjectURL(url);}
  }
  return {type:'FeatureCollection',features};
}

function readUint32(view,offset,little){return view.getUint32(offset,little);}
function readDouble(view,offset,little){return view.getFloat64(offset,little);}

function parseWkbGeometry(view,offset=0){
  const little=view.getUint8(offset)===1;offset+=1;
  let type=readUint32(view,offset,little);offset+=4;
  const hasZ=(type&0x80000000)!==0 || (type>=1000&&type<2000) || (type>=3000);
  const hasM=(type&0x40000000)!==0 || (type>=2000&&type<3000) || (type>=3000);
  type=type&0x0fffffff;if(type>=3000)type-=3000;else if(type>=2000)type-=2000;else if(type>=1000)type-=1000;
  const stride=2+(hasZ?1:0)+(hasM?1:0);
  const readCoord=()=>{const c=[];for(let i=0;i<stride;i++){c.push(readDouble(view,offset,little));offset+=8;}return c.slice(0,2);};
  if(type===1){const coordinates=readCoord();return [{type:'Point',coordinates},offset];}
  if(type===2){const n=readUint32(view,offset,little);offset+=4;const coordinates=[];for(let i=0;i<n;i++)coordinates.push(readCoord());return [{type:'LineString',coordinates},offset];}
  if(type===3){
    // A WKB Polygon does not contain nested LineString WKB objects. After the
    // ring count, every ring is encoded as: pointCount + raw coordinates.
    // Recursing here interpreted the first byte of pointCount as an endian
    // marker, producing errors such as "Tipo WKB no compatible: 152".
    const ringCount=readUint32(view,offset,little);offset+=4;
    const coordinates=[];
    for(let r=0;r<ringCount;r++){
      const pointCount=readUint32(view,offset,little);offset+=4;
      const ring=[];
      for(let i=0;i<pointCount;i++) ring.push(readCoord());
      coordinates.push(ring);
    }
    return [{type:'Polygon',coordinates},offset];
  }
  if([4,5,6,7].includes(type)){
    const count=readUint32(view,offset,little);offset+=4;const geometries=[];for(let i=0;i<count;i++){const parsed=parseWkbGeometry(view,offset);geometries.push(parsed[0]);offset=parsed[1];}
    if(type===6) return [{type:'MultiPolygon',coordinates:geometries.map(g=>g.coordinates)},offset];
    if(type===4) return [{type:'MultiPoint',coordinates:geometries.map(g=>g.coordinates)},offset];
    if(type===5) return [{type:'MultiLineString',coordinates:geometries.map(g=>g.coordinates)},offset];
    return [{type:'GeometryCollection',geometries},offset];
  }
  throw new Error(`Tipo WKB no compatible: ${type}`);
}

function parseGeoPackageGeometry(blob){
  const bytes=blob instanceof Uint8Array?blob:new Uint8Array(blob);
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint8(0)!==0x47||view.getUint8(1)!==0x50) throw new Error('Cabecera GeoPackage inválida');
  const flags=view.getUint8(3);const little=(flags&1)===1;const envelope=(flags>>1)&7;
  const envelopeBytes=[0,32,48,48,64][envelope]||0;
  const srsId=view.getInt32(4,little);
  const parsed=parseWkbGeometry(view,8+envelopeBytes);
  return {geometry:parsed[0],srsId};
}

function transformCoordinates(coords,project){
  if(typeof coords[0]==='number') return project(coords);
  return coords.map(c=>transformCoordinates(c,project));
}

async function geoPackageToGeoJSON(file){
  const sqlModule=await loadFormatLibrary('sqljs');
  const initSqlJs=sqlModule.default||sqlModule.initSqlJs;
  const SQL=await initSqlJs({locateFile:name=>`https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/${name}`});
  const db=new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  try{
    const contents=db.exec("SELECT table_name, data_type, srs_id FROM gpkg_contents WHERE data_type='features'");
    if(!contents.length||!contents[0].values.length) throw new Error('El GeoPackage no contiene capas vectoriales');
    const projModule=await loadFormatLibrary('proj4');
    const proj4=projModule.default||projModule;
    const features=[];
    for(const [tableName,,tableSrs] of contents[0].values){
      const geomInfo=db.exec(`SELECT column_name, srs_id FROM gpkg_geometry_columns WHERE table_name='${String(tableName).replaceAll("'","''")}' LIMIT 1`);
      if(!geomInfo.length) continue;
      const [geomColumn,geomSrs]=geomInfo[0].values[0];
      const escapedTable='"'+String(tableName).replaceAll('"','""')+'"';
      const rows=db.exec(`SELECT * FROM ${escapedTable}`);
      if(!rows.length) continue;
      const columns=rows[0].columns;const geomIndex=columns.indexOf(geomColumn);
      let sourceDef=null;const srsId=geomSrs??tableSrs;
      if(Number(srsId)!==4326){
        const srs=db.exec(`SELECT definition, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id=${Number(srsId)}`);
        if(srs.length&&srs[0].values.length){const [definition,org,code]=srs[0].values[0];sourceDef=definition&&definition!=='undefined'?definition:`${org}:${code}`;}
      }
      for(const row of rows[0].values){
        if(!row[geomIndex]) continue;
        const parsed=parseGeoPackageGeometry(row[geomIndex]);
        let geometry=parsed.geometry;
        if(sourceDef){
          try{geometry={...geometry,coordinates:transformCoordinates(geometry.coordinates,c=>proj4(sourceDef,'EPSG:4326',c))};}
          catch(error){console.warn('No se pudo reproyectar la geometría GeoPackage:',error);}
        }
        const properties={};columns.forEach((column,i)=>{if(i!==geomIndex)properties[column]=row[i];});
        properties._source_layer=tableName;
        features.push({type:'Feature',properties,geometry});
      }
    }
    return {type:'FeatureCollection',features};
  }finally{db.close();}
}

async function filesToGeoJSON(files){
  const first=files[0];
  const ext=extensionOf(first.name);
  if(['geojson','json'].includes(ext)) return featureCollectionFrom(JSON.parse(await first.text()));
  if(ext==='zip'||files.some(f=>extensionOf(f.name)==='shp')) return shapefileToGeoJSON(files);
  if(ext==='gpkg') return geoPackageToGeoJSON(first);
  if(ext==='fgb') return flatGeobufToGeoJSON(first);
  if(ext==='csv') return csvToGeoJSON(await first.text(),first.name.replace(/\.csv$/i,''));
  throw new Error(`Formato .${ext||'desconocido'} no compatible`);
}

function queueImportedFeature(feat,fileName,featureIndex,totalFeatures){
  const geom=feat.geometry;
  if(!geom||!['Polygon','MultiPolygon'].includes(geom.type)) return {added:false,reason:'non_polygon'};
  const name=feat.properties?.name||feat.properties?.nombre||feat.properties?.farm_id||`${fileName}${totalFeatures>1?' '+(featureIndex+1):''}`;
  const rawCoords=geom.type==='Polygon'?geom.coordinates[0]:geom.coordinates[0][0];
  const stage1=runStage1(rawCoords);
  if(stage1.errors.length===0){
    const ring=stage1.origRing;const area=polygonAreaHa(ring);const pp=polsbyPopper(ring);
    PLOTS.push({name,meta:`${area.toFixed(1)} ha · importado · café`,conf:0.60,tier:'medium',tierlabel:'Revisión recomendada',a2:0.58,a3:null,a4:0.65,area:`${area.toFixed(1)} ha`,compact:pp.toFixed(3),verts:String(ring.length),note:'Geometría válida. En cola para validación automática con MapBiomas y SRTM.',ci:'[0.47, 0.72]',needsRepair:false,geojson:{type:'FeatureCollection',features:[{type:'Feature',properties:feat.properties||{},geometry:{type:'Polygon',coordinates:[[...ring,ring[0]]]}}]}});
    return {added:true};
  }
  if(stage1.candidates.length>0){
    const rawPlot={name,meta:'',conf:0.40,tier:'medium',tierlabel:'Revisión recomendada',a2:0.40,a3:null,a4:0.55,area:'—',compact:'—',verts:String(stage1.origRing.length),note:'Pendiente reparación de Etapa 1.',ci:'[0.30, 0.55]',needsRepair:true,_origRing:stage1.origRing,geojson:{type:'FeatureCollection',features:[{type:'Feature',properties:feat.properties||{},geometry:{type:'Polygon',coordinates:[[...stage1.origRing,stage1.origRing[0]]]}}]}};
    openRepairModal(rawPlot,stage1);
    return {added:false,reason:'repair'};
  }
  return {added:false,reason:'invalid'};
}

async function handleFileUpload(event){
  const input=event.target;
  const importStarted=Date.now();
  logStudyEvent('file_import_started',{file_count:(input.files||[]).length,formats:Array.from(input.files||[]).map(f=>extensionOf(f.name))});
  const files=Array.from(input.files||[]);
  if(!files.length) return;
  const button=document.querySelector('.upload-btn');
  const originalText=button?.innerHTML;
  try{
    if(button){button.disabled=true;button.innerHTML='<span>⏳</span> Procesando archivo…';}
    const imported=await filesToGeoJSON(files);
    const polygons=polygonFeaturesOnly(imported);
    if(!polygons.features.length){
      throw new Error('El archivo no contiene polígonos. Los puntos CSV deben convertirse previamente en límites de parcela.');
    }
    let added=0,repairs=0;
    const baseName=files[0].name.replace(/\.(geojson|json|zip|shp|gpkg|fgb|csv)$/i,'');
    for(let i=0;i<polygons.features.length;i++){
      const result=queueImportedFeature(polygons.features[i],baseName,i,polygons.features.length);
      if(result.added) added++;
      if(result.reason==='repair'){repairs++;break;}
    }
    renderPlotList();savePlots();
    logStudyEvent('file_import_completed',{added,repairs,total_polygon_features:polygons.features.length,duration_ms:Date.now()-importStarted,formats:files.map(f=>extensionOf(f.name))},baseName,null,Date.now()-importStarted);
    if(added) showToast(`✓ ${added} parcela${added===1?'':'s'} importada${added===1?'':'s'}`);
    else if(!repairs) showToast('❌ No se pudo importar ninguna parcela válida');
  }catch(err){
    console.error('Spatial import failed:',err);
    showToast(`❌ ${err.message||'Error al leer el archivo'}`);
  }finally{
    input.value='';
    if(button){button.disabled=false;button.innerHTML=originalText;}
  }
}

/** Export a summary EUDR report for all plots */
function exportAllEUDR(){
  const ts = new Date().toISOString();
  const rows = PLOTS.map(p=>{
    const wd  = p.whispData || {};
    const risk= wd.risk_acrop||wd.risk_pcrop||'no analizado';
    const gfc = wd.GFC_loss_after_2020||0;
    return `<tr>
      <td>${p.name}</td>
      <td>${p.area||'—'}</td>
      <td>${p.conf.toFixed(2)}</td>
      <td>${p.a2!=null?p.a2.toFixed(2):'N/D'}</td>
      <td>${p.a3!=null?p.a3.toFixed(2):'N/D'}</td>
      <td>${p.a4!=null?p.a4.toFixed(2):'N/D'}</td>
      <td>${risk}</td>
      <td>${gfc.toFixed(3)} ha</td>
      <td class="${p.tier==='high'?'ok':'warn'}">${p.tier==='high'?'Conforme ✅':'Revisar ⚠️'}</td>
    </tr>`;
  }).join('');

  const html=`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
  <title>Resumen EUDR — ${ts.slice(0,10)}</title>
  <style>body{font-family:Arial,sans-serif;max-width:900px;margin:30px auto;padding:0 20px}
  h1{color:#0D3D2A}table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#0D3D2A;color:white;padding:8px;text-align:left}
  td{padding:7px 8px;border-bottom:1px solid #D4E4DA}
  .ok{color:#2E8B57;font-weight:700}.warn{color:#C84B2F;font-weight:700}
  .footer{margin-top:24px;font-size:10px;color:#888}</style></head><body>
  <h1>🌿 GeoCitizens — Resumen EUDR ${ts.slice(0,10)}</h1>
  <p style="font-size:13px;color:#555">Reglamento UE 2023/1115 · Fecha de corte: 31 dic 2020 · ${PLOTS.length} parcelas</p>
  <table><tr><th>Parcela</th><th>Área</th><th>C</th><th>A2</th><th>A3 IGAC</th><th>A4</th><th>WHISP</th><th>GFC post-2020</th><th>Estado</th></tr>
  ${rows}</table>
  <div class="footer">Generado: ${ts} · GeoCitizens · WHISP OpenForis</div>
  </body></html>`;

  const blob=new Blob([html],{type:'text/html;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`EUDR_resumen_${ts.slice(0,10)}.html`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('📥 Resumen EUDR descargado');
}

// ══════════════════════════════════════════════════════════════════════════
// OFFLINE DETECTION
// ══════════════════════════════════════════════════════════════════════════
function updateOnlineStatus(){
  const banner = document.getElementById('offline-banner');
  if(!navigator.onLine){
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
updateOnlineStatus();

// ══════════════════════════════════════════════════════════════════════════
// LOCALSTORAGE PERSISTENCE
// ══════════════════════════════════════════════════════════════════════════
const STORAGE_KEY = 'geocitizens_plots_v2';

function savePlots(){
  try {
    // Strip non-serialisable fields (_origRing internal) before saving
    const toSave = PLOTS.map(p => {
      const {_origRing, _existingIndex, ...rest} = p;
      return rest;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    const dot   = document.getElementById('save-dot');
    const label = document.getElementById('save-label');
    if(dot)   dot.classList.add('saved');
    if(label) label.textContent = 'Guardado · ' + new Date().toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit'});
  } catch(e) {
    console.warn('localStorage unavailable:', e);
  }
}

function loadPlots(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return false;
    const saved = JSON.parse(raw);
    if(!Array.isArray(saved) || saved.length === 0) return false;
    PLOTS = saved;
    const dot   = document.getElementById('save-dot');
    const label = document.getElementById('save-label');
    if(dot)   dot.classList.add('saved');
    if(label) label.textContent = 'Cargado desde memoria local';
    return true;
  } catch(e) {
    console.warn('Could not load saved plots:', e);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PLAIN LANGUAGE INTERPRETATION
// ══════════════════════════════════════════════════════════════════════════
function updatePlainLanguageCard(p){
  const verdict  = document.getElementById('plain-verdict');
  const message  = document.getElementById('plain-message');
  const action   = document.getElementById('plain-action');
  if(!verdict || !message || !action) return;

  if(p.validationState==='invalid_topology'||p.needsRepair){
    verdict.textContent='⚠️ El límite necesita reparación';
    message.textContent='La forma editada contiene líneas cruzadas, puntos repetidos u otro error geométrico.';
    action.textContent='Elige una reparación automática o vuelve a ajustar los vértices antes de continuar.';
    return;
  }
  if(p.validationState==='recalculating'){
    verdict.textContent='⏳ Validando el límite editado';
    message.textContent='Estamos recalculando la cobertura, la coincidencia catastral y la pendiente para la nueva forma.';
    action.textContent='Espera a que termine la validación antes de confirmar.';
    return;
  }

  const c = p.conf;
  const a2 = p.a2, a3 = p.a3, a4 = p.a4;

  // Build a human sentence per layer
  const layerSentences = [];

  if(a2 !== null && a2 !== undefined){
    if(a2 >= 0.70)
      layerSentences.push('Los mapas de cobertura de suelo confirman que aquí hay cultivo de café.');
    else if(a2 >= 0.45)
      layerSentences.push('Los mapas de cobertura muestran algo de café, pero el borde no coincide del todo.');
    else
      layerSentences.push('Los mapas de cobertura no detectan café claramente en esta zona — revisa si la parcela está bien ubicada.');
  }

  if(a3 !== null && a3 !== undefined){
    if(a3 >= 0.70)
      layerSentences.push('El catastro del IGAC tiene registrada una parcela que coincide bien con tu dibujo.');
    else if(a3 >= 0.45)
      layerSentences.push('El catastro del IGAC tiene una parcela en esta zona pero los límites no coinciden exactamente.');
    else
      layerSentences.push('El catastro del IGAC muestra una parcela aquí pero los límites son bastante diferentes.');
  } else {
    layerSentences.push('No encontramos tu parcela en el catastro del IGAC — esto es normal en muchas fincas de Quindío y no afecta tu puntaje.');
  }

  if(a4 !== null && a4 !== undefined){
    if(a4 >= 0.70)
      layerSentences.push('La pendiente del terreno es adecuada para cultivo de café.');
    else if(a4 >= 0.45)
      layerSentences.push('La pendiente es algo pronunciada para café, pero dentro del rango posible.');
    else
      layerSentences.push('El terreno es muy empinado para café — revisa si dibujaste la parcela en el lugar correcto.');
  }

  // Overall verdict
  let verdictText, messageText, actionText;
  if(c >= 0.65){
    verdictText = '✅ Tu parcela se ve bien';
    messageText = layerSentences.join(' ');
    actionText  = '💡 Puedes confirmar el límite. El sistema lo enviará automáticamente a la verificación de deforestación EUDR.';
  } else if(c >= 0.45){
    verdictText = '⚠️ Tu parcela necesita revisión';
    messageText = layerSentences.join(' ');
    actionText  = '✏️ Toca "Ajustar vértices" para mover el borde en el mapa, o confirma si crees que el límite es correcto.';
  } else {
    verdictText = '❌ Hay un problema con esta parcela';
    messageText = layerSentences.join(' ');
    actionText  = '🔄 Revisa la ubicación — puede que hayas dibujado el límite sobre otra finca. Rechaza y vuelve a dibujar.';
  }

  verdict.textContent = verdictText;
  message.textContent = messageText;
  action.textContent  = actionText;
}



// ══════════════════════════════════════════════════════════════════════════
// PERSISTENT INDEXEDDB CACHE
// Geometry-keyed cache for repair, Stage 2, IGAC and WHISP results.
// ══════════════════════════════════════════════════════════════════════════
const CACHE_DB_NAME = 'geocitizens_cache_v1';
const CACHE_STORE = 'analyses';
const CACHE_VERSION = 1;
let cacheDbPromise = null;

function openCacheDb(){
  if(cacheDbPromise) return cacheDbPromise;
  cacheDbPromise = new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)){ reject(new Error('IndexedDB no disponible')); return; }
    const req=indexedDB.open(CACHE_DB_NAME,CACHE_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE,{keyPath:'key'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||new Error('No se pudo abrir IndexedDB'));
  });
  return cacheDbPromise;
}

function normalizeGeometryForHash(geojson){
  const geom=geojson?.type==='FeatureCollection'?geojson.features?.[0]?.geometry:
             geojson?.type==='Feature'?geojson.geometry:geojson;
  if(!geom) return null;
  const round=n=>typeof n==='number'?Number(n.toFixed(7)):n;
  const walk=v=>Array.isArray(v)?v.map(walk):round(v);
  return {type:geom.type,coordinates:walk(geom.coordinates)};
}

async function geometryHash(geojson){
  const normalized=normalizeGeometryForHash(geojson);
  if(!normalized) return null;
  const text=JSON.stringify(normalized);
  if(crypto?.subtle){
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  let h=2166136261; for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}
  return 'fnv-'+(h>>>0).toString(16);
}

async function cacheGet(geojson, section, maxAgeMs=null){
  try{
    const hash=await geometryHash(geojson); if(!hash) return null;
    const db=await openCacheDb();
    const rec=await new Promise((resolve,reject)=>{
      const req=db.transaction(CACHE_STORE,'readonly').objectStore(CACHE_STORE).get(hash);
      req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error);
    });
    const entry=rec?.sections?.[section];
    if(!entry) return null;
    if(maxAgeMs && Date.now()-entry.timestamp>maxAgeMs) return null;
    return entry.value;
  }catch(e){ console.warn('Cache read failed:',e.message); return null; }
}

async function cacheSet(geojson, section, value){
  try{
    const hash=await geometryHash(geojson); if(!hash) return;
    const db=await openCacheDb();
    const tx=db.transaction(CACHE_STORE,'readwrite'); const store=tx.objectStore(CACHE_STORE);
    const existing=await new Promise((resolve,reject)=>{const r=store.get(hash);r.onsuccess=()=>resolve(r.result||{key:hash,sections:{}});r.onerror=()=>reject(r.error);});
    existing.sections=existing.sections||{};
    existing.sections[section]={timestamp:Date.now(),value};
    existing.updatedAt=Date.now();
    store.put(existing);
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
  }catch(e){ console.warn('Cache write failed:',e.message); }
}

async function clearPersistentCache(){
  const db=await openCacheDb();
  await new Promise((resolve,reject)=>{const tx=db.transaction(CACHE_STORE,'readwrite');tx.objectStore(CACHE_STORE).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
  showToast('🧹 Caché persistente eliminada');
}

// ══════════════════════════════════════════════════════════════════════════
// USER-STUDY SESSION TELEMETRY
// Anonymous by default. Use ?participant=P01&condition=multi_candidate in the URL.
// ══════════════════════════════════════════════════════════════════════════
const STUDY_APP_VERSION='session-analytics-v1';
const STUDY_PAGE_STARTED_AT=Date.now();
const STUDY_PARAMS=new URLSearchParams(location.search);
const STUDY_PARTICIPANT=STUDY_PARAMS.get('participant')||localStorage.getItem('geocitizens_participant_code')||'anonymous';
const STUDY_CONDITION=STUDY_PARAMS.get('condition')||localStorage.getItem('geocitizens_study_condition')||'multi_candidate';
let STUDY_SESSION_UUID=sessionStorage.getItem('geocitizens_study_session');
if(!STUDY_SESSION_UUID){
  STUDY_SESSION_UUID=crypto.randomUUID?crypto.randomUUID():`session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem('geocitizens_study_session',STUDY_SESSION_UUID);
}
const STUDY_TASK_STARTS=new Map();

function studyBackendCandidates(path){
  const candidates=[path];
  if(location.protocol==='http:' && !['5050','8000'].includes(location.port)){
    candidates.push(`http://localhost:5050${path}`,`http://127.0.0.1:5050${path}`);
  }
  return candidates;
}
async function studyRequest(path,body){
  let lastError=null;
  for(const url of studyBackendCandidates(path)){
    try{
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive:true});
      if(response.ok) return await response.json();
      lastError=new Error(`HTTP ${response.status}`);
    }catch(error){lastError=error;}
  }
  throw lastError||new Error('Study backend unavailable');
}
async function startStudySession(){
  try{
    await studyRequest('/api/study/sessions/start',{
      session_uuid:STUDY_SESSION_UUID,participant_code:STUDY_PARTICIPANT,
      study_condition:STUDY_CONDITION,app_version:STUDY_APP_VERSION,
      metadata:{user_agent:navigator.userAgent,screen:`${screen.width}x${screen.height}`,language:navigator.language}
    });
    await logStudyEvent('session_started',{path:location.pathname});
  }catch(error){console.warn('Study session logging unavailable:',error.message);}
}
async function logStudyEvent(eventType,payload={},plotName=null,taskId=null,elapsedMs=null){
  try{
    return await studyRequest('/api/study/events',{
      session_uuid:STUDY_SESSION_UUID,event_type:eventType,plot_name:plotName,
      task_id:taskId,elapsed_ms:elapsedMs,payload
    });
  }catch(error){console.warn(`Study event ${eventType} unavailable:`,error.message);}
}
function startStudyTask(taskId){STUDY_TASK_STARTS.set(taskId,Date.now());}
function studyElapsed(taskId){const start=STUDY_TASK_STARTS.get(taskId);return start?Date.now()-start:null;}
function endStudyTask(taskId){const elapsed=studyElapsed(taskId);STUDY_TASK_STARTS.delete(taskId);return elapsed;}
window.addEventListener('pagehide',()=>{
  const completedSession=sessionStorage.getItem('geocitizens_study_completed_session');
  if(completedSession===STUDY_SESSION_UUID) return;

  const payload={session_uuid:STUDY_SESSION_UUID,completion_status:'left_page',metadata:{elapsed_ms:Date.now()-STUDY_PAGE_STARTED_AT}};
  for(const url of studyBackendCandidates('/api/study/sessions/end')){
    try{navigator.sendBeacon(url,new Blob([JSON.stringify(payload)],{type:'application/json'}));break;}catch(_error){}
  }
});

// ══════════════════════════════════════════════════════════════════════════
// APPLICATION STARTUP
// Runs only after all feature modules have been parsed.
// ══════════════════════════════════════════════════════════════════════════
if(!loadPlots()){
  savePlots();
}
renderPlotList();
startStudySession();
setTimeout(initMap, 100);
