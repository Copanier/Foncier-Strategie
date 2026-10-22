// @ts-nocheck
// Fonction Supabase « swift-api » — générée par outils/supabase/assembler.mjs (ne pas modifier à la main :
// modifier enrichir.js, rapprochement.js, courriels.js ou principal.js puis relancer l'assemblage).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const AUTORISATION_RESEND = __AUTORISATION_RESEND__;

// ═════ enrichir.js ═════
// Analyse des parcelles d'un dépôt : géométrie (API Carto IGN), îlots de parcelles contiguës,
// zonage d'urbanisme (Géoportail de l'Urbanisme). Code commun à la fonction Supabase et aux tests locaux.

const CARTO = 'https://apicarto.ign.fr/api';

async function json(url, opts) {
  for (let essai = 0; essai < 3; essai++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return await r.json();
    } catch (_) { /* nouvel essai */ }
    await new Promise((ok) => setTimeout(ok, 400 * (essai + 1)));
  }
  return null;
}

// Exécute des tâches asynchrones avec un parallélisme limité (pour ménager l'API IGN)
async function parLots(items, n, f) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await f(items[k], k); }
  }));
  return res;
}

/* ── Géométrie (coordonnées projetées localement en mètres) ── */
function anneaux(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function projeteur(lat0) {
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110574;
  return ([x, y]) => [x * kx, y * ky];
}
function dansAnneau(pt, ring) {
  let dedans = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) dedans = !dedans;
  }
  return dedans;
}
function dansPolygone(pt, geom) {
  return anneaux(geom).some((poly) => dansAnneau(pt, poly[0]) && !poly.slice(1).some((trou) => dansAnneau(pt, trou)));
}
function bbox(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  anneaux(geom).forEach((p) => p.forEach((r) => r.forEach(([x, y]) => {
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  })));
  return b;
}
function distPointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}
// Deux parcelles se touchent si un sommet de l'une est à moins de `tol` mètres d'un bord de l'autre
function contigues(A, B, proj, tol = 1.5) {
  const ba = A.bboxM, bb = B.bboxM;
  if (ba[0] - tol > bb[2] || bb[0] - tol > ba[2] || ba[1] - tol > bb[3] || bb[1] - tol > ba[3]) return false;
  const test = (P, Q) => {
    const segs = [];
    Q.ringsM.forEach((r) => { for (let i = 1; i < r.length; i++) segs.push([r[i - 1], r[i]]); });
    return P.ringsM.some((r) => r.some((pt) => segs.some(([a, b]) => distPointSegment(pt, a, b) < tol)));
  };
  return test(A, B) || test(B, A);
}
// Points régulièrement répartis à l'intérieur d'une parcelle (pour mesurer la part de chaque zone du PLU)
function echantillons(geom, cible = 120) {
  const b = bbox(geom), proj = projeteur((b[1] + b[3]) / 2);
  const [x0, y0] = proj([b[0], b[1]]), [x1, y1] = proj([b[2], b[3]]);
  const pas = Math.max(Math.sqrt(((x1 - x0) * (y1 - y0)) / cible), 0.5);
  const nx = Math.max(1, Math.ceil((x1 - x0) / pas)), ny = Math.max(1, Math.ceil((y1 - y0) / pas));
  const pts = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const p = [b[0] + (b[2] - b[0]) * (i + 0.5) / nx, b[1] + (b[3] - b[1]) * (j + 0.5) / ny];
    if (dansPolygone(p, geom)) pts.push(p);
  }
  if (!pts.length) {                     // parcelle très fine : on prend la moyenne des sommets
    const r = anneaux(geom)[0][0]; let x = 0, y = 0; r.forEach((c) => { x += c[0]; y += c[1]; }); pts.push([x / r.length, y / r.length]);
  }
  return pts;
}

/* ── Données IGN ── */
async function geometrieParcelle(p) {
  const idu = p.id || p.idu || '';
  const insee = p.insee || idu.slice(0, 5);
  let section = (p.section || idu.slice(8, 10) || '').toUpperCase(); if (section.length === 1) section = '0' + section;
  const numero = String(p.numero || idu.slice(10, 14)).padStart(4, '0');
  const comAbs = idu.length === 14 ? idu.slice(5, 8) : '000';
  let d = null;
  if (insee && section && numero) {
    d = await json(`${CARTO}/cadastre/parcelle?code_insee=${insee}&section=${section}&numero=${numero}${comAbs !== '000' ? '&com_abs=' + comAbs : ''}`);
  }
  if ((!d || !d.features || !d.features.length) && p.point) {
    d = await json(`${CARTO}/cadastre/parcelle?geom=${encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: p.point }))}`);
  }
  const f = d && d.features && (d.features.find((x) => x.properties.idu === idu) || d.features[0]);
  return f || null;
}

const TYPEZONE = { U: 'Zone urbaine', AU: 'Zone à urbaniser', AUc: 'Zone à urbaniser (constructible)', AUs: 'Zone à urbaniser (stricte)',
  A: 'Zone agricole', N: 'Zone naturelle et forestière', Nh: 'Zone naturelle habitée', Nd: 'Zone naturelle' };
const TYPESECT = { '01': 'Secteur constructible', '02': 'Secteur non constructible', '03': 'Secteur constructible (activités)',
  '99': 'Autre secteur' };
const DOCS = { PLU: 'PLU', PLUi: 'PLU intercommunal', POS: 'POS', CC: 'Carte communale', PSMV: 'Plan de sauvegarde et de mise en valeur' };

async function urbanisme(geom, point) {
  const corps = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ geom }) };
  const [zones, secteurs, docs] = await Promise.all([
    json(`${CARTO}/gpu/zone-urba`, corps),
    json(`${CARTO}/gpu/secteur-cc`, corps),
    json(`${CARTO}/gpu/document?geom=${encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: point }))}`)
  ]);
  const doc = docs && docs.features && docs.features[0] ? docs.features[0].properties : null;
  const liste = [];
  ((zones && zones.features) || []).forEach((f) => liste.push({ geom: f.geometry, code: f.properties.libelle || '?',
    libelle: (f.properties.libelong || '').replace(/^\s*[^:]*:\s*/, '') || TYPEZONE[f.properties.typezone] || '',
    type: f.properties.typezone || '', typeLib: TYPEZONE[f.properties.typezone] || f.properties.typezone || '' }));
  ((secteurs && secteurs.features) || []).forEach((f) => liste.push({ geom: f.geometry, code: f.properties.libelle || 'Secteur',
    libelle: f.properties.libelong || TYPESECT[f.properties.typesect] || '', type: 'CC', typeLib: TYPESECT[f.properties.typesect] || 'Secteur de carte communale' }));
  return { doc, liste };
}

