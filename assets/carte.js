/* Outil « Déposer mon terrain » : recherche d'adresse, sélection de parcelles cadastrales (IGN),
   formulaire en 2 étapes, envoi dans Supabase (table depositions). */
(function () {
  'use strict';
  var CFG = window.FS_CONFIG;
  var $ = function (id) { return document.getElementById(id); };
  var ZOOM_PARCELLES = 15;          // les parcelles IGN s'affichent à partir de ce zoom
  var CLE_STOCKAGE = 'fs-parcelles';

  var ORTHO = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  var PLAN = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  var PCI = 'https://data.geopf.fr/tms/1.0.0/PCI/{z}/{x}/{y}.pbf';
  var GEOCODE = 'https://data.geopf.fr/geocodage/search';

  var params = new URLSearchParams(location.search);
  var selection = lire();              // [{idu, commune, insee, section, numero, contenance, point}]
  var projets = new Set((params.get('projet') || '').split(',').filter(Boolean));
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

  var toastTimer;
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600); }

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
        { id: 'sel-fill', type: 'fill', source: 'pci', 'source-layer': 'parcelle', minzoom: ZOOM_PARCELLES - 1,
          filter: ['in', ['get', 'idu'], ['literal', []]], paint: { 'fill-color': '#D4AF57', 'fill-opacity': 0.6 } },
        { id: 'sel-line', type: 'line', source: 'pci', 'source-layer': 'parcelle', minzoom: ZOOM_PARCELLES - 1,
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
    var centre = c.length === 2 && !isNaN(c[0]) && !isNaN(c[1]) ? c : [2.45, 46.6];
    var zoom = Number(params.get('z')) || (c.length === 2 ? 12 : 5);
    var mobile = window.matchMedia('(max-width:760px)').matches;
    map = new maplibregl.Map({
      container: 'map', style: style(), center: centre, zoom: mobile && !params.get('c') ? 4.6 : zoom,
      maxZoom: 19.5, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false
    });
    map.touchZoomRotate.disableRotation();
    majIndication();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, fitBoundsOptions: { maxZoom: 17 } }), 'top-right');
    map.on('load', function () { majFiltre(); majIndication(); if (selection.length && !params.get('c')) cadrerSelection(); });
    map.on('zoomend', majIndication);
    map.on('click', clic);
    map.on('mousemove', 'parc-fill', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'parc-fill', function () { map.getCanvas().style.cursor = ''; });
    map.on('error', function (e) { if (window.console) console.warn('Carte :', e && e.error && e.error.message); });
  }

  function majIndication() {
    var h = $('hint');
    if (!map) return;
    if (map.getZoom() < ZOOM_PARCELLES) { h.textContent = '🔍 Cherchez une adresse ou zoomez sur votre terrain'; }
    else { h.textContent = selection.length ? '👆 Touchez d\'autres parcelles pour les ajouter ou les retirer' : '👆 Touchez une parcelle pour la sélectionner'; }
  }

  function clic(e) {
    if (map.getZoom() < ZOOM_PARCELLES) {
      map.easeTo({ center: e.lngLat, zoom: Math.max(ZOOM_PARCELLES + 1.5, map.getZoom() + 3), duration: 700 });
      return;
    }
    var f = map.queryRenderedFeatures(e.point, { layers: ['parc-fill'] })[0];
    if (!f) { toast('Aucune parcelle ici — touchez à l\'intérieur d\'un contour orange'); return; }
    var p = f.properties;
    var i = selection.findIndex(function (x) { return x.idu === p.idu; });
    if (i >= 0) { selection.splice(i, 1); toast('Parcelle retirée'); }
    else {
      selection.push({ idu: p.idu, commune: p.nom_com, insee: p.code_insee, section: p.section, numero: p.numero,
        contenance: Number(p.contenance) || 0, point: [+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)] });
      toast('✓ Parcelle ' + p.section + ' ' + Number(p.numero) + ' ajoutée — ' + surfaceTxt(Number(p.contenance) || 0));
    }
    maj();
  }

  function majFiltre() {
    if (!map || !map.getLayer('sel-fill')) return;
    var f = ['in', ['get', 'idu'], ['literal', selection.map(function (p) { return p.idu; })]];
    map.setFilter('sel-fill', f); map.setFilter('sel-line', f);
  }

  function cadrerSelection() {
    var b = new maplibregl.LngLatBounds();
    selection.forEach(function (p) { if (p.point) b.extend(p.point); });
    if (!b.isEmpty()) map.fitBounds(b, { padding: 120, maxZoom: 17, duration: 0 });
  }

  /* ── Panneau de sélection ── */
  function maj() {
    ecrire(); majFiltre(); majIndication();
    var n = selection.length;
    $('nb').textContent = 'Parcelle' + (n > 1 ? 's' : '') + ' sélectionnée' + (n > 1 ? 's' : '') + ' : ' + n;
    $('surf').textContent = 'Superficie totale : ' + ha(total());
    $('valider').disabled = n === 0;
    var l = $('liste');
    if (!n) { l.innerHTML = '<li class="c-empty">Touchez une parcelle sur la carte pour l\'ajouter</li>'; return; }
    l.innerHTML = selection.map(function (p, i) {
      return '<li><div><b>' + esc(p.commune) + ' — ' + esc(p.section) + ' ' + Number(p.numero) + '</b><small>' + surfaceTxt(p.contenance) + ' · réf. ' + esc(p.idu) + '</small></div>' +
        '<button type="button" aria-label="Retirer la parcelle" data-i="' + i + '">✕</button></li>';
    }).join('');
  }

  $('liste').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-i]'); if (!b) return;
    selection.splice(Number(b.dataset.i), 1); maj();
  });
  $('panelHead').addEventListener('click', function () {
    var p = $('panel'); p.classList.toggle('open');
    $('panelHead').setAttribute('aria-expanded', p.classList.contains('open'));
  });

  /* ── Recherche d'adresse (Géoplateforme IGN) ── */
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
    fetch(GEOCODE + '?autocomplete=1&limit=6&q=' + encodeURIComponent(v), ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (d) {
        resultats = (d.features || []); actif = resultats.length ? 0 : -1;
        if (allerAuPremier && resultats.length) aller(resultats[0]); else dessiner();
      }).catch(function () {});
  }
  var TYPES = { housenumber: 'Adresse', street: 'Voie', locality: 'Lieu-dit', municipality: 'Commune' };
  function dessiner() {
    if (!resultats.length) { res.innerHTML = '<li>Aucun résultat</li>'; res.classList.add('open'); return; }
    res.innerHTML = resultats.map(function (f, i) {
      var p = f.properties;
      return '<li role="option" data-i="' + i + '" aria-selected="' + (i === actif) + '">' + esc(p.label) + '<small>' + (TYPES[p.type] || '') + '</small></li>';
    }).join('');
    res.classList.add('open');
  }
  res.addEventListener('click', function (e) { var li = e.target.closest('li[data-i]'); if (li) aller(resultats[Number(li.dataset.i)]); });
  function fermer() { res.classList.remove('open'); }
  function aller(f) {
    var z = { housenumber: 17.5, street: 16.5, locality: 16, municipality: 14 }[f.properties.type] || 16;
    map.flyTo({ center: f.geometry.coordinates, zoom: z, speed: 1.6 });
    q.value = f.properties.label; fermer(); q.blur();
  }

  /* ── Fond de carte ── */
  $('fondBtn').addEventListener('click', function () {
    var sat = map.getLayoutProperty('ortho', 'visibility') !== 'none';
    map.setLayoutProperty('ortho', 'visibility', sat ? 'none' : 'visible');
    map.setLayoutProperty('plan', 'visibility', sat ? 'visible' : 'none');
    map.setPaintProperty('parc-line', 'line-color', sat ? '#E0701B' : '#FFB347');
    this.querySelector('span').textContent = sat ? 'Satellite' : 'Plan';
  });

  /* ── Aide ── */
  function aide(ouvrir) { $('help').hidden = !ouvrir; if (!ouvrir) { try { localStorage.setItem('fs-aide-vue', '1'); } catch (e) {} } }
  $('aideBtn').addEventListener('click', function () { aide(true); });
  $('helpOk').addEventListener('click', function () { aide(false); q.focus(); });
  $('help').addEventListener('click', function (e) { if (e.target === this) aide(false); });
  try { if (!localStorage.getItem('fs-aide-vue')) aide(true); } catch (e) { aide(true); }

  /* ── Formulaire (étapes 2 et 3) ── */
  var etape = 2;
  function ouvrirForm(sc) {
    sansCarte = !!sc;
    $('sansCarteFields').hidden = !sansCarte;
    $('recap').innerHTML = sansCarte ? 'Vous n\'avez pas sélectionné de parcelle : indiquez la commune et, si possible, les références cadastrales.'
      : '<b>' + selection.length + ' parcelle' + (selection.length > 1 ? 's' : '') + '</b> · ' + ha(total()) + ' · ' +
        esc(Array.from(new Set(selection.map(function (p) { return p.commune; }))).join(', '));
    if (!sansCarte && !$('surface').value) $('surface').value = (total() / 10000).toFixed(2);
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
  $('sansCarte').addEventListener('click', function () { ouvrirForm(true); });
  $('back').addEventListener('click', function () { if (etape === 3) montrer(2); else fermerForm(); });
  $('fin').addEventListener('click', function () { location.href = '/'; });

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
      if (sansCarte && !val('commune')) return erreur('Indiquez la commune de votre terrain.');
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
    if (sansCarte) desc = 'Commune : ' + val('commune') + (val('refs') ? ' — Références cadastrales : ' + val('refs') : '') + (desc ? '\n' + desc : '');
    return {
      nom: val('nom'), prenom: val('prenom'), tel: val('tel'), email: val('email'),
      qualite: $('qualite').value,
      surface: parseFloat(($('surface').value || '').replace(',', '.')) || null,
      description: desc,
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
        selection = []; ecrire(); maj(); montrer(4);
      }, function (err) { fini(); secours(d, err && err.message); });
    } catch (err) { fini(); secours(d, err && err.message); }
  }

  // Si l'enregistrement échoue, on propose l'envoi par e-mail pour ne jamais perdre un contact.
  function secours(d, detail) {
    if (window.console) console.warn('Supabase :', detail);
    var corps = 'Nom : ' + d.prenom + ' ' + d.nom + '\nTéléphone : ' + d.tel + '\nE-mail : ' + d.email + '\nQualité : ' + d.qualite +
      '\nProjets : ' + d.projets + '\nSurface : ' + (d.surface || '') + ' ha\n\n' + d.description + '\n\nParcelles :\n' +
      selection.map(function (p) { return '- ' + p.commune + ' ' + p.section + ' ' + Number(p.numero) + ' (' + p.idu + ') ' + surfaceTxt(p.contenance); }).join('\n');
    var href = 'mailto:' + CFG.email + '?subject=' + encodeURIComponent('Dépôt de terrain — ' + d.prenom + ' ' + d.nom) + '&body=' + encodeURIComponent(corps);
    erreur('L\'envoi automatique n\'a pas fonctionné. <a href="' + href + '"><b>Cliquez ici pour nous l\'envoyer par e-mail</b></a> (vos informations sont déjà remplies) ou écrivez-nous à ' + CFG.email + '.');
    $('next').textContent = 'Réessayer';
  }

  /* ── Démarrage ── */
  maj();
  if (window.maplibregl) initMap();
  else $('map').innerHTML = '<p style="color:#fff;padding:120px 24px;text-align:center">La carte n\'a pas pu se charger. Utilisez « Je ne trouve pas mon terrain » pour décrire votre bien.</p>';
})();
