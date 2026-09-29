/* Outil « Déposer mon terrain » : recherche d'adresse ou de référence cadastrale, sélection de parcelles
   (clic, zone rectangulaire, liste de références), repère, partage, formulaire en 2 étapes,
   envoi dans Supabase (table depositions). */
(function () {
  'use strict';
  var CFG = window.FS_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var ZOOM_PARCELLES = 15;          // les parcelles IGN s'affichent à partir de ce zoom
  var CLE_STOCKAGE = 'fs-parcelles';
  var MAX_ZONE = 150;               // parcelles ajoutées au maximum par une sélection par zone

  var ORTHO = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  var PLAN = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  var PCI = 'https://data.geopf.fr/tms/1.0.0/PCI/{z}/{x}/{y}.pbf';
  var GEOCODE = 'https://data.geopf.fr/geocodage/search';
  var CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';

  var params = new URLSearchParams(location.search);
  var partage = (params.get('voir') || '').split(',').filter(function (s) { return /^[0-9A-Z]{14}$/.test(s); });
  var stocke = lire();
  var selection = partage.length ? [] : stocke;   // [{idu, commune, insee, section, numero, contenance, point}]
  var historique = [];
  var projets = new Set((params.get('projet') || '').split(',').filter(Boolean));
  var repere = null, repereMarker = null;
  var sansCarte = false;
  var map;

  /* ── Stockage local (facultatif) ── */
  function lire() { try { return JSON.parse(localStorage.getItem(CLE_STOCKAGE)) || []; } catch (e) { return []; } }
  function ecrire() { try { localStorage.setItem(CLE_STOCKAGE, JSON.stringify(selection)); } catch (e) {} }

  /* ── Formatage ── */
  function ha(m2) { return (m2 / 10000).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' ha'; }
  function surfaceTxt(m2) { return m2 >= 10000 ? ha(m2) : Math.round(m2).toLocaleString('fr-FR') + ' m²'; }
  function total() { return selection.reduce(function (s, p) { return s + (p.contenance || 0); }, 0); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ref(p) { return p.section.replace(/^0/, '') + ' ' + Number(p.numero); }

  var toastTimer;
  function toast(msg, duree) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, duree || 2600); }

  /* ── Sélection (avec annulation) ── */
  function memoriser() { historique.push(JSON.stringify(selection)); if (historique.length > 40) historique.shift(); }
  function indexDe(idu) { return selection.findIndex(function (x) { return x.idu === idu; }); }
  function depuisProps(p, point) {
    return { idu: p.idu, commune: p.nom_com, insee: p.code_insee || (p.code_dep + p.code_com), section: p.section, numero: p.numero,
      contenance: Number(p.contenance) || 0, point: point };
  }
  function ajouter(liste) {           // liste d'objets parcelle ; renvoie le nombre réellement ajouté
    var n = 0;
    liste.forEach(function (p) { if (p && p.idu && indexDe(p.idu) < 0) { selection.push(p); n++; } });
    return n;
  }

  /* ── Carte ── */
  function style() {
    return {
      version: 8,
      glyphs: 'https://data.geopf.fr/annexes/ressources/vectorTiles/fonts/{fontstack}/{range}.pbf',
      sources: {
        ortho: { type: 'raster', tiles: [ORTHO], tileSize: 256, maxzoom: 19, attribution: '© IGN' },
        plan: { type: 'raster', tiles: [PLAN], tileSize: 256, maxzoom: 19, attribution: '© IGN' },
        pci: { type: 'vector', tiles: [PCI], minzoom: 5, maxzoom: 17, attribution: 'Cadastre © DGFiP / IGN' }
      },
      layers: [
        { id: 'ortho', type: 'raster', source: 'ortho' },
        { id: 'plan', type: 'raster', source: 'plan', layout: { visibility: 'none' } },
        { id: 'communes', type: 'line', source: 'pci', 'source-layer': 'commune', minzoom: 10,
          paint: { 'line-color': '#FFFFFF', 'line-width': 1.4, 'line-opacity': 0.7, 'line-dasharray': [3, 2] } },
        { id: 'parc-fill', type: 'fill', source: 'pci', 'source-layer': 'parcelle', minzoom: ZOOM_PARCELLES,
          paint: { 'fill-color': '#FFFFFF', 'fill-opacity': 0.04 } },
        { id: 'parc-line', type: 'line', source: 'pci', 'source-layer': 'parcelle', minzoom: ZOOM_PARCELLES,
          paint: { 'line-color': '#FFB347', 'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 18, 1.6] } },
        { id: 'sel-fill', type: 'fill', source: 'pci', 'source-layer': 'parcelle', minzoom: 12,
          filter: ['in', ['get', 'idu'], ['literal', []]], paint: { 'fill-color': '#D4AF57', 'fill-opacity': 0.6 } },
        { id: 'sel-line', type: 'line', source: 'pci', 'source-layer': 'parcelle', minzoom: 12,
          filter: ['in', ['get', 'idu'], ['literal', []]], paint: { 'line-color': '#FFFFFF', 'line-width': 2.5 } },
        { id: 'num', type: 'symbol', source: 'pci', 'source-layer': 'localisant', minzoom: 17,
          layout: { 'text-field': ['to-string', ['to-number', ['get', 'numero']]], 'text-font': ['Source Sans Pro Bold Italic'], 'text-size': 12 },
          paint: { 'text-color': '#FFFFFF', 'text-halo-color': 'rgba(0,0,0,.75)', 'text-halo-width': 1.4 } },
        { id: 'nom-com', type: 'symbol', source: 'pci', 'source-layer': 'commune', minzoom: 10, maxzoom: 16,
          layout: { 'text-field': ['get', 'nom_com'], 'text-font': ['Source Sans Pro Bold Italic'], 'text-size': 14 },
          paint: { 'text-color': '#FFFFFF', 'text-halo-color': 'rgba(0,0,0,.8)', 'text-halo-width': 1.6 } }
      ]
    };
  }

  function initMap() {
    var c = (params.get('c') || '').split(',').map(Number);
    var aCentre = c.length === 2 && !isNaN(c[0]) && !isNaN(c[1]);
    var b = (params.get('b') || '').split(',').map(Number);
    var aBornes = b.length === 4 && b.every(function (x) { return !isNaN(x); });
    var mobile = window.matchMedia('(max-width:760px)').matches;
    var opts = { container: 'map', style: style(), center: aCentre ? c : [2.45, 46.6],
      zoom: Number(params.get('z')) || (aCentre ? 12 : (mobile ? 4.6 : 5)),
      maxZoom: 19.5, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false };
    if (aBornes) { opts.bounds = [[b[0], b[1]], [b[2], b[3]]]; opts.fitBoundsOptions = { padding: 80, maxZoom: 17.5 }; }
    map = new maplibregl.Map(opts);
    map.touchZoomRotate.disableRotation();
    majIndication();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, fitBoundsOptions: { maxZoom: 17 } }), 'top-right');
    map.on('load', function () {
      majFiltre(); majIndication();
      if (partage.length) chargerPartage();
      else if (selection.length && !aCentre && !aBornes) cadrerSelection(true);
    });
    map.on('zoomend', majIndication);
    map.on('click', clic);
    map.on('mousemove', 'parc-fill', function () { if (!modeZone) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'parc-fill', function () { if (!modeZone) map.getCanvas().style.cursor = ''; });
    map.on('error', function (e) { if (window.console) console.warn('Carte :', e && e.error && e.error.message); });
  }

  function majIndication() {
    var h = $('hint');
    if (!map) return;
    if (modeZone) h.textContent = '▭ Tracez un rectangle autour des parcelles à ajouter';
    else if (modeRepere) h.textContent = '📍 Centrez la carte sur votre terrain puis validez le repère';
    else if (map.getZoom() < ZOOM_PARCELLES) h.textContent = '🔍 Cherchez une adresse, une commune ou une référence (ex. ZB 12)';
    else h.textContent = selection.length ? '👆 Touchez d\'autres parcelles pour les ajouter ou les retirer' : '👆 Touchez une parcelle pour la sélectionner';
  }

  function clic(e) {
    if (modeZone || modeRepere || Date.now() - finZone < 500) return;
    if (map.getZoom() < ZOOM_PARCELLES) {
      map.easeTo({ center: e.lngLat, zoom: Math.max(ZOOM_PARCELLES + 1.5, map.getZoom() + 3), duration: 700 });
      return;
    }
    var f = map.queryRenderedFeatures(e.point, { layers: ['parc-fill'] })[0];
    if (!f) { toast('Aucune parcelle ici — touchez à l\'intérieur d\'un contour orange'); return; }
    var p = f.properties;
    memoriser();
    var i = indexDe(p.idu);
    if (i >= 0) { selection.splice(i, 1); toast('Parcelle retirée'); }
    else {
      ajouter([depuisProps(p, [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)])]);
      toast('✓ Parcelle ' + ref(p) + ' ajoutée — ' + surfaceTxt(Number(p.contenance) || 0));
    }
    maj();
  }

  function majFiltre() {
    if (!map || !map.getLayer('sel-fill')) return;
    var f = ['in', ['get', 'idu'], ['literal', selection.map(function (p) { return p.idu; })]];
    map.setFilter('sel-fill', f); map.setFilter('sel-line', f);
  }

  function bornes() {
    var b = new maplibregl.LngLatBounds();
    selection.forEach(function (p) { if (p.point) b.extend(p.point); });
    if (repere) b.extend(repere);
    return b;
  }
  function cadrerSelection(instantane) {
    var b = bornes();
    if (!b.isEmpty()) map.fitBounds(b, { padding: 120, maxZoom: 17, duration: instantane ? 0 : 700 });
  }

  /* ── Parcelles par référence (API Carto IGN) ── */
  function pointInterieur(geom) {       // point approximatif à l'intérieur (moyenne des sommets du plus grand anneau)
    var rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map(function (p) { return p[0]; });
    var r = rings.sort(function (a, b) { return b.length - a.length; })[0];
    var x = 0, y = 0; r.forEach(function (c) { x += c[0]; y += c[1]; });
    return [+(x / r.length).toFixed(6), +(y / r.length).toFixed(6)];
  }
  function parcelleParRef(insee, section, numero, comAbs) {
    var s = String(section).toUpperCase(); if (s.length === 1) s = '0' + s;
    var n = String(numero).replace(/\D/g, ''); while (n.length < 4) n = '0' + n;
    var u = CADASTRE + '?code_insee=' + insee + '&section=' + s + '&numero=' + n + (comAbs && comAbs !== '000' ? '&com_abs=' + comAbs : '');
    return fetch(u).then(function (r) { return r.json(); }).then(function (d) {
      var f = (d.features || [])[0];
      return f ? depuisProps(f.properties, pointInterieur(f.geometry)) : null;
    }).catch(function () { return null; });
  }
  function parcelleParIdu(idu) { return parcelleParRef(idu.slice(0, 5), idu.slice(8, 10), idu.slice(10, 14), idu.slice(5, 8)); }
  function communeAuCentre() {
    var c = map.getCenter();
    return fetch(CADASTRE + '?geom=' + encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: [c.lng, c.lat] })))
      .then(function (r) { return r.json(); })
      .then(function (d) { var f = (d.features || [])[0]; return f ? { insee: f.properties.code_insee, nom: f.properties.nom_com } : null; })
      .catch(function () { return null; });
  }
  function communeParNom(txt) {
    var t = txt.trim();
    if (/^\d[\dAB]\d{3}$/i.test(t)) return Promise.resolve({ insee: t.toUpperCase(), nom: t });
    return fetch(GEOCODE + '?index=address&type=municipality&limit=1&q=' + encodeURIComponent(t))
      .then(function (r) { return r.json(); })
      .then(function (d) { var f = (d.features || [])[0]; return f ? { insee: f.properties.citycode, nom: f.properties.city || f.properties.name } : null; })
      .catch(function () { return null; });
  }

  // Analyse une ligne : « ZB 12 », « ZB 12, 13 et 15 », « Pézenas ZB 12 », « 34199 ZB 12 » ou un IDU (14 caractères)
  var RE_REF = /(?:^|\s)([A-Z]{1,2}|0[A-Z])\s*[-.]?\s*(\d{1,4}(?:\s*(?:,|;|et|\/|-)\s*\d{1,4})*)\s*$/i;
  function analyserLigne(ligne) {
    var l = ligne.trim(); if (!l) return null;
    var idu = l.replace(/\s/g, '').toUpperCase();
    if (/^[0-9][0-9AB][0-9]{3}[0-9]{3}[0-9A-Z]{2}[0-9]{4}$/.test(idu)) return { idu: idu };
    var m = l.match(RE_REF); if (!m) return null;
    return { commune: l.slice(0, m.index).trim(), section: m[1].toUpperCase(), numeros: m[2].split(/\s*(?:,|;|et|\/|-)\s*/i).filter(Boolean) };
  }
  function estReference(txt) { var a = analyserLigne(txt); return !!a && (a.idu || !/[a-z]{3,}\s*$/i.test(txt)); }

  function ajouterReferences(lignes, communeDefaut) {
    var taches = [], introuvables = [];
    var cache = {};
    var trouverCommune = function (nom) {
      if (!nom) return communeDefaut ? Promise.resolve(communeDefaut) : (cache._centre = cache._centre || communeAuCentre());
      return (cache[nom] = cache[nom] || communeParNom(nom));
    };
    lignes.forEach(function (l) {
      var a = analyserLigne(l);
      if (!a) { if (l.trim()) introuvables.push(l.trim()); return; }
      if (a.idu) { taches.push(parcelleParIdu(a.idu).then(function (p) { if (!p) introuvables.push(a.idu); return p; })); return; }
      a.numeros.forEach(function (n) {
        taches.push(trouverCommune(a.commune).then(function (c) {
          if (!c) { introuvables.push(l.trim()); return null; }
          return parcelleParRef(c.insee, a.section, n).then(function (p) { if (!p) introuvables.push((c.nom || '') + ' ' + a.section + ' ' + n); return p; });
        }));
      });
    });
    return Promise.all(taches).then(function (ps) {
      memoriser();
      var n = ajouter(ps.filter(Boolean)); maj();
      if (n) cadrerSelection();
      return { ajoutees: n, introuvables: introuvables };
    });
  }

  function chargerPartage() {
    toast('Chargement des parcelles partagées…', 4000);
    Promise.all(partage.slice(0, 200).map(parcelleParIdu)).then(function (ps) {
      selection = ps.filter(Boolean); historique = [];
      maj(); $('panel').classList.add('open');
      if (!params.get('b')) cadrerSelection(true);
      toast(selection.length + ' parcelle' + (selection.length > 1 ? 's' : '') + ' — ' + ha(total()), 3500);
    });
  }

  /* ── Panneau de sélection ── */
  function maj() {
    if (!partage.length || selection.length) ecrire();
    majFiltre(); majIndication();
    var n = selection.length;
    $('nb').textContent = 'Parcelle' + (n > 1 ? 's' : '') + ' sélectionnée' + (n > 1 ? 's' : '') + ' : ' + n;
    $('surf').textContent = 'Superficie totale : ' + ha(total()) + (repere ? ' · 📍 repère placé' : '');
    $('valider').disabled = n === 0 && !repere;
    $('annuler').disabled = !historique.length;
    ['effacer', 'partager', 'copier'].forEach(function (id) { $(id).disabled = n === 0; });
    var l = $('liste');
    if (!n) { l.innerHTML = '<li class="c-empty">Touchez une parcelle sur la carte pour l\'ajouter</li>'; return; }
    l.innerHTML = selection.map(function (p, i) {
      return '<li><div><b>' + esc(p.commune) + ' — ' + esc(ref(p)) + '</b><small>' + surfaceTxt(p.contenance) + ' · réf. ' + esc(p.idu) + '</small></div>' +
        '<button type="button" aria-label="Retirer la parcelle" data-i="' + i + '">✕</button></li>';
    }).join('');
  }

  $('liste').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-i]'); if (!b) return;
    memoriser(); selection.splice(Number(b.dataset.i), 1); maj();
  });
  $('panelHead').addEventListener('click', function () {
    var p = $('panel'); p.classList.toggle('open');
    $('panelHead').setAttribute('aria-expanded', p.classList.contains('open'));
  });
  $('annuler').addEventListener('click', function () {
    if (!historique.length) return;
    selection = JSON.parse(historique.pop()); maj(); toast('Dernière action annulée');
  });
  var confirmEffacer;
  $('effacer').addEventListener('click', function () {
    var b = this;
    if (!b.classList.contains('confirm')) {
      b.classList.add('confirm'); b.querySelector('span').textContent = 'Confirmer ?';
      clearTimeout(confirmEffacer);
      confirmEffacer = setTimeout(function () { b.classList.remove('confirm'); b.querySelector('span').textContent = 'Effacer'; }, 3000);
      return;
    }
    clearTimeout(confirmEffacer); b.classList.remove('confirm'); b.querySelector('span').textContent = 'Effacer';
    memoriser(); selection = []; maj(); toast('Sélection effacée — « Annuler » pour la retrouver');
  });

  /* Partage : lien vers la carte avec les parcelles, et copie des références */
  function lienPartage() {
    var b = bornes(), u = location.origin + '/deposer-mon-terrain/?voir=' + selection.map(function (p) { return p.idu; }).join(',');
    if (!b.isEmpty()) u += '&b=' + [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (x) { return x.toFixed(5); }).join(',');
    return u;
  }
  function texteReferences() {
    return selection.map(function (p) { return p.commune + ' (' + p.insee + ') — section ' + p.section.replace(/^0/, '') + ' n° ' + Number(p.numero) + ' — ' + surfaceTxt(p.contenance) + ' — ' + p.idu; }).join('\n') +
      '\nTotal : ' + selection.length + ' parcelle(s), ' + ha(total());
  }
  function copier(txt, msg) {
    var ok = function () { toast(msg); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, function () { secoursCopie(txt, msg); });
    else secoursCopie(txt, msg);
  }
  function secoursCopie(txt, msg) {
    var t = document.createElement('textarea'); t.value = txt; t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast(msg); } catch (e) { toast('Copie impossible'); }
    t.remove();
  }
  $('partager').addEventListener('click', function () {
    var u = lienPartage(), titre = 'Mes parcelles — ' + selection.length + ' parcelle(s), ' + ha(total());
    if (navigator.share) navigator.share({ title: titre, text: titre, url: u }).catch(function () {});
    else copier(u, '🔗 Lien copié : envoyez-le à un proche ou à votre notaire');
  });
  $('copier').addEventListener('click', function () { copier(texteReferences(), '📋 Références cadastrales copiées'); });

  /* ── Sélection par zone (rectangle) ── */
  var modeZone = false, depart = null, finZone = 0, rect = $('zoneRect');
  function activerZone(on) {
    modeZone = on;
    $('zoneBtn').classList.toggle('actif', on);
    if (on) {
      if (map.getZoom() < ZOOM_PARCELLES) { map.easeTo({ zoom: ZOOM_PARCELLES + 0.5 }); }
      map.dragPan.disable(); map.getCanvas().style.cursor = 'crosshair';
    } else { map.dragPan.enable(); map.getCanvas().style.cursor = ''; rect.hidden = true; depart = null; }
    majIndication();
  }
  $('zoneBtn').addEventListener('click', function () { activerZone(!modeZone); });
  function posEvt(e) { var r = map.getCanvasContainer().getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  var cont = null;
  function brancherZone() {
    cont = map.getCanvasContainer();
    cont.addEventListener('pointerdown', function (e) {
      if (!modeZone) return;
      e.preventDefault(); depart = posEvt(e);
      try { cont.setPointerCapture(e.pointerId); } catch (x) {}
    });
    cont.addEventListener('pointermove', function (e) {
      if (!modeZone || !depart) return;
      var p = posEvt(e);
      rect.hidden = false;
      rect.style.left = Math.min(p[0], depart[0]) + 'px'; rect.style.top = Math.min(p[1], depart[1]) + 'px';
      rect.style.width = Math.abs(p[0] - depart[0]) + 'px'; rect.style.height = Math.abs(p[1] - depart[1]) + 'px';
    });
    cont.addEventListener('pointerup', function (e) {
      if (!modeZone || !depart) return;
      var p = posEvt(e), a = depart; depart = null; rect.hidden = true; finZone = Date.now();
      if (Math.abs(p[0] - a[0]) < 8 || Math.abs(p[1] - a[1]) < 8) return;
      if (map.getZoom() < ZOOM_PARCELLES) { toast('Zoomez davantage pour afficher les parcelles'); return; }
      var fs = map.queryRenderedFeatures([[Math.min(a[0], p[0]), Math.min(a[1], p[1])], [Math.max(a[0], p[0]), Math.max(a[1], p[1])]], { layers: ['parc-fill'] });
      var vus = {}, nouvelles = [];
      fs.forEach(function (f) {
        var pr = f.properties;
        if (vus[pr.idu] || indexDe(pr.idu) >= 0) return; vus[pr.idu] = 1;
        var ll = map.unproject([(a[0] + p[0]) / 2, (a[1] + p[1]) / 2]);
        nouvelles.push(depuisProps(pr, f.geometry ? pointInterieur(f.geometry) : [ll.lng, ll.lat]));
      });
      if (nouvelles.length > MAX_ZONE) { toast('Zone trop grande (' + nouvelles.length + ' parcelles) — réduisez le rectangle', 3500); return; }
      memoriser(); var n = ajouter(nouvelles); maj(); activerZone(false);
      toast(n ? '✓ ' + n + ' parcelle' + (n > 1 ? 's' : '') + ' ajoutée' + (n > 1 ? 's' : '') : 'Aucune nouvelle parcelle dans cette zone');
    });
  }

  /* ── Ajout par référence cadastrale (fenêtre) ── */
  function ouvrirRef() { $('refDlg').hidden = false; setTimeout(function () { $('refLignes').focus(); }, 50); }
  $('refBtn').addEventListener('click', ouvrirRef);
  $('refFermer').addEventListener('click', function () { $('refDlg').hidden = true; });
  $('refDlg').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
  $('refGo').addEventListener('click', function () {
    var b = this, lignes = $('refLignes').value.split(/\n+/), nomCommune = $('refCommune').value.trim();
    if (!lignes.join('').trim()) { $('refMsg').textContent = 'Indiquez au moins une référence, par exemple ZB 12.'; return; }
    b.disabled = true; b.textContent = 'Recherche…'; $('refMsg').textContent = '';
    (nomCommune ? communeParNom(nomCommune) : Promise.resolve(null)).then(function (c) {
      if (nomCommune && !c) throw new Error('Commune introuvable : ' + nomCommune);
      return ajouterReferences(lignes, c);
    }).then(function (r) {
      b.disabled = false; b.textContent = 'Ajouter ces parcelles';
      if (r.ajoutees) { if (!r.introuvables.length) { $('refDlg').hidden = true; $('refLignes').value = ''; } toast('✓ ' + r.ajoutees + ' parcelle(s) ajoutée(s)' + (r.introuvables.length ? ' — ' + r.introuvables.length + ' introuvable(s)' : ''), 3500); }
      if (r.introuvables.length) $('refMsg').textContent = 'Introuvable : ' + r.introuvables.join(' · ') + '. Vérifiez la commune (champ ci-dessus), la section et le numéro.';
      else if (!r.ajoutees) $('refMsg').textContent = 'Ces parcelles sont déjà dans votre sélection.';
    }).catch(function (e) { b.disabled = false; b.textContent = 'Ajouter ces parcelles'; $('refMsg').textContent = e.message; });
  });

  /* ── Je ne trouve pas mon terrain : repère sur la carte ── */
  var modeRepere = false;
  $('perdu').addEventListener('click', function () { $('perduDlg').hidden = false; });
  $('perduFermer').addEventListener('click', function () { $('perduDlg').hidden = true; });
  $('perduDlg').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
  $('perduRef').addEventListener('click', function () { $('perduDlg').hidden = true; ouvrirRef(); });
  $('perduSansCarte').addEventListener('click', function () { $('perduDlg').hidden = true; ouvrirForm(true); });
  $('perduRepere').addEventListener('click', function () {
    $('perduDlg').hidden = true; modeRepere = true;
    document.body.classList.add('mode-repere'); majIndication();
    if (map.getZoom() < 13) toast('Cherchez votre commune puis centrez la carte sur votre terrain', 3500);
  });
  $('repereOk').addEventListener('click', function () {
    var c = map.getCenter(); repere = [+c.lng.toFixed(6), +c.lat.toFixed(6)];
    if (repereMarker) repereMarker.remove();
    repereMarker = new maplibregl.Marker({ color: '#D4AF57' }).setLngLat(repere).addTo(map);
    modeRepere = false; document.body.classList.remove('mode-repere'); maj();
    toast('📍 Repère placé — vous pouvez valider');
  });
  $('repereAnnuler').addEventListener('click', function () { modeRepere = false; document.body.classList.remove('mode-repere'); majIndication(); });

  /* ── Recherche : adresse, commune ou référence cadastrale ── */
  var q = $('q'), res = $('results'), resultats = [], actif = -1, timer, ctrl;
  q.addEventListener('input', function () {
    $('qbox').classList.toggle('has-text', !!q.value);
    clearTimeout(timer);
    var v = q.value.trim();
    if (v.length < 3) { fermer(); return; }
    timer = setTimeout(function () { chercher(v); }, 220);
  });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { actif = Math.min(actif + 1, resultats.length - 1); dessiner(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { actif = Math.max(actif - 1, 0); dessiner(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (resultats.length) aller(resultats[Math.max(actif, 0)]); else if (q.value.trim()) chercher(q.value.trim(), true); }
    else if (e.key === 'Escape') fermer();
  });
  $('qclear').addEventListener('click', function () { q.value = ''; $('qbox').classList.remove('has-text'); fermer(); q.focus(); });
  document.addEventListener('click', function (e) { if (!e.target.closest('.c-search')) fermer(); });

  function chercher(v, allerAuPremier) {
    if (ctrl) ctrl.abort();
    ctrl = window.AbortController ? new AbortController() : null;
    var refItem = estReference(v) ? [{ reference: v }] : [];
    fetch(GEOCODE + '?autocomplete=1&limit=6&q=' + encodeURIComponent(v), ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (d) {
        resultats = refItem.concat(d.features || []); actif = resultats.length ? 0 : -1;
        if (allerAuPremier && resultats.length) aller(resultats[0]); else dessiner();
      }).catch(function () { resultats = refItem; if (refItem.length) dessiner(); });
  }
  var TYPES = { housenumber: 'Adresse', street: 'Voie', locality: 'Lieu-dit', municipality: 'Commune' };
  function dessiner() {
    if (!resultats.length) { res.innerHTML = '<li>Aucun résultat</li>'; res.classList.add('open'); return; }
    res.innerHTML = resultats.map(function (f, i) {
      if (f.reference) return '<li role="option" data-i="' + i + '" aria-selected="' + (i === actif) + '">📐 Parcelle ' + esc(f.reference) + '<small>Référence cadastrale</small></li>';
      var p = f.properties;
      return '<li role="option" data-i="' + i + '" aria-selected="' + (i === actif) + '">' + esc(p.label) + '<small>' + (TYPES[p.type] || '') + '</small></li>';
    }).join('');
    res.classList.add('open');
  }
  res.addEventListener('click', function (e) { var li = e.target.closest('li[data-i]'); if (li) aller(resultats[Number(li.dataset.i)]); });
  function fermer() { res.classList.remove('open'); }
  function aller(f) {
    fermer(); q.blur();
    if (f.reference) {
      toast('Recherche de la parcelle…');
      ajouterReferences([f.reference]).then(function (r) {
        if (r.ajoutees) toast('✓ Parcelle ajoutée à votre sélection');
        else if (r.introuvables.length) toast('Parcelle introuvable — précisez la commune, ex. « Pézenas ZB 12 »', 4000);
        else toast('Parcelle déjà sélectionnée');
      });
      return;
    }
    var z = { housenumber: 17.5, street: 16.5, locality: 16, municipality: 14 }[f.properties.type] || 16;
    map.flyTo({ center: f.geometry.coordinates, zoom: z, speed: 1.6 });
    q.value = f.properties.label;
  }

  /* ── Fond de carte ── */
  $('fondBtn').addEventListener('click', function () {
    var sat = map.getLayoutProperty('ortho', 'visibility') !== 'none';
    map.setLayoutProperty('ortho', 'visibility', sat ? 'none' : 'visible');
    map.setLayoutProperty('plan', 'visibility', sat ? 'visible' : 'none');
    map.setPaintProperty('parc-line', 'line-color', sat ? '#E0701B' : '#FFB347');
    this.querySelector('span').textContent = sat ? 'Satellite' : 'Plan';
  });

  /* ── Aide et reprise d'une sélection précédente ── */
  function aide(ouvrir) { $('help').hidden = !ouvrir; if (!ouvrir) { try { localStorage.setItem('fs-aide-vue', '1'); } catch (e) {} } }
  $('aideBtn').addEventListener('click', function () { aide(true); });
  $('helpOk').addEventListener('click', function () { aide(false); q.focus(); });
  $('help').addEventListener('click', function (e) { if (e.target === this) aide(false); });
  if (!partage.length && selection.length) {
    $('reprise').hidden = false;
    $('repriseTxt').textContent = 'Reprendre votre sélection de ' + selection.length + ' parcelle' + (selection.length > 1 ? 's' : '') + ' (' + ha(total()) + ') ?';
  } else if (!partage.length) { try { if (!localStorage.getItem('fs-aide-vue')) aide(true); } catch (e) { aide(true); } }
  $('repriseOui').addEventListener('click', function () { $('reprise').hidden = true; });
  $('repriseNon').addEventListener('click', function () { $('reprise').hidden = true; memoriser(); selection = []; maj(); });

  /* ── Formulaire (étapes 2 et 3) ── */
  var etape = 2;
  function ouvrirForm(sc) {
    sansCarte = !!sc || (!selection.length && !!repere);
    $('sansCarteFields').hidden = !(sansCarte && !repere);
    var communes = Array.from(new Set(selection.map(function (p) { return p.commune; })));
    $('recap').innerHTML = selection.length
      ? '<b>' + selection.length + ' parcelle' + (selection.length > 1 ? 's' : '') + '</b> · ' + ha(total()) + ' · ' + esc(communes.join(', '))
      : (repere ? '📍 Repère placé sur la carte. Précisez si possible les références cadastrales.' : 'Vous n\'avez pas sélectionné de parcelle : indiquez la commune et, si possible, les références cadastrales.');
    if (selection.length && !$('surface').value) $('surface').value = (total() / 10000).toFixed(2);
    montrer(2);
    $('form').classList.add('open'); $('form').setAttribute('aria-hidden', 'false');
  }
  function fermerForm() { $('form').classList.remove('open'); $('form').setAttribute('aria-hidden', 'true'); }
  function montrer(n) {
    etape = n;
    ['s2', 's3', 's4'].forEach(function (id) { $(id).classList.toggle('on', id === 's' + n); });
    $('stepLabel').textContent = n < 4 ? 'Étape ' + n + ' sur 3' : 'Terminé';
    $('stepTitle').textContent = { 2: 'Votre projet', 3: 'Vos coordonnées', 4: 'Demande envoyée' }[n];
    $('progress').style.width = { 2: '66%', 3: '90%', 4: '100%' }[n];
    $('formFoot').hidden = n === 4;
    $('next').textContent = n === 2 ? 'Continuer →' : 'Envoyer ma demande';
    $('err').className = 'msg'; $('formBody').scrollTop = 0;
  }
  $('valider').addEventListener('click', function () { ouvrirForm(false); });
  $('back').addEventListener('click', function () { if (etape === 3) montrer(2); else fermerForm(); });
  $('fin').addEventListener('click', function () { location.href = '/'; });

  // Date de rappel : pas avant aujourd'hui
  (function () { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); $('rappelDate').min = d.toISOString().slice(0, 10); })();

  document.querySelectorAll('#chips .chip').forEach(function (b) {
    if (projets.has(b.dataset.v)) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', function () {
      var on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      if (on) projets.delete(b.dataset.v); else projets.add(b.dataset.v);
    });
  });

  function erreur(msg) { var e = $('err'); e.innerHTML = msg; e.className = 'msg err'; e.scrollIntoView({ block: 'nearest' }); }
  function val(id) { return $(id).value.trim(); }

  $('next').addEventListener('click', function () {
    if (etape === 2) {
      if (sansCarte && !repere && !val('commune')) return erreur('Indiquez la commune de votre terrain.');
      return montrer(3);
    }
    if (!val('nom') || !val('prenom') || !val('tel') || !val('email')) return erreur('Merci de remplir les champs obligatoires (*).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val('email'))) return erreur('Adresse e-mail invalide.');
    if (!$('consent').checked) return erreur('Merci d\'accepter d\'être recontacté pour traiter votre demande.');
    if ($('hp').value) return montrer(4);
    envoyer();
  });

  function donnees() {
    var desc = val('description');
    if (sansCarte && !repere) desc = 'Commune : ' + val('commune') + (val('refs') ? ' — Références cadastrales : ' + val('refs') : '') + (desc ? '\n' + desc : '');
    if (repere) desc = '📍 Repère placé par le propriétaire : ' + location.origin + '/deposer-mon-terrain/?c=' + repere.join(',') + '&z=17' + (val('refs') ? ' — Références : ' + val('refs') : '') + (desc ? '\n' + desc : '');
    var rappel = val('rappelDate') ? val('rappelDate') + (val('rappelCreneau') ? '|' + val('rappelCreneau') : '') : (val('rappelCreneau') ? '|' + val('rappelCreneau') : '');
    return {
      nom: val('nom'), prenom: val('prenom'), tel: val('tel'), email: val('email'),
      qualite: $('qualite').value,
      surface: parseFloat(($('surface').value || '').replace(',', '.')) || null,
      description: desc,
      message: val('message') || null,
      date_rappel: rappel || null,
      projets: Array.from(projets).join(', '),
      parcelles: JSON.stringify(selection.map(function (p) {
        return { id: p.idu, commune: p.commune, insee: p.insee, section: p.section, numero: p.numero,
          surface: surfaceTxt(p.contenance), contenance_m2: p.contenance, point: p.point };
      }))
    };
  }

  function envoyer() {
    var b = $('next'); b.disabled = true; b.textContent = 'Envoi en cours…';
    var d = donnees();
    var fini = function () { b.disabled = false; };
    try {
      var db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
      db.from('depositions').insert(d).then(function (r) {
        fini();
        if (r.error) return secours(d, r.error.message);
        selection = []; historique = []; ecrire(); maj(); montrer(4);
      }, function (err) { fini(); secours(d, err && err.message); });
    } catch (err) { fini(); secours(d, err && err.message); }
  }

  // Si l'enregistrement échoue, on propose l'envoi par e-mail pour ne jamais perdre un contact.
  function secours(d, detail) {
    if (window.console) console.warn('Supabase :', detail);
    var corps = 'Nom : ' + d.prenom + ' ' + d.nom + '\nTéléphone : ' + d.tel + '\nE-mail : ' + d.email + '\nQualité : ' + d.qualite +
      '\nProjets : ' + d.projets + '\nSurface : ' + (d.surface || '') + ' ha\nRappel souhaité : ' + (d.date_rappel || '') +
      '\n\nMessage : ' + (d.message || '') + '\n\n' + d.description + '\n\nParcelles :\n' + texteReferences() + '\n\nCarte : ' + lienPartage();
    var href = 'mailto:' + CFG.email + '?subject=' + encodeURIComponent('Dépôt de terrain — ' + d.prenom + ' ' + d.nom) + '&body=' + encodeURIComponent(corps);
    erreur('L\'envoi automatique n\'a pas fonctionné. <a href="' + href + '"><b>Cliquez ici pour nous l\'envoyer par e-mail</b></a> (vos informations sont déjà remplies) ou écrivez-nous à ' + CFG.email + '.');
    $('next').textContent = 'Réessayer';
  }

  /* ── Démarrage ── */
  maj();
  if (window.maplibregl) { initMap(); brancherZone(); }
  else $('map').innerHTML = '<p style="color:#fff;padding:120px 24px;text-align:center">La carte n\'a pas pu se charger. Utilisez « Je ne trouve pas mon terrain » pour décrire votre bien.</p>';
})();