/* ── Analyse complète ── */
async function analyserParcelles(parcelles, { limite = 80 } = {}) {
  const src = (parcelles || []).slice(0, limite);
  const features = await parLots(src, 4, geometrieParcelle);
  const lignes = src.map((p, i) => {
    const f = features[i], pr = f ? f.properties : {};
    const idu = pr.idu || p.id || p.idu || '';
    return {
      idu, introuvable: !f, insee: pr.code_insee || p.insee || idu.slice(0, 5), commune: pr.nom_com || p.commune || '',
      section: (pr.section || p.section || idu.slice(8, 10) || '').replace(/^0/, ''), numero: String(Number(pr.numero || p.numero || idu.slice(10, 14) || 0)),
      contenance: Number(pr.contenance) || Number(p.contenance_m2) || 0,
      geom: f ? f.geometry : null, point: p.point
    };
  });

  // Communes et départements
  const insees = [...new Set(lignes.map((l) => l.insee).filter(Boolean))];
  const infos = {};
  await parLots(insees, 4, async (c) => {
    const [g, m] = await Promise.all([
      json(`https://geo.api.gouv.fr/communes/${c}?fields=nom,departement`),
      json(`${CARTO}/gpu/municipality?insee=${c}`)
    ]);
    infos[c] = { nom: g && g.nom, depCode: g && g.departement && g.departement.code, depNom: g && g.departement && g.departement.nom,
      rnu: !!(m && m.features && m.features[0] && m.features[0].properties.is_rnu) };
  });

  // Îlots : parcelles contiguës d'une même commune (union-find)
  const lat0 = lignes.find((l) => l.geom) ? bbox(lignes.find((l) => l.geom).geom)[1] : 46;
  const proj = projeteur(lat0);
  lignes.forEach((l) => {
    if (!l.geom) return;
    l.ringsM = anneaux(l.geom).flatMap((p) => p.map((r) => r.map(proj)));
    const b = bbox(l.geom), a = proj([b[0], b[1]]), c = proj([b[2], b[3]]); l.bboxM = [a[0], a[1], c[0], c[1]];
  });
  const parent = lignes.map((_, i) => i);
  const racine = (i) => (parent[i] === i ? i : (parent[i] = racine(parent[i])));
  for (let i = 0; i < lignes.length; i++) for (let j = i + 1; j < lignes.length; j++) {
    const A = lignes[i], B = lignes[j];
    if (A.insee === B.insee && A.geom && B.geom && contigues(A, B, proj)) parent[racine(i)] = racine(j);
  }

  // Urbanisme parcelle par parcelle (part de surface estimée par échantillonnage)
  await parLots(lignes, 3, async (l) => {
    if (!l.geom) { l.zones = []; return; }
    const u = await urbanisme(l.geom, l.point || echantillons(l.geom, 1)[0]);
    l.doc = u.doc;
    const pts = echantillons(l.geom);
    const compte = new Map();
    pts.forEach((pt) => {
      const z = u.liste.find((zz) => dansPolygone(pt, zz.geom));
      const cle = z ? z.code + '|' + z.type : '—';
      compte.set(cle, { z, n: ((compte.get(cle) || {}).n || 0) + 1 });
    });
    l.zones = [...compte.values()].map(({ z, n }) => ({ code: z ? z.code : null, libelle: z ? z.libelle : '', type: z ? z.type : '',
      typeLib: z ? z.typeLib : '', m2: l.contenance * n / pts.length }));
  });

  // Regroupement par commune puis par îlot
  const communes = new Map();
  lignes.forEach((l, i) => {
    const info = infos[l.insee] || {};
    if (!communes.has(l.insee)) communes.set(l.insee, { insee: l.insee, nom: info.nom || l.commune, depCode: info.depCode || l.insee.slice(0, 2),
      depNom: info.depNom || '', rnu: info.rnu, doc: null, ilots: new Map(), m2: 0, n: 0 });
    const c = communes.get(l.insee);
    if (!c.doc && l.doc) c.doc = l.doc;
    const k = racine(i);
    if (!c.ilots.has(k)) c.ilots.set(k, { parcelles: [], m2: 0 });
    c.ilots.get(k).parcelles.push(l); c.ilots.get(k).m2 += l.contenance; c.m2 += l.contenance; c.n++;
  });
  const listeCommunes = [...communes.values()].map((c) => ({ ...c,
    ilots: [...c.ilots.values()].sort((a, b) => b.m2 - a.m2).map((il) => ({ ...il,
      parcelles: il.parcelles.sort((a, b) => (a.section + a.numero.padStart(4, '0')).localeCompare(b.section + b.numero.padStart(4, '0'))) })) }))
    .sort((a, b) => b.m2 - a.m2);

  // Synthèse urbanisme : par commune, zone et type
  const urba = new Map();
  lignes.forEach((l) => (l.zones || []).forEach((z) => {
    const cle = l.insee + '|' + (z.code || '—') + '|' + z.type;
    if (!urba.has(cle)) urba.set(cle, { insee: l.insee, commune: (infos[l.insee] || {}).nom || l.commune, code: z.code, libelle: z.libelle,
      type: z.type, typeLib: z.typeLib, m2: 0, parcelles: new Set() });
    const u = urba.get(cle); u.m2 += z.m2; u.parcelles.add(l.section + ' ' + l.numero);
  }));

  // Emprise pour le lien carte
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  lignes.forEach((l) => {
    const bb = l.geom ? bbox(l.geom) : (l.point ? [l.point[0], l.point[1], l.point[0], l.point[1]] : null);
    if (!bb) return;
    b[0] = Math.min(b[0], bb[0]); b[1] = Math.min(b[1], bb[1]); b[2] = Math.max(b[2], bb[2]); b[3] = Math.max(b[3], bb[3]);
  });

  return {
    total: lignes.reduce((s, l) => s + l.contenance, 0),
    nombre: lignes.filter((l) => !l.introuvable).length,
    introuvables: lignes.filter((l) => l.introuvable).map((l) => l.idu),
    tronque: (parcelles || []).length > src.length,
    nbIlots: listeCommunes.reduce((s, c) => s + c.ilots.filter((il) => il.parcelles.some((p) => !p.introuvable)).length, 0),
    communes: listeCommunes,
    urbanisme: [...urba.values()].map((u) => ({ ...u, parcelles: [...u.parcelles] })).sort((a, b) => a.commune.localeCompare(b.commune) || b.m2 - a.m2),
    bornes: isFinite(b[0]) ? b : null,
    idus: lignes.map((l) => l.idu).filter(Boolean),
    DOCS
  };
}

