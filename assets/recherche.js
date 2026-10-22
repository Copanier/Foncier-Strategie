/* Page « Je recherche un terrain » : questionnaire détaillé, zones de recherche sur la carte
   (rayon autour d'un point, d'une parcelle ou d'une ville, zone dessinée), envoi dans Supabase (table recherches).
   Les zones sont enregistrées en GeoJSON pour être rapprochées des terrains déposés. */
(function () {
  'use strict';
  var form = document.getElementById('rechercheForm');
  if (!form) return;
  var CFG = window.FS_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var ORTHO = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  var PLAN = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  var PCI = 'https://data.geopf.fr/tms/1.0.0/PCI/{z}/{x}/{y}.pbf';
  var GEOCODE = 'https://data.geopf.fr/geocodage/search';
  var ZOOM_PARCELLES = 15;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(id) { var x = parseFloat(String($(id).value || '').replace(/\s/g, '').replace(',', '.')); return isFinite(x) ? x : null; }
  function v(id) { return $(id).value.trim(); }
  function r5(x) { return Math.round(x * 1e5) / 1e5; }
  function km(x) { return Number(x).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' km'; }

  /* ── Pastilles à choix multiples (types, PLU, exclusions, besoins) ── */
  var groupes = {};
  form.querySelectorAll('.chip[data-g]').forEach(function (b) {
    var g = b.dataset.g; groupes[g] = groupes[g] || new Set();
    b.addEventListener('click', function () {
      var on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      if (on) groupes[g].delete(b.dataset.v); else groupes[g].add(b.dataset.v);
    });
  });
  function choix(g) { return Array.from(groupes[g] || []); }

  /* ── Forme : dimensions minimales ── */
  form.querySelectorAll('input[name=r_forme]').forEach(function (r) {
    r.addEventListener('change', function () {
      var dim = form.querySelector('input[name=r_forme]:checked').value === 'dimensions';
      $('r_dims').hidden = !dim;
      if (dim && !$('r_long').value && !$('r_larg').value) { $('r_long').value = '70'; $('r_larg').value = '50'; }
    });
  });

  /* ── Zones ── */
  // { type: 'point' | 'parcelle' | 'ville' | 'polygone', centre: [lon, lat], rayon: km, nom, idu, ring: [[lon, lat]…] }
  var zones = [];
  var map, mode = null, trace = [], resultatLieu = null;

  function cercle(c, rkm, n) {
    n = n || 64;
    var kx = 111.32 * Math.cos(c[1] * Math.PI / 180), ky = 110.574, pts = [];
    for (var i = 0; i < n; i++) { var a = 2 * Math.PI * i / n; pts.push([r5(c[0] + rkm * Math.cos(a) / kx), r5(c[1] + rkm * Math.sin(a) / ky)]); }
    pts.push(pts[0]);
    return pts;
  }
  function centroide(ring) {
    var n = ring.length - 1, x = 0, y = 0;
    for (var i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
    return [r5(x / n), r5(y / n)];
  }
  function aire(ring) {                 // km², projection locale
    var lat = ring[0][1] * Math.PI / 180, kx = 111.32 * Math.cos(lat), ky = 110.574, s = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
    return Math.abs(s / 2);
  }
  function geometrie(z) { return { type: 'Polygon', coordinates: [z.type === 'polygone' ? z.ring : cercle(z.centre, z.rayon)] }; }
  function libelle(z) {
    if (z.type === 'polygone') return { t: 'Zone dessinée' + (z.nom ? ' — ' + z.nom : ''), s: Math.round(aire(z.ring)).toLocaleString('fr-FR') + ' km²' };
    var autour = z.type === 'parcelle' ? 'de la parcelle ' + (z.ref || z.idu) + (z.nom ? ' (' + z.nom + ')' : '')
      : z.type === 'ville' ? 'de ' + z.nom : (z.nom ? 'd\'un point à ' + z.nom : 'd\'un point');
    return { t: 'Rayon autour ' + autour, s: z.centre[1].toFixed(4) + ', ' + z.centre[0].toFixed(4) };
  }
  function geojson() {
    return { type: 'FeatureCollection', features: zones.map(function (z, i) {
      var p = { n: i + 1, type: z.type, libelle: libelle(z).t };
      if (z.type !== 'polygone') { p.centre = z.centre; p.rayon_km = z.rayon; } else p.surface_km2 = Math.round(aire(z.ring) * 10) / 10;
      if (z.idu) p.idu = z.idu;
      if (z.nom) p.nom = z.nom;
      if (z.insee) p.insee = z.insee;
      return { type: 'Feature', properties: p, geometry: geometrie(z) };
    }) };
  }
  // Lien court vers ces zones (utilisé dans l'e-mail et pour reprendre une recherche)
  function encoder() {
    var c = zones.map(function (z) { return z.type === 'polygone' ? ['g', z.ring.slice(0, -1), z.nom || ''] : [z.type[0], z.centre, z.rayon, z.nom || '', z.idu || '']; });
    return btoa(unescape(encodeURIComponent(JSON.stringify(c)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decoder(s) {
    try {
      var c = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
      return c.map(function (x) {
        if (x[0] === 'g') { var ring = x[1].concat([x[1][0]]); return { type: 'polygone', ring: ring, nom: x[2] || '' }; }
        return { type: { p: 'point', a: 'parcelle', v: 'ville' }[x[0]] || 'point', centre: x[1], rayon: Number(x[2]) || 10, nom: x[3] || '', idu: x[4] || '' };
      }).filter(function (z) { return z.type === 'polygone' ? z.ring.length >= 4 : z.centre && z.centre.length === 2; });
    } catch (e) { return []; }
  }

  function majCarte() {
    if (!map || !map.getSource('zones')) return;
    map.getSource('zones').setData({ type: 'FeatureCollection', features: zones.map(function (z, i) {
      return { type: 'Feature', properties: { n: String(i + 1) }, geometry: geometrie(z) };
    }) });
    map.getSource('centres').setData({ type: 'FeatureCollection', features: zones.map(function (z, i) {
      return { type: 'Feature', properties: { n: String(i + 1), c: z.centre ? 1 : 0 }, geometry: { type: 'Point', coordinates: z.centre || centroide(z.ring) } };
    }) });
    map.setFilter('sel-parc', ['in', ['get', 'idu'], ['literal', zones.filter(function (z) { return z.idu; }).map(function (z) { return z.idu; })]]);
  }
  function majListe() {
    var ul = $('rz_liste');
    ul.innerHTML = zones.map(function (z, i) {
      var l = libelle(z);
      return '<li data-i="' + i + '"><span class="rz-num">' + (i + 1) + '</span><span class="rz-txt">' + esc(l.t) + '<small>' + esc(l.s) + '</small></span>' +
        (z.type !== 'polygone' ? '<label>Rayon <input type="number" min="0.5" max="500" step="0.5" value="' + z.rayon + '" data-r="' + i + '" inputmode="decimal"> km</label>' : '') +
        '<button type="button" data-x="' + i + '" aria-label="Supprimer la zone ' + (i + 1) + '">✕</button></li>';
    }).join('');
  }
  function maj() { majCarte(); majListe(); }
  $('rz_liste').addEventListener('input', function (e) {
    var i = e.target.dataset.r; if (i == null) return;
    var r = parseFloat(String(e.target.value).replace(',', '.'));
    if (r > 0 && r <= 500) { zones[i].rayon = r; majCarte(); if (zones[i].type === 'ville') $('r_ville_km').value = r; }
  });
  $('rz_liste').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-x]');
    if (b) { var z = zones.splice(Number(b.dataset.x), 1)[0]; if (z === zoneVille) { zoneVille = null; } maj(); return; }
    var li = e.target.closest('li[data-i]');
    if (li && !e.target.closest('input,label') && map) cadrer([zones[Number(li.dataset.i)]]);
  });
  function ajouterZone(z) { zones.push(z); maj(); cadrer([z]); return z; }
  function rayonCourant() { var r = num('rz_rayon'); return r > 0 && r <= 500 ? r : 10; }
  function communeDe(c) {               // nom de la commune pour l'étiquette (facultatif)
    return fetch('https://geo.api.gouv.fr/communes?lat=' + c[1] + '&lon=' + c[0] + '&fields=nom,codeDepartement&limit=1')
      .then(function (r) { return r.json(); })
      .then(function (d) { return d && d[0] ? { nom: d[0].nom + ' (' + d[0].codeDepartement + ')', insee: d[0].code } : null; })
      .catch(function () { return null; });
  }
  function cadrer(liste) {
    if (!map || !liste.length) return;
    var b = new maplibregl.LngLatBounds();
    liste.forEach(function (z) { geometrie(z).coordinates[0].forEach(function (p) { b.extend(p); }); });
    map.fitBounds(b, { padding: 40, maxZoom: 14, duration: 600 });
  }

  /* ── Modes : point, parcelle, dessin ── */
  var hintTimer;
  function hint(t, duree) {
    $('rz_hint').textContent = t || ''; clearTimeout(hintTimer);
    if (t && duree) hintTimer = setTimeout(function () { $('rz_hint').textContent = ''; majHint(); }, duree);
  }
  function majHint() {
    if (mode === 'point') hint('Cliquez sur la carte pour placer le centre du rayon');
    else if (mode === 'parcelle') hint(map && map.getZoom() < ZOOM_PARCELLES ? 'Zoomez sur la commune pour afficher les parcelles' : 'Cliquez sur une parcelle');
    else if (mode === 'dessin') hint(trace.length < 3 ? 'Cliquez pour placer les sommets de la zone (' + trace.length + ')' : 'Continuez, ou « Terminer la zone » (double-clic)');
    else hint('');
  }
  function choisirMode(m) {
    if (mode === 'dessin' && m !== 'dessin') annulerTrace();
    mode = mode === m ? null : m;
    form.querySelectorAll('.rz-mode').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.mode === mode)); });
    $('rz_dessin').hidden = mode !== 'dessin';
    if (map) {
      map.getCanvas().style.cursor = mode ? 'crosshair' : '';
      if (mode === 'dessin') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
      if (mode === 'parcelle' && map.getZoom() < ZOOM_PARCELLES - 2 && zones.length === 0) hint('Recherchez la commune, puis zoomez pour afficher les parcelles', 4000);
    }
    $('rz_ici').hidden = true;
    majHint();
  }
  form.querySelectorAll('.rz-mode').forEach(function (b) { b.addEventListener('click', function () { choisirMode(b.dataset.mode); }); });

  function majTrace() {
    if (!map || !map.getSource('trace')) return;
    var f = [];
    if (trace.length > 1) f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: trace.length > 2 ? trace.concat([trace[0]]) : trace } });
    trace.forEach(function (p) { f.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }); });
    map.getSource('trace').setData({ type: 'FeatureCollection', features: f });
    majHint();
  }
  function annulerTrace() { trace = []; majTrace(); }
  function finirTrace() {
    if (trace.length < 3) { hint('Placez au moins 3 sommets', 2500); return; }
    var ring = trace.map(function (p) { return [r5(p[0]), r5(p[1])]; }); ring.push(ring[0]);
    var z = { type: 'polygone', ring: ring, nom: '' };
    trace = []; majTrace();
    zones.push(z); maj();
    var c = centroide(ring);
    communeDe(c).then(function (k) { if (k) { z.nom = 'secteur de ' + k.nom; majListe(); } });
    hint('✓ Zone ajoutée', 2500);
  }
  $('rz_finir').addEventListener('click', finirTrace);
  $('rz_annuler').addEventListener('click', annulerTrace);

  function pointInterieur(geom) {
    var rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map(function (p) { return p[0]; });
    var r = rings.sort(function (a, b) { return b.length - a.length; })[0], x = 0, y = 0;
    r.forEach(function (c) { x += c[0]; y += c[1]; });
    return [r5(x / r.length), r5(y / r.length)];
  }

  function clic(e) {
    var c = [r5(e.lngLat.lng), r5(e.lngLat.lat)];
    if (mode === 'point') {
      var z = ajouterZone({ type: 'point', centre: c, rayon: rayonCourant(), nom: '' });
      communeDe(c).then(function (k) { if (k) { z.nom = k.nom; z.insee = k.insee; majListe(); } });
      hint('✓ Zone ajoutée — modifiez le rayon dans la liste sous la carte', 3000);
    } else if (mode === 'parcelle') {
      if (map.getZoom() < ZOOM_PARCELLES) { hint('Zoomez davantage pour afficher les parcelles', 2500); return; }
      var f = map.queryRenderedFeatures(e.point, { layers: ['parc-fill'] })[0];
      if (!f) { hint('Aucune parcelle ici', 2000); return; }
      var p = f.properties;
      if (zones.some(function (x) { return x.idu === p.idu; })) { hint('Parcelle déjà utilisée', 2000); return; }
      ajouterZone({ type: 'parcelle', centre: pointInterieur(f.geometry), rayon: rayonCourant(), idu: p.idu,
        ref: String(p.section || '').replace(/^0/, '') + ' ' + Number(p.numero), nom: p.nom_com || '', insee: p.code_insee || '' });
      hint('✓ Parcelle ajoutée avec un rayon de ' + km(rayonCourant()), 3000);
    } else if (mode === 'dessin') {
      if (trace.length >= 3) {          // clic près du premier sommet : fermeture
        var a = map.project(trace[0]);
        if (Math.abs(a.x - e.point.x) < 12 && Math.abs(a.y - e.point.y) < 12) { finirTrace(); return; }
      }
      trace.push(c); majTrace();
    }
  }

  /* ── Carte ── */
  function initCarte() {
    if (!window.maplibregl) { $('rz_hint').textContent = 'La carte n\'a pas pu se charger : décrivez vos zones dans « Régions ou départements ciblés ».'; return; }
    map = new maplibregl.Map({
      container: 'rzMap', center: [2.6, 46.6], zoom: 5, maxZoom: 19, attributionControl: { compact: true },
      cooperativeGestures: true, locale: {
        'CooperativeGesturesHandler.WindowsHelpText': 'Ctrl + molette pour zoomer la carte',
        'CooperativeGesturesHandler.MacHelpText': '⌘ + molette pour zoomer la carte',
        'CooperativeGesturesHandler.MobileHelpText': 'Utilisez deux doigts pour déplacer la carte'
      },
      style: {
        version: 8,
        glyphs: 'https://data.geopf.fr/annexes/ressources/vectorTiles/fonts/{fontstack}/{range}.pbf',
        sources: {
          ortho: { type: 'raster', tiles: [ORTHO], tileSize: 256, maxzoom: 19, attribution: '© IGN' },
          plan: { type: 'raster', tiles: [PLAN], tileSize: 256, maxzoom: 19, attribution: '© IGN' },
          pci: { type: 'vector', tiles: [PCI], minzoom: 5, maxzoom: 17, attribution: 'Cadastre © DGFiP / IGN' },
          zones: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          centres: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          trace: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
        },
        layers: [
          { id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } },
          { id: 'plan', type: 'raster', source: 'plan' },
          { id: 'parc-fill', type: 'fill', source: 'pci', 'source-layer': 'parcelle', minzoom: ZOOM_PARCELLES, paint: { 'fill-color': '#FFFFFF', 'fill-opacity': 0.04 } },
          { id: 'parc-line', type: 'line', source: 'pci', 'source-layer': 'parcelle', minzoom: ZOOM_PARCELLES, paint: { 'line-color': '#E8901A', 'line-width': 0.8 } },
          { id: 'sel-parc', type: 'fill', source: 'pci', 'source-layer': 'parcelle', minzoom: 12, filter: ['in', ['get', 'idu'], ['literal', []]], paint: { 'fill-color': '#B8973A', 'fill-opacity': 0.7 } },
          { id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#B8973A', 'fill-opacity': 0.18 } },
          { id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': '#0F1E2D', 'line-width': 2, 'line-dasharray': [3, 1.5] } },
          { id: 'centres', type: 'circle', source: 'centres', filter: ['==', ['get', 'c'], 1], paint: { 'circle-radius': 5, 'circle-color': '#0F1E2D', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
          { id: 'zones-num', type: 'symbol', source: 'centres', layout: { 'text-field': ['get', 'n'], 'text-font': ['Source Sans Pro Bold'], 'text-size': 14, 'text-offset': [0, -1.1], 'text-allow-overlap': true },
            paint: { 'text-color': '#0F1E2D', 'text-halo-color': '#F0E4BB', 'text-halo-width': 2 } },
          { id: 'trace-line', type: 'line', source: 'trace', paint: { 'line-color': '#C0392B', 'line-width': 2.5 } },
          { id: 'trace-pts', type: 'circle', source: 'trace', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#C0392B', 'circle-stroke-width': 2 } }
        ]
      }
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('click', clic);
    map.on('dblclick', function (e) { if (mode === 'dessin') { e.preventDefault(); finirTrace(); } });
    map.on('zoomend', function () { if (mode === 'parcelle') majHint(); });
    map.on('load', function () { maj(); if (zones.length) cadrer(zones); });
  }

  $('rz_fond').addEventListener('click', function () {
    if (!map) return;
    var sat = map.getLayoutProperty('ortho', 'visibility') !== 'none';
    map.setLayoutProperty('ortho', 'visibility', sat ? 'none' : 'visible');
    map.setLayoutProperty('plan', 'visibility', sat ? 'visible' : 'none');
    $('rz_fond').textContent = sat ? 'Satellite' : 'Plan';
  });
  $('rz_fond').textContent = 'Satellite';

  /* ── Autocomplétion (recherche sur la carte et champ « ville ») ── */
  function autocomplete(input, liste, type, choisir) {
    var res = [], actif = -1, ctrl, timer;
    function fermer() { liste.classList.remove('open'); }
    function dessiner() {
      if (!res.length) { fermer(); return; }
      liste.innerHTML = res.map(function (f, i) {
        var p = f.properties;
        return '<li role="option" data-i="' + i + '" aria-selected="' + (i === actif) + '">' + esc(p.label) + '<small>' + esc(p.context || '') + '</small></li>';
      }).join('');
      liste.classList.add('open');
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var t = input.value.trim();
      if (t.length < 3) { res = []; fermer(); return; }
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        ctrl = window.AbortController ? new AbortController() : null;
        fetch(GEOCODE + '?autocomplete=1&limit=6' + (type ? '&index=address&type=' + type : '') + '&q=' + encodeURIComponent(t), ctrl ? { signal: ctrl.signal } : {})
          .then(function (r) { return r.json(); })
          .then(function (d) { res = d.features || []; actif = res.length ? 0 : -1; dessiner(); })
          .catch(function () {});
      }, 220);
    });
    input.addEventListener('keydown', function (e) {
      if (!liste.classList.contains('open')) return;
      if (e.key === 'ArrowDown') { actif = Math.min(actif + 1, res.length - 1); dessiner(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { actif = Math.max(actif - 1, 0); dessiner(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (res[actif]) { choisir(res[actif]); fermer(); } }
      else if (e.key === 'Escape') fermer();
    });
    liste.addEventListener('mousedown', function (e) { var li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choisir(res[Number(li.dataset.i)]); fermer(); } });
    input.addEventListener('blur', function () { setTimeout(fermer, 150); });
  }

  autocomplete($('rz_q'), $('rz_res'), null, function (f) {
    var p = f.properties;
    $('rz_q').value = p.label;
    if (!map) return;
    var z = { housenumber: 16, street: 15, locality: 15, municipality: 13 }[p.type] || 14;
    map.flyTo({ center: f.geometry.coordinates, zoom: mode === 'parcelle' ? Math.max(z, 15.5) : z, speed: 1.6 });
    resultatLieu = { centre: [r5(f.geometry.coordinates[0]), r5(f.geometry.coordinates[1])], nom: p.type === 'municipality' ? p.label + ' (' + String(p.citycode || '').slice(0, 2) + ')' : p.label, insee: p.citycode };
    if (mode !== 'parcelle' && mode !== 'dessin') {
      $('rz_ici').textContent = '＋ Rayon de ' + km(rayonCourant()) + ' autour de « ' + p.label + ' »';
      $('rz_ici').hidden = false;
    }
  });
  $('rz_ici').addEventListener('click', function () {
    if (!resultatLieu) return;
    ajouterZone({ type: 'point', centre: resultatLieu.centre, rayon: rayonCourant(), nom: resultatLieu.nom, insee: resultatLieu.insee });
    $('rz_ici').hidden = true;
  });
  $('rz_rayon').addEventListener('input', function () {
    if (!$('rz_ici').hidden && resultatLieu) $('rz_ici').textContent = '＋ Rayon de ' + km(rayonCourant()) + ' autour de « ' + $('rz_q').value + ' »';
  });

  // « Proche d'une ville » : crée (ou met à jour) une zone rayon autour de la ville choisie
  var villeChoisie = null, zoneVille = null;
  function majVille() {
    var d = num('r_ville_km');
    if (!villeChoisie || !(d > 0)) return;
    if (zoneVille && zones.indexOf(zoneVille) >= 0) { zoneVille.centre = villeChoisie.centre; zoneVille.nom = villeChoisie.nom; zoneVille.rayon = d; maj(); cadrer([zoneVille]); }
    else zoneVille = ajouterZone({ type: 'ville', centre: villeChoisie.centre, rayon: d, nom: villeChoisie.nom, insee: villeChoisie.insee });
  }
  autocomplete($('r_ville'), $('r_ville_res'), 'municipality', function (f) {
    var p = f.properties;
    villeChoisie = { centre: [r5(f.geometry.coordinates[0]), r5(f.geometry.coordinates[1])], nom: p.city + ' (' + String(p.citycode).slice(0, 2) + ')', insee: p.citycode };
    $('r_ville').value = villeChoisie.nom;
    if (!num('r_ville_km')) $('r_ville_km').value = '20';
    majVille();
  });
  $('r_ville_km').addEventListener('change', majVille);
  $('r_ville').addEventListener('input', function () {
    if (villeChoisie && $('r_ville').value.trim() !== villeChoisie.nom) {
      villeChoisie = null;
      if (zoneVille) { zones.splice(zones.indexOf(zoneVille), 1); zoneVille = null; maj(); }
    }
  });

  /* ── Communes, départements, régions ciblés : suggestions à la frappe, ajout / retrait en pastilles ── */
  var GEO = 'https://geo.api.gouv.fr';
  var territoires = [];             // { type: 'commune' | 'departement' | 'region', code, nom, dep?, deps? }
  var TYPES_T = { commune: 'Commune', departement: 'Département', region: 'Région' };
  function libT(t) { return t.type === 'commune' ? t.nom + ' (' + t.dep + ')' : t.type === 'departement' ? t.nom + ' (' + t.code + ')' : t.nom; }
  function majTerritoires() {
    $('r_terr_liste').innerHTML = territoires.map(function (t, i) {
      return '<span class="terr-item" data-t="' + t.type + '">' + esc(libT(t)) + '<small>' + TYPES_T[t.type] + '</small><button type="button" data-x="' + i + '" aria-label="Retirer ' + esc(libT(t)) + '">✕</button></span>';
    }).join('');
  }
  $('r_terr_liste').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-x]'); if (b) { territoires.splice(Number(b.dataset.x), 1); majTerritoires(); }
  });
  (function () {
    var input = $('r_terr'), liste = $('r_terr_res'), res = [], actif = -1, timer, jeton = 0;
    var json = function (u) { return fetch(u).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }); };
    function fermer() { liste.classList.remove('open'); }
    function dessiner() {
      if (!res.length) { liste.innerHTML = '<li aria-disabled="true">Aucun résultat</li>'; liste.classList.add('open'); return; }
      liste.innerHTML = res.map(function (t, i) {
        var deja = territoires.some(function (x) { return x.type === t.type && x.code === t.code; });
        return '<li role="option" data-i="' + i + '" aria-selected="' + (i === actif) + '">' + esc(libT(t)) + (deja ? ' ✓' : '') + '<small>' + TYPES_T[t.type] + '</small></li>';
      }).join('');
      liste.classList.add('open');
    }
    function chercher(q) {
      var n = ++jeton, code = q.toUpperCase().replace(/\s/g, '');
      var req = /^(\d{1,3}|2[AB])$/.test(code)
        ? [json(GEO + '/departements/' + (code.length === 1 ? '0' + code : code)).then(function (d) { return d && d.code ? [d] : []; }).then(function (l) { return l.map(function (d) { return { type: 'departement', code: d.code, nom: d.nom }; }); })]
        : [json(GEO + '/regions?nom=' + encodeURIComponent(q) + '&limit=3').then(function (l) { return l.map(function (r) { return { type: 'region', code: r.code, nom: r.nom }; }); }),
           json(GEO + '/departements?nom=' + encodeURIComponent(q) + '&limit=4').then(function (l) { return l.map(function (d) { return { type: 'departement', code: d.code, nom: d.nom }; }); }),
           json(GEO + '/communes?nom=' + encodeURIComponent(q) + '&fields=nom,code,codeDepartement&boost=population&limit=6').then(function (l) { return l.map(function (c) { return { type: 'commune', code: c.code, nom: c.nom, dep: c.codeDepartement }; }); })];
      Promise.all(req).then(function (r) {
        if (n !== jeton) return;
        res = [].concat.apply([], r).slice(0, 10); actif = res.length ? 0 : -1; dessiner();
      });
    }
    function choisir(t) {
      if (!t) return;
      input.value = ''; fermer(); input.focus();
      if (territoires.some(function (x) { return x.type === t.type && x.code === t.code; })) return;
      territoires.push(t); majTerritoires();
      if (t.type === 'region') json(GEO + '/regions/' + t.code + '/departements').then(function (l) { t.deps = l.map(function (d) { return d.code; }); });
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2 && !/^\d$/.test(q)) { fermer(); return; }
      timer = setTimeout(function () { chercher(q); }, 200);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !input.value && territoires.length) { territoires.pop(); majTerritoires(); return; }
      if (!liste.classList.contains('open')) { if (e.key === 'Enter') e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { actif = Math.min(actif + 1, res.length - 1); dessiner(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { actif = Math.max(actif - 1, 0); dessiner(); e.preventDefault(); }
      else if (e.key === 'Enter') { e.preventDefault(); choisir(res[actif]); }
      else if (e.key === 'Escape') fermer();
    });
    liste.addEventListener('mousedown', function (e) { var li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choisir(res[Number(li.dataset.i)]); } });
    input.addEventListener('blur', function () { setTimeout(fermer, 150); });
  })();

  /* ── Reprise d'une recherche partagée : ?z=… ── */
  var partage = new URLSearchParams(location.search).get('z');
  if (partage) zones = decoder(partage);
  majListe();
  initCarte();

  /* ── Envoi ── */
  var msg = $('rMsg');
  function info(t, ok) { msg.innerHTML = t; msg.className = 'msg ' + (ok ? 'ok' : 'err'); msg.scrollIntoView({ block: 'nearest' }); }
  function enHa(x) { return x == null ? null : ($('r_unite').value === 'm2' ? x / 10000 : x); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if ($('r_hp').value) return info('Merci, votre recherche a bien été envoyée.', true);
    if (!v('r_nom') || !v('r_prenom') || !v('r_tel') || !v('r_email')) return info('Merci de remplir les champs obligatoires (*).');
    if (!choix('types').length) return info('Sélectionnez au moins un type de terrain recherché.');
    if (!$('r_consent').checked) return info('Merci d\'accepter d\'être recontacté.');
    if (trace.length >= 3) finirTrace();
    var forme = form.querySelector('input[name=r_forme]:checked').value;
    var smin = num('r_smin'), smax = num('r_smax');
    var criteres = {
      version: 2,
      puissance_mw: num('r_puissance'), maitrise: v('r_maitrise') || null, horizon: v('r_horizon') || null,
      surface: { min: smin, max: smax, unite: $('r_unite').value, min_ha: enHa(smin), max_ha: enHa(smax) },
      forme: { type: forme, longueur_min_m: forme === 'dimensions' ? num('r_long') : null, largeur_min_m: forme === 'dimensions' ? num('r_larg') : null, seul_tenant: $('r_tenant').checked },
      ville: villeChoisie ? { nom: villeChoisie.nom, insee: villeChoisie.insee, centre: villeChoisie.centre, distance_km: num('r_ville_km') } : (v('r_ville') ? { nom: v('r_ville'), distance_km: num('r_ville_km') } : null),
      territoires: territoires.map(function (t) { var o = { type: t.type, code: t.code, nom: t.nom }; if (t.dep) o.dep = t.dep; if (t.deps) o.deps = t.deps; return o; }),
      secteurs: territoires.map(libT).join(', ') || null,
      distance_poste_km: num('r_poste'), pente_max: num('r_pente'),
      zonages: choix('plu'), covisibilite: v('r_covis') || null, distance_habitations_m: num('r_habit'),
      exclusions: choix('exclusions'), besoins: choix('besoins'),
      lien_zones: zones.length ? location.origin + location.pathname + '?z=' + encoder() : null
    };
    var formeTxt = forme === 'dimensions' ? 'min. ' + (num('r_long') || '?') + ' m × ' + (num('r_larg') || '?') + ' m' : forme === 'compacte' ? 'compacte' : 'peu importe';
    var d = {
      nom: v('r_nom'), prenom: v('r_prenom'), tel: v('r_tel'), email: v('r_email'), societe: v('r_societe'),
      qualite: v('r_qualite'), types_bien: choix('types').join(', '), notes: v('r_description'),
      surface_min: enHa(smin), surface_max: enHa(smax),
      puissance_mw: criteres.puissance_mw, maitrise: criteres.maitrise, horizon: criteres.horizon,
      forme: formeTxt + ($('r_tenant').checked ? ', d\'un seul tenant' : ''),
      ville: criteres.ville ? criteres.ville.nom + (criteres.ville.distance_km ? ' (< ' + criteres.ville.distance_km + ' km)' : '') : null,
      secteurs: criteres.secteurs, distance_poste_km: criteres.distance_poste_km, pente_max: criteres.pente_max,
      zonages: criteres.zonages.join(', ') || null, covisibilite: criteres.covisibilite,
      zones: geojson(), criteres: criteres,
      parcelles: JSON.stringify(zones.filter(function (z) { return z.idu; }).map(function (z) { return { id: z.idu, commune: z.nom, point: z.centre, rayon_km: z.rayon }; }))
    };
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Envoi en cours…';
    var secours = function () {
      btn.disabled = false; btn.textContent = 'Envoyer ma recherche';
      var corps = ['Nom : ' + d.prenom + ' ' + d.nom, 'Société : ' + d.societe, 'Tél : ' + d.tel, 'E-mail : ' + d.email, 'Types : ' + d.types_bien,
        'Surface : ' + (smin || '') + ' à ' + (smax || '') + ' ' + $('r_unite').value, 'Forme : ' + d.forme, 'Ville : ' + (d.ville || ''),
        'Secteurs : ' + (d.secteurs || ''), 'Poste source : ' + (d.distance_poste_km || '') + ' km', 'Pente max : ' + (d.pente_max || '') + ' %',
        'PLU : ' + (d.zonages || ''), 'Zones : ' + (criteres.lien_zones || 'aucune'), 'Précisions : ' + d.notes].join('\n');
      info('L\'envoi automatique n\'a pas fonctionné. <a href="mailto:' + CFG.email + '?subject=' + encodeURIComponent('Recherche de terrain') + '&body=' + encodeURIComponent(corps) + '"><b>Envoyez-la-nous par e-mail</b></a> (déjà remplie) ou écrivez à ' + CFG.email + '.');
    };
    try {
      var db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
      // Si la base n'a pas encore les nouvelles colonnes : envoi des champs historiques, critères résumés dans les notes
      var simple = { nom: d.nom, prenom: d.prenom, tel: d.tel, email: d.email, societe: d.societe, qualite: d.qualite, types_bien: d.types_bien,
        surface_min: d.surface_min, parcelles: d.parcelles, notes: (d.notes ? d.notes + '\n\n' : '') + '— Critères —\n' + JSON.stringify(criteres, null, 1) };
      db.from('recherches').insert(d).then(function (r) {
        return r.error && /column|colonne|schema/i.test(r.error.message || '') ? db.from('recherches').insert(simple) : r;
      }).then(function (r) {
        if (r.error) { console.error(r.error); return secours(); }
        form.reset(); Object.keys(groupes).forEach(function (g) { groupes[g].clear(); });
        form.querySelectorAll('.chip').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
        $('r_dims').hidden = true; territoires = []; majTerritoires(); zones = []; zoneVille = null; villeChoisie = null; maj(); choisirMode(null);
        btn.disabled = false; btn.textContent = 'Envoyer ma recherche';
        info('<b>Recherche enregistrée.</b> Nous la rapprochons dès maintenant des terrains proposés et revenons vers vous dans les 48 heures.', true);
      }, secours);
    } catch (err) { secours(); }
  });
})();
