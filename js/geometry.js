// ══════════════════════════════════════════════════════════════════════════
// STAGE 1 — TOPOLOGY CHECKS  (pure JS, no external libs)
// ══════════════════════════════════════════════════════════════════════════

/** Cross product of vectors (p1→p2) and (p1→p3) */
function cross(p1,p2,p3){
  return (p2[0]-p1[0])*(p3[1]-p1[1])-(p2[1]-p1[1])*(p3[0]-p1[0]);
}
/** Do segments (a,b) and (c,d) properly intersect? */
function segmentsIntersect(a,b,c,d){
  const d1=cross(c,d,a), d2=cross(c,d,b);
  const d3=cross(a,b,c), d4=cross(a,b,d);
  if(((d1>0&&d2<0)||(d1<0&&d2>0))&&((d3>0&&d4<0)||(d3<0&&d4>0))) return true;
  return false;
}
/** Detect self-intersections in a ring (list of [lng,lat] without closing dup) */
function detectSelfIntersections(ring){
  const n=ring.length;
  const pairs=[];
  for(let i=0;i<n;i++){
    const a=ring[i], b=ring[(i+1)%n];
    for(let j=i+2;j<n;j++){
      if(i===0&&j===n-1) continue; // adjacent closing edge
      const c=ring[j], d=ring[(j+1)%n];
      if(segmentsIntersect(a,b,c,d)) pairs.push([i,j]);
    }
  }
  return pairs;
}
/** Detect spikes: interior angle < 5° */
function detectSpikes(ring){
  const n=ring.length; const thresh=Math.cos((5)*Math.PI/180);
  const spikes=[];
  for(let i=0;i<n;i++){
    const prev=ring[(i-1+n)%n], curr=ring[i], next=ring[(i+1)%n];
    const ax=prev[0]-curr[0], ay=prev[1]-curr[1];
    const bx=next[0]-curr[0], by=next[1]-curr[1];
    const dot=ax*bx+ay*by;
    const magA=Math.sqrt(ax*ax+ay*ay), magB=Math.sqrt(bx*bx+by*by);
    if(magA>0&&magB>0){ const cosA=dot/(magA*magB); if(cosA>=thresh) spikes.push(i); }
  }
  return spikes;
}
/** Polsby-Popper compactness from ring */
function polsbyPopper(ring){
  const area=Math.abs(shoelaceArea(ring));
  let perim=0;
  for(let i=0;i<ring.length;i++){
    const a=ring[i], b=ring[(i+1)%ring.length];
    const dx=(a[0]-b[0])*111320*Math.cos(a[1]*Math.PI/180);
    const dy=(a[1]-b[1])*111320;
    perim+=Math.sqrt(dx*dx+dy*dy);
  }
  const areaM2=area*111320*111320*Math.cos(ring[0][1]*Math.PI/180);
  if(perim<=0) return 0;
  return (4*Math.PI*areaM2)/(perim*perim);
}
/** Signed Shoelace area in degree² */
function shoelaceArea(ring){
  let a=0; const n=ring.length;
  for(let i=0;i<n;i++){const j=(i+1)%n; a+=ring[i][0]*ring[j][1]-ring[j][0]*ring[i][1];}
  return a/2;
}
/** Area in ha */
function polygonAreaHa(ring){
  const areaDeg2=Math.abs(shoelaceArea(ring));
  return areaDeg2*111320*111320*Math.cos(ring[0][1]*Math.PI/180)/10000;
}
/** Convex hull (Andrew's monotone chain) */
function convexHull(pts){
  const p=[...pts].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const lower=[],upper=[];
  for(const pt of p){
    while(lower.length>=2&&cross(lower[lower.length-2],lower[lower.length-1],pt)<=0) lower.pop();
    lower.push(pt);
  }
  for(let i=p.length-1;i>=0;i--){
    const pt=p[i];
    while(upper.length>=2&&cross(upper[upper.length-2],upper[upper.length-1],pt)<=0) upper.pop();
    upper.push(pt);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
/** Remove spikes from ring */
function removeSpikes(ring, angleThreshDeg = 5.0) {
  const thresh = Math.cos(angleThreshDeg * Math.PI / 180);
  let current = ring.slice();
  let changed = true;
  let passes = 0;
  while (changed && passes < 5) {
    changed = false;
    passes++;
    const n = current.length;
    if (n < 4) break;  // never go below 3 vertices
    const keep = [];
    for (let i = 0; i < n; i++) {
      const prev = current[(i - 1 + n) % n];
      const curr = current[i];
      const next = current[(i + 1) % n];
      const ax = prev[0]-curr[0], ay = prev[1]-curr[1];
      const bx = next[0]-curr[0], by = next[1]-curr[1];
      const dot = ax*bx + ay*by;
      const magA = Math.sqrt(ax*ax+ay*ay);
      const magB = Math.sqrt(bx*bx+by*by);
      if (magA > 0 && magB > 0 && dot/(magA*magB) >= thresh) {
        changed = true;  // this is a spike — skip it
      } else {
        keep.push(curr);
      }
    }
    if (keep.length >= 3) current = keep;
  }
  return current;
}
/** Remove duplicate consecutive vertices */
function removeDuplicates(ring){
  return ring.filter((v,i)=>{
    const prev=ring[(i-1+ring.length)%ring.length];
    return !(Math.abs(v[0]-prev[0])<1e-9&&Math.abs(v[1]-prev[1])<1e-9);
  });
}


/** Exact intersection point for two non-parallel segments. */
function segmentIntersectionPoint(a,b,c,d){
  const x1=a[0], y1=a[1], x2=b[0], y2=b[1];
  const x3=c[0], y3=c[1], x4=d[0], y4=d[1];
  const den=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4);
  if(Math.abs(den)<1e-15) return null;
  const px=((x1*y2-y1*x2)*(x3-x4)-(x1-x2)*(x3*y4-y3*x4))/den;
  const py=((x1*y2-y1*x2)*(y3-y4)-(y1-y2)*(x3*y4-y3*x4))/den;
  return [px,py];
}

/** Remove self-intersections by repeatedly reversing the vertex span between crossing edges (2-opt). */
function untangleRing2Opt(inputRing){
  let ring=inputRing.map(v=>[...v]);
  const maxPasses=Math.max(20,ring.length*ring.length);
  for(let pass=0;pass<maxPasses;pass++){
    const intersections=detectSelfIntersections(ring);
    if(intersections.length===0) return ring;
    const [i,j]=intersections[0];
    const start=i+1;
    const end=j;
    const reversed=ring.slice(start,end+1).reverse();
    ring=[...ring.slice(0,start),...reversed,...ring.slice(end+1)];
  }
  return ring;
}

/** Sort vertices around the arithmetic centroid, preserving every original vertex. */
function radialOrderRing(inputRing){
  const cx=inputRing.reduce((sum,v)=>sum+v[0],0)/inputRing.length;
  const cy=inputRing.reduce((sum,v)=>sum+v[1],0)/inputRing.length;
  return inputRing.map((v,index)=>({v:[...v],index,angle:Math.atan2(v[1]-cy,v[0]-cx),distance:(v[0]-cx)**2+(v[1]-cy)**2}))
    .sort((a,b)=>a.angle-b.angle||a.distance-b.distance||a.index-b.index)
    .map(item=>item.v);
}

/** Build the two lobes created by the first self-intersection. */
function splitAtFirstIntersection(inputRing){
  const pairs=detectSelfIntersections(inputRing);
  if(!pairs.length) return [];
  const [i,j]=pairs[0];
  const n=inputRing.length;
  const p=segmentIntersectionPoint(inputRing[i],inputRing[(i+1)%n],inputRing[j],inputRing[(j+1)%n]);
  if(!p) return [];
  const lobeA=[p];
  for(let k=i+1;k<=j;k++) lobeA.push([...inputRing[k%n]]);
  const lobeB=[p];
  let k=j+1;
  while(k%n!==i+1){ lobeB.push([...inputRing[k%n]]); k++; if(k>j+n+2) break; }
  return [removeDuplicates(lobeA),removeDuplicates(lobeB)].filter(r=>r.length>=3);
}

function candidateSignature(ring){
  return ring.map(v=>`${v[0].toFixed(8)},${v[1].toFixed(8)}`).sort().join('|');
}

function addRepairCandidate(candidates,candidate){
  if(!candidate?.ring||candidate.ring.length<3) return;
  if(detectSelfIntersections(candidate.ring).length) return;
  const sig=candidateSignature(candidate.ring);
  if(candidates.some(c=>candidateSignature(c.ring)===sig)) return;
  candidates.push(candidate);
}

// ══════════════════════════════════════════════════════════════════════════
// REPAIR SCORING  (E1=V, E2=APS, E3=SCS)
// ══════════════════════════════════════════════════════════════════════════
function scoreCandidate(origRing, candidateRing, hasSelfIntersect){
  const V_orig = hasSelfIntersect ? 0.0 : 1.0;
  const V_rep  = detectSelfIntersections(candidateRing).length===0 ? 1.0 : 0.0;
  // A self-intersecting shoelace area can cancel to almost zero. Use the
  // convex-hull area as the stable reference for comparing repair options.
  const aOrigRaw = polygonAreaHa(origRing);
  const aOrig = hasSelfIntersect ? Math.max(aOrigRaw,polygonAreaHa(convexHull(origRing))) : aOrigRaw;
  const aRep  = polygonAreaHa(candidateRing);
  const APS   = aOrig>0 ? Math.max(0, 1 - Math.abs(aOrig-aRep)/aOrig) : 1.0;
  const ppOrig = polsbyPopper(hasSelfIntersect?convexHull(origRing):origRing);
  const ppRep  = polsbyPopper(candidateRing);
  const SCS    = ppOrig>0 ? Math.max(0, 1-Math.abs(ppOrig-ppRep)/ppOrig) : 0.5;
  const vertexRetention=Math.min(1,candidateRing.length/Math.max(1,origRing.length));
  const score = 0.45*V_rep + 0.25*APS + 0.20*SCS + 0.10*vertexRetention;
  return { V_orig, V_rep, APS, SCS, vertexRetention, score, areaHa:aRep, referenceAreaHa:aOrig, pp:ppRep };
}

// ══════════════════════════════════════════════════════════════════════════
// STAGE 1 — FULL RUN
// Returns { errors, candidates } where each candidate = { name, desc, ring, scores }
// ══════════════════════════════════════════════════════════════════════════
function runStage1(rawRing){
  const errors = [];
  let ring = Array.isArray(rawRing) ? rawRing.map(v=>[...v]) : [];
  const last = ring[ring.length-1];
  if(last&&ring[0]&&Math.abs(ring[0][0]-last[0])<1e-9&&Math.abs(ring[0][1]-last[1])<1e-9) ring=ring.slice(0,-1);

  const duplicateCount=ring.reduce((count,v,i)=>{
    if(i===0) return count;
    const prev=ring[i-1];
    return count+(Math.abs(v[0]-prev[0])<1e-9&&Math.abs(v[1]-prev[1])<1e-9?1:0);
  },0);
  if(duplicateCount>0) errors.push({type:'duplicate_vertices',count:duplicateCount,label:`${duplicateCount} vértice${duplicateCount!==1?'s':''} duplicado${duplicateCount!==1?'s':''}`,icon:'📍'});

  const originalWithDuplicates=ring.map(v=>[...v]);
  ring = removeDuplicates(ring);

  const spikeIdxs = detectSpikes(ring);
  if(spikeIdxs.length>0) errors.push({type:'spike', count:spikeIdxs.length, label:`${spikeIdxs.length} spike${spikeIdxs.length>1?'s':''}`, icon:'📌'});
  const intersections = detectSelfIntersections(ring);
  const hasSI = intersections.length>0;
  if(hasSI) errors.push({type:'self_intersection', count:intersections.length, label:`${intersections.length} ${intersections.length===1?'auto-intersección':'auto-intersecciones'}`, icon:'🔀'});
  const area = ring.length>=3 ? polygonAreaHa(ring) : 0;
  const pp   = ring.length>=3 ? polsbyPopper(ring) : 0;
  if(area<=1e-6) errors.push({type:'zero_area',label:'El polígono no tiene un área válida',icon:'📐'});
  else if(area<0.1||area>500) errors.push({type:'area',label:`Área fuera de rango (${area.toFixed(1)} ha)`,icon:'📏'});
  if(pp<0.05) errors.push({type:'compactness',label:`Compacidad muy baja (${pp.toFixed(3)})`,icon:'🔶'});
  if(ring.length<3) errors.push({type:'vertices',label:'Menos de 3 vértices',icon:'📍'});
  if(errors.length===0) return {errors:[], candidates:[], origRing:ring};

  const candidates=[];
  if(duplicateCount>0 && ring.length>=3){
    addRepairCandidate(candidates,{
      name:'Eliminar vértices duplicados',
      desc:'Elimina puntos consecutivos repetidos sin cambiar el resto del límite.',
      ring:ring.map(v=>[...v]),scores:scoreCandidate(originalWithDuplicates,ring,hasSI),strategy:'remove_duplicates'
    });
  }
  if(hasSI){
    const untangled=untangleRing2Opt(ring);
    addRepairCandidate(candidates,{
      name:'Desenredo mínimo (2-opt)',
      desc:'Invierte únicamente los tramos que se cruzan, conservando todos los vértices y reduciendo la modificación del límite.',
      ring:untangled,scores:scoreCandidate(ring,untangled,true),strategy:'two_opt'
    });

    const radial=radialOrderRing(ring);
    addRepairCandidate(candidates,{
      name:'Reconstrucción por orden angular',
      desc:'Reordena todos los vértices alrededor del centro del lote. Conserva los puntos originales, pero puede modificar el recorrido del borde.',
      ring:radial,scores:scoreCandidate(ring,radial,true),strategy:'radial_order'
    });

    const lobes=splitAtFirstIntersection(ring).sort((a,b)=>polygonAreaHa(b)-polygonAreaHa(a));
    if(lobes[0]) addRepairCandidate(candidates,{
      name:'Contorno dominante',
      desc:'Conserva el lóbulo de mayor superficie creado por la auto-intersección. Es útil cuando una parte cruzada corresponde a un trazo accidental.',
      ring:lobes[0],scores:scoreCandidate(ring,lobes[0],true),strategy:'dominant_lobe'
    });

    const hull = convexHull(ring);
    addRepairCandidate(candidates,{
      name:'Envolvente convexa',
      desc:'Incluye todos los vértices dentro de un límite exterior válido. Es una opción de respaldo que puede incorporar terreno adicional.',
      ring:hull,scores:scoreCandidate(ring,hull,true),strategy:'convex_hull'
    });
  }

  if(hasSI && candidates.length<3){
    const xs=ring.map(v=>v[0]), ys=ring.map(v=>v[1]);
    const bboxRing=[
      [Math.min(...xs),Math.min(...ys)],
      [Math.max(...xs),Math.min(...ys)],
      [Math.max(...xs),Math.max(...ys)],
      [Math.min(...xs),Math.max(...ys)]
    ];
    addRepairCandidate(candidates,{
      name:'Rectángulo envolvente',
      desc:'Opción conservadora de comparación basada en la extensión total. Puede incluir áreas externas y normalmente requiere ajuste manual.',
      ring:bboxRing,scores:scoreCandidate(ring,bboxRing,true),strategy:'bounding_box'
    });
  }

  if(spikeIdxs.length>0){
    const spikeFixed = removeSpikes(ring,5.0);
    addRepairCandidate(candidates,{
      name:'Eliminación de spikes',
      desc:`Elimina ${spikeIdxs.length} vértice${spikeIdxs.length!==1?'s':''} con ángulo muy cerrado, manteniendo el resto del límite.`,
      ring:spikeFixed,scores:scoreCandidate(ring,spikeFixed,hasSI),strategy:'spike_removal'
    });
  }

  candidates.forEach(c=>{
    const destructivePenalty=(c.scores.referenceAreaHa>0&&Math.abs(c.scores.areaHa-c.scores.referenceAreaHa)/c.scores.referenceAreaHa>0.20)?0.08:0;
    c.priority=c.scores.score-destructivePenalty;
  });
  candidates.sort((a,b)=>b.priority-a.priority);
  return {errors, candidates:candidates.slice(0,4), origRing:ring};
}