// ═════ rapprochement.js ═════
// Rapprochement automatique entre recherches de foncier (acquéreurs, développeurs) et terrains déposés.
// Un terrain correspond à une recherche si : type de projet compatible, surface suffisante,
// et au moins une parcelle (ou le repère) située dans l'une des zones de la recherche (rayon ou zone dessinée).
// Sans zone, la recherche couvre toute la France.

const parseJson = (v, defaut) => { if (v == null || v === '') return defaut; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return defaut; } };
const listeTypes = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Points et surface d'un terrain déposé
function terrainDe(d) {
  const parcelles = parseJson(d.parcelles, []);
  const points = parcelles.map((p) => p.point).filter((p) => Array.isArray(p) && p.length === 2);
  const m = String(d.description || '').match(/[?&]c=(-?[\d.]+),(-?[\d.]+)/);
  if (!points.length && m) points.push([Number(m[1]), Number(m[2])]);
  const m2 = parcelles.reduce((s, p) => s + (Number(p.contenance_m2) || 0), 0);
  return { points, ha: m2 ? m2 / 10000 : (Number(d.surface) || null), idus: parcelles.map((p) => p.id).filter(Boolean),
    communes: [...new Set(parcelles.map((p) => p.commune).filter(Boolean))],
    insees: [...new Set(parcelles.map((p) => p.insee || String(p.id || '').slice(0, 5)).filter(Boolean))] };
}

// Teste un terrain (t = terrainDe(depot)) contre une recherche ; renvoie null ou { zone, distance }
function correspond(r, depot, t) {
  const T = listeTypes(r.types_bien), P = listeTypes(depot.projets);
  if (T.length && P.length && !T.includes('autre') && !P.includes('autre') && !T.some((x) => P.includes(x))) return null;
  if (r.surface_min && t.ha && t.ha < Number(r.surface_min) * 0.9) return null;        // 10 % de tolérance
  const zones = (parseJson(r.zones, {}).features || []);
  const terr = (parseJson(r.criteres, {}).territoires || []);
  if (!zones.length && !terr.length) return { zone: null, distance: null };
  // Communes, départements ou régions ciblés
  const dep = (insee) => (/^97/.test(insee) ? insee.slice(0, 3) : insee.slice(0, 2));
  for (const x of terr) {
    const ok = t.insees.some((i) => (x.type === 'commune' ? i === x.code : x.type === 'departement' ? dep(i) === x.code : (x.deps || []).includes(dep(i))));
    if (ok) return { zone: null, distance: null, territoire: x.nom };
  }
  if (!t.points.length) return null;
  for (const f of zones) {
    const p = f.properties || {};
    for (const pt of t.points) {
      if (p.centre && p.rayon_km) {
        const dist = distanceKm(p.centre, pt);
        if (dist <= Number(p.rayon_km)) return { zone: p.n, distance: dist, libelle: p.libelle };
      } else if (f.geometry && dansPolygone(pt, f.geometry)) return { zone: p.n, distance: null, libelle: p.libelle };
    }
  }
  return null;
}

async function lireTable(table, select) {
  const url = Deno.env.get('SUPABASE_URL'), cle = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !cle) return [];
  const r = await fetch(`${url}/rest/v1/${table}?select=${select}&order=created_at.desc&limit=3000`, { headers: { apikey: cle, Authorization: `Bearer ${cle}` } });
  if (!r.ok) { console.error('lecture', table, r.status, await r.text()); return []; }
  return await r.json();
}

// Pour une nouvelle recherche : terrains déjà déposés qui correspondent
async function terrainsPourRecherche(r) {
  const depots = await lireTable('depositions', 'id,created_at,prenom,nom,societe,projets,surface,parcelles,description');
  const res = [];
  for (const d of depots) {
    const t = terrainDe(d), c = correspond(r, d, t);
    if (c) res.push({ ...c, depot: d, terrain: t });
  }
  return res;
}

// Pour un nouveau terrain : recherches enregistrées qui correspondent
async function recherchesPourTerrain(d) {
  const recherches = await lireTable('recherches', 'id,created_at,prenom,nom,societe,email,types_bien,surface_min,surface_max,zones,criteres,ville,secteurs');
  const t = terrainDe(d), res = [];
  for (const r of recherches) {
    const c = correspond(r, d, t);
    if (c) res.push({ ...c, recherche: r });
  }
  return res;
}

// ═════ courriels.js ═════
// Mise en forme des e-mails envoyés par la fonction Supabase (fiche interne + accusés de réception).

const SITE = 'https://www.foncierstrategie.fr';
const OR = '#B8973A', NUIT = '#0F1E2D', GRIS = '#5E6D7C', CREME = '#F8F4EC', LIGNE = '#E8DFC8';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nb = (n, d = 2) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: d }).replace(/ /g, ' ');
const surf = (m2) => (m2 >= 10000 ? nb(m2 / 10000) + ' ha' : nb(Math.round(m2), 0) + ' m²');
const pluriel = (n, s, p) => n + ' ' + (n > 1 ? (p || s + 's') : s);
const nl2br = (s) => esc(s).replace(/\n/g, '<br>');

const PROJETS = { solaire: 'Centrale solaire au sol', agrivoltaique: 'Agrivoltaïsme', batteries: 'Stockage par batteries (BESS)', datacenter: 'Data center',
  eolien: 'Éolien', carriere: 'Carrière & fortage', remblais: 'Remblais & ISDI', industriel: 'Industrie & logistique', immobilier: 'Promotion immobilière',
  terres: 'Terres agricoles', foret: 'Forêts & bois', friche: 'Friches', compensation: 'Compensation écologique', antenne: 'Antenne relais',
  chasse: 'Chasse, étangs & tourisme', autre: 'Autre / ne sait pas' };
const CRENEAUX = { matin: 'le matin (9 h – 12 h)', midi: 'le midi (12 h – 14 h)', 'apres-midi': "l'après-midi (14 h – 18 h)", soir: 'le soir (18 h – 20 h)' };

function projetsTxt(v) { return String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => PROJETS[x] || x).join(', '); }
function rappelTxt(v) {
  if (!v) return '';
  const [d, c] = String(v).split('|');
  let txt = '';
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    txt = new Date(d + 'T12:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
  }
  if (c) txt += (txt ? ', ' : '') + (CRENEAUX[c] || c);
  return txt;
}
const echeance = (iso) => new Date(new Date(iso || Date.now()).getTime() + 48 * 3600 * 1000).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
const dateHeure = (iso) => new Date(iso || Date.now()).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Paris' });
function lienCarte(a) {
  if (!a || !a.idus.length) return '';
  return `${SITE}/deposer-mon-terrain/?voir=${a.idus.join(',')}` + (a.bornes ? '&b=' + a.bornes.map((x) => x.toFixed(5)).join(',') : '');
}

/* ── Briques HTML (tableaux, styles en ligne pour tous les logiciels de messagerie) ── */
const cadre = (contenu, largeur = 680) => `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#EFEBE2;font-family:Arial,Helvetica,sans-serif;color:${NUIT}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEBE2"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${largeur}px;background:#fff;border-radius:6px;overflow:hidden">
<tr><td style="background:${NUIT};padding:18px 24px"><span style="font-family:Georgia,serif;font-size:20px;letter-spacing:2px;color:#fff">FONCIER STRATÉGIE</span><br><span style="font-size:10px;letter-spacing:3px;color:${OR}">CONSEIL &amp; VALORISATION</span></td></tr>
${contenu}
<tr><td style="background:${CREME};padding:14px 24px;font-size:11px;color:${GRIS}">Foncier Stratégie · <a href="${SITE}" style="color:${GRIS}">www.foncierstrategie.fr</a> · <a href="mailto:contact@foncierstrategie.fr" style="color:${GRIS}">contact@foncierstrategie.fr</a></td></tr>
</table></td></tr></table></body></html>`;
const bloc = (titre, html) => `<tr><td style="padding:18px 24px 4px"><div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${OR};font-weight:bold;border-bottom:1px solid ${LIGNE};padding-bottom:6px;margin-bottom:10px">${titre}</div>${html}</td></tr>`;
const ligne = (lib, val) => (val ? `<tr><td style="padding:4px 12px 4px 0;color:${GRIS};font-size:13px;white-space:nowrap;vertical-align:top">${lib}</td><td style="padding:4px 0;font-size:14px;vertical-align:top">${val}</td></tr>` : '');
const table = (lignes) => `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${lignes.join('')}</table>`;
const bouton = (href, txt) => `<a href="${href}" style="display:inline-block;background:${OR};color:${NUIT};text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:4px">${txt}</a>`;
const chiffre = (val, lib) => `<td style="padding:10px;border:1px solid ${LIGNE};background:${CREME};text-align:center;width:25%"><div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:${NUIT}">${val}</div><div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:${GRIS}">${lib}</div></td>`;

/* ── Fiche interne : dépôt de terrain ── */
function mailDepot(r, a, corr) {
  const nom = [r.prenom, r.nom].filter(Boolean).join(' ');
  const communes = a ? a.communes : [];
  const lieux = communes.map((c) => `${c.nom} (${c.depCode})`).join(', ');
  const carte = lienCarte(a);
  const sujet = `Terrain T-${r.id ?? '?'} — ${a && a.total ? surf(a.total) : (r.surface ? nb(r.surface) + ' ha' : 'sans parcelle')}${lieux ? ' · ' + lieux : ''} — ${nom}${r.societe ? ' (' + r.societe + ')' : ''}`;

  const recap = a && a.nombre
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse"><tr>${chiffre(surf(a.total), 'surface totale')}${chiffre(a.nombre, a.nombre > 1 ? 'parcelles' : 'parcelle')}${chiffre(a.nbIlots, a.nbIlots > 1 ? 'îlots' : 'îlot')}${chiffre(communes.length, communes.length > 1 ? 'communes' : 'commune')}</tr></table>`
    : `<p style="font-size:14px;margin:0">Aucune parcelle sélectionnée sur la carte${r.surface ? ' — surface indiquée : <b>' + nb(r.surface) + ' ha</b>' : ''}.</p>`;

  const detailCommunes = communes.map((c) => {
    const ilots = c.ilots.map((il, i) => {
      const ok = il.parcelles.filter((p) => !p.introuvable);
      if (!ok.length) return '';
      const refs = ok.map((p) => `<span style="white-space:nowrap">${esc(p.section)} ${esc(p.numero)} <span style="color:${GRIS}">(${surf(p.contenance)})</span></span>`).join(' · ');
      return `<tr><td width="90" style="width:90px;padding:6px 10px;border-top:1px solid ${LIGNE};font-size:13px;vertical-align:top;white-space:nowrap"><b>Îlot ${i + 1}</b><br><span style="color:${OR};font-weight:bold">${surf(il.m2)}</span></td><td style="padding:6px 10px;border-top:1px solid ${LIGNE};font-size:13px;line-height:1.7">${refs}</td></tr>`;
    }).join('');
    const introuvables = c.ilots.flatMap((il) => il.parcelles.filter((p) => p.introuvable));
    return `<div style="margin:0 0 14px;border:1px solid ${LIGNE};border-radius:4px;overflow:hidden">
<div style="background:${CREME};padding:8px 10px;font-size:14px"><b>${esc(c.nom)}</b> (${esc(c.depCode)}${c.depNom ? ' – ' + esc(c.depNom) : ''}) — ${pluriel(c.n - introuvables.length, 'parcelle')} — <b>${surf(c.m2)}</b>${c.ilots.filter((il) => il.m2 > 0).length > 1 ? ` — <span style="color:#A0522D">${pluriel(c.ilots.filter((il) => il.m2 > 0).length, 'îlot')} non contigus</span>` : ''}</div>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${ilots}</table>
${introuvables.length ? `<div style="padding:6px 10px;font-size:12px;color:#A0522D">Référence(s) non retrouvée(s) au cadastre : ${introuvables.map((p) => esc(p.idu)).join(', ')}</div>` : ''}</div>`;
  }).join('');

  const urba = a && a.urbanisme.length ? (() => {
    const docs = communes.map((c) => {
      const d = c.doc ? (a.DOCS[c.doc.du_type] || c.doc.du_type) : (c.rnu ? "RNU (règlement national d'urbanisme, pas de PLU)" : 'Document non publié sur le Géoportail');
      const lien = c.doc && c.doc.gpu_doc_id ? ` — <a href="https://www.geoportail-urbanisme.gouv.fr/document/by-id/${c.doc.gpu_doc_id}" style="color:${OR}">règlement</a>` : '';
      return `<div style="font-size:13px;margin:2px 0"><b>${esc(c.nom)}</b> : ${esc(d)}${lien}</div>`;
    }).join('');
    const lignesZ = a.urbanisme.map((u) => `<tr>
<td style="padding:6px 8px;border-top:1px solid ${LIGNE};font-size:13px">${esc(u.commune)}</td>
<td style="padding:6px 8px;border-top:1px solid ${LIGNE};font-size:13px;font-weight:bold">${u.code ? esc(u.code) : (communes.find((c) => c.insee === u.insee) || {}).rnu ? 'RNU' : '—'}</td>
<td style="padding:6px 8px;border-top:1px solid ${LIGNE};font-size:13px">${esc(u.typeLib || (u.code ? '' : "Règlement national d'urbanisme"))}${u.libelle && u.libelle.toLowerCase() !== String(u.typeLib).toLowerCase() ? '<br><span style="color:' + GRIS + '">' + esc(u.libelle) + '</span>' : ''}</td>
<td style="padding:6px 8px;border-top:1px solid ${LIGNE};font-size:13px;white-space:nowrap;text-align:right"><b>${surf(u.m2)}</b></td>
<td style="padding:6px 8px;border-top:1px solid ${LIGNE};font-size:12px;color:${GRIS}">${u.parcelles.map(esc).join(', ')}</td></tr>`).join('');
    return `${docs}<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin-top:10px;border-collapse:collapse">
<tr style="background:${CREME}"><th align="left" style="padding:6px 8px;font-size:11px;color:${GRIS}">Commune</th><th align="left" style="padding:6px 8px;font-size:11px;color:${GRIS}">Zone</th><th align="left" style="padding:6px 8px;font-size:11px;color:${GRIS}">Classification</th><th align="right" style="padding:6px 8px;font-size:11px;color:${GRIS}">Surface</th><th align="left" style="padding:6px 8px;font-size:11px;color:${GRIS}">Parcelles</th></tr>${lignesZ}</table>
<p style="font-size:11px;color:${GRIS};margin:8px 0 0">Source : Géoportail de l'Urbanisme. Surfaces par zone estimées, à vérifier sur le règlement en vigueur.</p>`;
  })() : '<p style="font-size:13px;color:' + GRIS + '">Zonage non disponible (aucune parcelle localisée).</p>';

  const contenu = `
<tr><td style="padding:22px 24px 6px"><div style="font-size:12px;color:${GRIS}">${esc(dateHeure(r.created_at))}</div>
<div style="font-family:Georgia,serif;font-size:24px;margin-top:4px">Nouveau dépôt de terrain <span style="font-size:15px;color:${GRIS}">· réf. T-${esc(r.id ?? '?')}</span></div></td></tr>
${blocCorrespondances(corr, 'depositions')}
${bloc('Récapitulatif', recap + (lieux ? `<p style="font-size:14px;margin:10px 0 0">📍 ${esc(lieux)}</p>` : '') + (r.projets ? `<p style="font-size:14px;margin:6px 0 0">🎯 ${esc(projetsTxt(r.projets))}</p>` : ''))}
${bloc('Contact', table([
    ligne('Nom', `<b>${esc(nom)}</b>`), ligne('Société', r.societe ? `<b>${esc(r.societe)}</b>` : ''),
    ligne('Téléphone', r.tel ? `<a href="tel:${esc(String(r.tel).replace(/[^\d+]/g, ''))}" style="color:${NUIT};font-weight:bold">${esc(r.tel)}</a>` : ''),
    ligne('E-mail', r.email ? `<a href="mailto:${esc(r.email)}" style="color:${NUIT}">${esc(r.email)}</a>` : ''),
    ligne('Qualité', esc(r.qualite)),
    ligne('À recontacter avant', `<b style="color:#A0522D">${esc(echeance(r.created_at))}</b>`),
    ligne('Surface déclarée', r.surface ? nb(r.surface) + ' ha' : '')
  ]))}
${r.message ? bloc('Message du prospect', `<div style="font-size:14px;line-height:1.6;background:${CREME};border-left:3px solid ${OR};padding:10px 12px">${nl2br(r.message)}</div>`) : ''}
${carte ? `<tr><td style="padding:16px 24px 4px">${bouton(carte, '🗺️ Voir les parcelles sur la carte')}</td></tr>` : ''}
${communes.length ? bloc('Terrain — détail par commune et par îlot', detailCommunes + (a.tronque ? '<p style="font-size:12px;color:#A0522D">Liste limitée aux 80 premières parcelles.</p>' : '')) : ''}
${r.description ? bloc('Précisions sur le terrain', `<div style="font-size:14px;line-height:1.6">${nl2br(r.description)}</div>`) : ''}
${bloc("Urbanisme — zones et classification du PLU", urba)}
${a && a.idus.length ? bloc('Références cadastrales (IDU)', `<div style="font-size:11px;color:${GRIS};font-family:Consolas,monospace;line-height:1.6">${a.idus.map(esc).join(' ')}</div>`) : ''}
<tr><td style="padding:10px"></td></tr>`;
  return { subject: sujet, html: cadre(contenu) };
}

/* ── Fiche interne : recherche de terrain (acquéreur / développeur) ── */
const MAITRISE = { achat: 'Achat', 'bail-emphyteotique': 'Bail emphytéotique', bail: 'Bail (autre)', fortage: 'Contrat de fortage', promesse: 'Promesse de bail / de vente' };
const HORIZON = { immediat: 'Immédiat', '6-mois': 'Moins de 6 mois', '1-an': "Moins d'un an", 'plus-1-an': "Plus d'un an", veille: 'Veille foncière' };
const PLU = { A: 'A (agricole)', N: 'N (naturelle)', U: 'U (urbaine)', AU: 'AU (à urbaniser)', ENR: 'Secteur ENR dédié', CC: 'Carte communale', RNU: 'RNU', indifferent: 'Peu importe' };
const COVIS = { 'sans-habitations': 'Pas de covisibilité avec les habitations', 'sans-patrimoine': 'Pas de covisibilité avec un monument ou site classé',
  aucune: 'Aucune covisibilité (habitations et patrimoine)', masquee: 'Acceptée si masquée (haies, relief)' };
const EXCLU = { inondable: 'Zone inondable', natura2000: 'Natura 2000 / ZNIEFF', humide: 'Zone humide', patrimoine: 'Abords de monument historique', boisement: 'Boisement' };
const BESOINS = { 'poids-lourds': 'Accès poids lourds', fibre: 'Fibre optique', eau: "Réseau d'eau", autoroute: 'Proche autoroute', ferroviaire: 'Embranchement ferroviaire' };
const traduire = (liste, dico) => (liste || []).map((x) => dico[x] || x).join(', ');
const objet = (v) => { if (!v) return {}; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (_) { return {}; } };
const nbZones = (r) => (objet(r.zones).features || []).length;
function lienZones(r) { return objet(r.criteres).lien_zones || ''; }
const dateCourte = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Paris' });

/* ── Rapprochements recherches ↔ terrains ── */
function blocCorrespondances(corr, table) {
  if (!corr) return '';
  const titre = table === 'depositions' ? 'Recherches correspondant à ce terrain' : 'Terrains déjà déposés correspondant à cette recherche';
  if (!corr.length) return bloc(titre, `<p style="font-size:13px;color:${GRIS};margin:0">Aucune correspondance pour l'instant${table === 'depositions' ? ' parmi les recherches enregistrées' : ' parmi les terrains déposés'}.</p>`);
  const lignes = corr.slice(0, 25).map((c) => {
    const ou = c.territoire ? 'secteur ' + c.territoire : c.zone ? `zone ${c.zone}${c.distance != null ? ' · à ' + nb(c.distance, 1) + ' km du centre' : ''}` : 'toute la France';
    if (table === 'depositions') {
      const r = c.recherche, nom = [r.prenom, r.nom].filter(Boolean).join(' ');
      return `<tr><td style="padding:7px 8px;border-top:1px solid ${LIGNE};font-size:13px;white-space:nowrap;vertical-align:top"><b>R-${esc(r.id)}</b><br><span style="color:${GRIS};font-size:11px">${esc(dateCourte(r.created_at))}</span></td>
<td style="padding:7px 8px;border-top:1px solid ${LIGNE};font-size:13px;line-height:1.5"><b>${esc(nom)}</b>${r.societe ? ' — ' + esc(r.societe) : ''}<br>${esc(projetsTxt(r.types_bien))}${r.surface_min ? ' · ≥ ' + surf(r.surface_min * 10000) : ''}<br><span style="color:${GRIS}">${esc(ou)}</span>
${r.email ? ` · <a href="mailto:${esc(r.email)}" style="color:${OR}">écrire</a>` : ''}${lienZones(r) ? ` · <a href="${esc(lienZones(r))}" style="color:${OR}">zones</a>` : ''}</td></tr>`;
    }
    const d = c.depot, t = c.terrain, nom = [d.prenom, d.nom].filter(Boolean).join(' ');
    const lien = t.idus.length ? `${SITE}/deposer-mon-terrain/?voir=${t.idus.join(',')}` : '';
    return `<tr><td style="padding:7px 8px;border-top:1px solid ${LIGNE};font-size:13px;white-space:nowrap;vertical-align:top"><b>T-${esc(d.id)}</b><br><span style="color:${GRIS};font-size:11px">${esc(dateCourte(d.created_at))}</span></td>
<td style="padding:7px 8px;border-top:1px solid ${LIGNE};font-size:13px;line-height:1.5"><b>${t.ha ? surf(t.ha * 10000) : 'surface ?'}</b>${t.communes.length ? ' · ' + esc(t.communes.join(', ')) : ''}<br>${esc(projetsTxt(d.projets))} — ${esc(nom)}${d.societe ? ' (' + esc(d.societe) + ')' : ''}<br><span style="color:${GRIS}">${esc(ou)}</span>${lien ? ` · <a href="${lien}" style="color:${OR}">carte</a>` : ''}</td></tr>`;
  }).join('');
  const plus = corr.length > 25 ? `<p style="font-size:12px;color:${GRIS};margin:6px 0 0">… et ${corr.length - 25} autre(s).</p>` : '';
  return bloc(`${titre} (${corr.length})`, `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#FFFBEF">${lignes}</table>${plus}`);
}

/* ── Fiche interne : recherche de terrain (acquéreur / développeur) ── */
function mailRecherche(r, corr) {
  const nom = [r.prenom, r.nom].filter(Boolean).join(' ');
  const c = objet(r.criteres), s = c.surface || {}, f = c.forme || {};
  const unite = s.unite === 'm2' ? ' m²' : ' ha';
  const surface = s.min || s.max ? (s.min ? 'au moins ' + nb(s.min) + unite : '') + (s.max ? (s.min ? ', ' : '') + 'au plus ' + nb(s.max) + unite : '')
    : (r.surface_min ? 'au moins ' + nb(r.surface_min) + ' ha' : '');
  const forme = f.type === 'dimensions' ? `Dimensions minimales ${nb(f.longueur_min_m || 0, 0)} m × ${nb(f.largeur_min_m || 0, 0)} m` : f.type === 'compacte' ? 'Forme compacte, régulière' : (f.type ? 'Peu importe' : esc(r.forme || ''));
  const zones = objet(r.zones).features || [];
  const lien = lienZones(r);
  const listeZones = zones.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${zones.map((z) => {
    const p = z.properties || {};
    const detail = p.rayon_km ? `rayon de <b>${nb(p.rayon_km, 1)} km</b> — centre ${p.centre[1].toFixed(5)}, ${p.centre[0].toFixed(5)}` : `surface ${nb(p.surface_km2 || 0, 1)} km²`;
    return `<tr><td style="padding:4px 10px 4px 0;vertical-align:top;width:26px"><span style="display:inline-block;width:22px;height:22px;line-height:22px;border-radius:11px;background:${OR};color:${NUIT};text-align:center;font-weight:bold;font-size:12px">${esc(p.n)}</span></td><td style="padding:4px 0;font-size:14px">${esc(p.libelle)}<br><span style="font-size:12px;color:${GRIS}">${detail}${p.idu ? ' — IDU ' + esc(p.idu) : ''}</span></td></tr>`;
  }).join('')}</table>` : `<p style="font-size:14px;margin:0">Aucune zone dessinée : <b>toute la France</b>${r.secteurs ? ' (voir secteurs)' : ''}.</p>`;
  const contenu = `
<tr><td style="padding:22px 24px 6px"><div style="font-size:12px;color:${GRIS}">${esc(dateHeure(r.created_at))}</div>
<div style="font-family:Georgia,serif;font-size:24px;margin-top:4px">Nouvelle recherche de terrain <span style="font-size:15px;color:${GRIS}">· réf. R-${esc(r.id ?? '?')}</span></div></td></tr>
${blocCorrespondances(corr, 'recherches')}
${bloc('Contact', table([
    ligne('Nom', `<b>${esc(nom)}</b>`), ligne('Société', r.societe ? `<b>${esc(r.societe)}</b>` : ''),
    ligne('Téléphone', r.tel ? `<a href="tel:${esc(String(r.tel).replace(/[^\d+]/g, ''))}" style="color:${NUIT};font-weight:bold">${esc(r.tel)}</a>` : ''),
    ligne('E-mail', r.email ? `<a href="mailto:${esc(r.email)}" style="color:${NUIT}">${esc(r.email)}</a>` : ''),
    ligne('Profil', esc(r.qualite)), ligne('À recontacter avant', `<b style="color:#A0522D">${esc(echeance(r.created_at))}</b>`)
  ]))}
${bloc('Projet', table([
    ligne('Types de terrain', `<b>${esc(projetsTxt(r.types_bien))}</b>`),
    ligne('Puissance visée', c.puissance_mw ? nb(c.puissance_mw) + ' MW' : ''),
    ligne('Maîtrise foncière', esc(MAITRISE[c.maitrise] || c.maitrise || '')),
    ligne('Horizon', esc(HORIZON[c.horizon] || c.horizon || ''))
  ]))}
${bloc('Surface et forme', table([ligne('Surface', esc(surface) || 'non précisée'), ligne('Forme', forme), ligne('Seul tenant', f.seul_tenant ? 'Oui, parcelles contiguës' : '')]))}
${bloc('Localisation', listeZones + table([
    ligne('Proche de', c.ville ? esc(c.ville.nom) + (c.ville.distance_km ? ' — moins de ' + nb(c.ville.distance_km, 1) + ' km' : '') : ''),
    ligne('Secteurs', esc(r.secteurs || c.secteurs || ''))
  ]) + (lien ? `<p style="margin:12px 0 0">${bouton(lien, '🗺️ Voir les zones sur la carte')}</p>` : ''))}
${bloc('Critères techniques et réglementaires', table([
    ligne('Poste source', c.distance_poste_km ? 'à moins de ' + nb(c.distance_poste_km, 1) + ' km' : ''),
    ligne('Pente', c.pente_max ? 'inférieure à ' + nb(c.pente_max, 0) + ' %' : ''),
    ligne('Zonage PLU', esc(traduire(c.zonages, PLU))),
    ligne('Covisibilité', esc(COVIS[c.covisibilite] || c.covisibilite || '')),
    ligne('Habitations', c.distance_habitations_m ? 'à plus de ' + nb(c.distance_habitations_m, 0) + ' m' : ''),
    ligne('À exclure', esc(traduire(c.exclusions, EXCLU))),
    ligne('Besoins', esc(traduire(c.besoins, BESOINS)))
  ]) || '<p style="font-size:13px;color:' + GRIS + '">Aucun critère particulier.</p>')}
${r.notes ? bloc('Commentaire', `<div style="font-size:14px;line-height:1.6;background:${CREME};border-left:3px solid ${OR};padding:10px 12px">${nl2br(r.notes)}</div>`) : ''}
<tr><td style="padding:10px"></td></tr>`;
  const ou = c.ville ? c.ville.nom : (zones[0] ? zones[0].properties.libelle.replace(/^Rayon autour (de la |d'un point à |de |d'un point)?/, '') : (r.secteurs || 'France'));
  return { subject: `Recherche R-${r.id ?? '?'} — ${projetsTxt(r.types_bien).split(',')[0]}${surface ? ', ' + surface.replace('au moins ', '≥ ') : ''} · ${ou} — ${nom}${r.societe ? ' (' + r.societe + ')' : ''}`, html: cadre(contenu) };
}

/* ── Accusés de réception envoyés au prospect ── */
function mailAccuse(r, a, type) {
  const civil = [r.prenom, r.nom].filter(Boolean).join(' ');
  const carte = type === 'depositions' ? lienCarte(a) : lienZones(r);
  const lieux = a && a.communes.length ? a.communes.map((c) => `${c.nom} (${c.depCode})`).join(', ') : '';
  const resume = type === 'depositions'
    ? (a && a.nombre ? `Votre demande concerne <b>${pluriel(a.nombre, 'parcelle')}</b> pour une surface totale de <b>${surf(a.total)}</b>${lieux ? (a.communes.length > 1 ? ' sur les communes de ' : ' sur la commune de ') + esc(lieux) : ''}.` : 'Nous avons bien reçu la description de votre terrain.')
    : `Votre recherche porte sur : <b>${esc(projetsTxt(r.types_bien)) || 'terrain'}</b>${r.surface_min ? ', ' + surf(r.surface_min * 10000) + ' minimum' : ''}${nbZones(r) ? ', sur ' + pluriel(nbZones(r), 'zone') + ' de recherche' : ''}. Elle est enregistrée sous la référence <b>R-${esc(r.id ?? '')}</b> : nous la rapprochons de chaque nouveau terrain proposé.`;
  const contenu = `
<tr><td style="padding:26px 28px 8px;font-size:15px;line-height:1.7">
<p style="margin:0 0 14px">Bonjour ${esc(civil)},</p>
<p style="margin:0 0 14px">Merci pour votre sollicitation. Nous avons bien reçu votre demande.</p>
<p style="margin:0 0 14px">${resume}</p>
<p style="margin:0 0 14px">Un conseiller Foncier Stratégie va l'étudier avec attention et vous recontactera dans les 48 heures.</p>
${carte ? `<p style="margin:0 0 18px">${bouton(carte, type === 'depositions' ? 'Revoir mes parcelles sur la carte' : 'Revoir mes zones de recherche')}</p>` : ''}
<p style="margin:0 0 14px">Vos informations restent strictement confidentielles. Pour toute question ou précision, il vous suffit de répondre à cet e-mail.</p>
<p style="margin:0">Bien cordialement,<br><b>L'équipe Foncier Stratégie</b><br><a href="mailto:contact@foncierstrategie.fr" style="color:${OR}">contact@foncierstrategie.fr</a></p>
</td></tr><tr><td style="padding:10px"></td></tr>`;
  return { subject: 'Nous avons bien reçu votre demande — Foncier Stratégie', html: cadre(contenu, 600) };
}

// ═════ principal.js ═════
// Point d'entrée de la fonction Supabase « swift-api », appelée par les webhooks des tables
// depositions et recherches à chaque nouveau formulaire.
// - envoie la fiche détaillée à contact@foncierstrategie.fr (réponse directe au prospect possible) ;
// - envoie un accusé de réception au prospect, une seule fois, après avoir vérifié que la demande
//   existe bien dans la base (la fonction ne peut donc pas servir à envoyer des e-mails à n'importe qui).

const DESTINATAIRE = 'contact@foncierstrategie.fr';
const EXPEDITEUR = 'Foncier Stratégie <noreply@foncierstrategie.fr>';
const FRAICHEUR_MAX = 30 * 60 * 1000;   // accusé envoyé seulement pour une demande de moins de 30 min

// Clé Resend : secret Supabase RESEND_API_KEY en priorité (Edge Functions → Secrets), sinon valeur historique
function cleResend() {
  const s = Deno.env.get('RESEND_API_KEY');
  return s ? 'Bearer ' + s : AUTORISATION_RESEND;
}

// Anti-abus : un seul accusé de réception par adresse e-mail et par 24 heures
async function accuseDejaEnvoye(table, email) {
  const url = Deno.env.get('SUPABASE_URL'), cle = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const depuis = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = await fetch(`${url}/rest/v1/${table}?email=ilike.${encodeURIComponent(email)}&accuse_envoye=is.true&created_at=gt.${encodeURIComponent(depuis)}&select=id&limit=1`,
    { headers: { apikey: cle, Authorization: `Bearer ${cle}` } });
  if (!r.ok) return true;          // en cas de doute, on n'envoie pas
  return (await r.json()).length > 0;
}

async function envoyerMail({ to, subject, html, reply_to }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': cleResend(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EXPEDITEUR, to, subject, html, reply_to })
  });
  if (!r.ok) console.error('Resend', r.status, await r.text());
  return r.ok;
}

// Relit la demande dans la base avec la clé de service (fournie automatiquement par Supabase)
async function relire(table, id) {
  const url = Deno.env.get('SUPABASE_URL'), cle = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !cle || id == null) return null;
  const r = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=*`, { headers: { apikey: cle, Authorization: `Bearer ${cle}` } });
  if (!r.ok) return null;
  const lignes = await r.json();
  return lignes[0] || null;
}
async function marquerAccuse(table, id) {
  const url = Deno.env.get('SUPABASE_URL'), cle = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { apikey: cle, Authorization: `Bearer ${cle}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ accuse_envoye: true })
  });
}
const emailValide = (e) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i.test(String(e || '').trim());

async function traiter(body) {
  const table = body.table;
  let rec = body.record || {};
  const enBase = (table === 'depositions' || table === 'recherches') ? await relire(table, rec.id) : null;
  if (enBase) rec = enBase;
  const recent = enBase && Date.now() - new Date(enBase.created_at).getTime() < FRAICHEUR_MAX;
  const replyProspect = emailValide(rec.email) ? String(rec.email).trim() : undefined;

  if (table === 'depositions') {
    let analyse = null;
    try {
      const parcelles = typeof rec.parcelles === 'string' ? JSON.parse(rec.parcelles || '[]') : (rec.parcelles || []);
      if (parcelles.length) analyse = await analyserParcelles(parcelles);
    } catch (e) { console.error('Analyse des parcelles', e); }
    let corr = null;
    try { corr = await recherchesPourTerrain(rec); } catch (e) { console.error('Rapprochement', e); }
    const fiche = mailDepot(rec, analyse, corr);
    await envoyerMail({ to: DESTINATAIRE, subject: fiche.subject, html: fiche.html, reply_to: replyProspect });
    if (recent && !enBase.accuse_envoye && replyProspect && !(await accuseDejaEnvoye(table, replyProspect))) {
      const acc = mailAccuse(rec, analyse, table);
      if (await envoyerMail({ to: replyProspect, subject: acc.subject, html: acc.html, reply_to: DESTINATAIRE })) await marquerAccuse(table, rec.id);
    }
    return;
  }
  if (table === 'recherches') {
    let corr = null;
    try { corr = await terrainsPourRecherche(rec); } catch (e) { console.error('Rapprochement', e); }
    const fiche = mailRecherche(rec, corr);
    await envoyerMail({ to: DESTINATAIRE, subject: fiche.subject, html: fiche.html, reply_to: replyProspect });
    if (recent && !enBase.accuse_envoye && replyProspect && !(await accuseDejaEnvoye(table, replyProspect))) {
      const acc = mailAccuse(rec, null, table);
      if (await envoyerMail({ to: replyProspect, subject: acc.subject, html: acc.html, reply_to: DESTINATAIRE })) await marquerAccuse(table, rec.id);
    }
    return;
  }
  // Autre table : ancien comportement (liste brute des champs)
  const lignes = Object.entries(rec).filter(([k]) => k !== 'id' && k !== 'created_at')
    .map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v ?? '—')}</td></tr>`).join('');
  await envoyerMail({ to: DESTINATAIRE, subject: `Nouveau formulaire — ${table}`, html: `<table>${lignes}</table>` });
}

serve(async (req) => {
  let body;
  try { body = await req.json(); } catch (_) { return new Response('requête invalide', { status: 400 }); }
  const tache = traiter(body).catch((e) => console.error('swift-api', e));
  // Répond tout de suite au webhook et termine l'analyse en arrière-plan
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(tache);
  else await tache;
  return new Response('ok');
});
