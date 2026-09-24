/* Foncier Stratégie — menu mobile, animations, formulaire « Je recherche un terrain » */
(function () {
  'use strict';
  var burger = document.getElementById('burger'), drawer = document.getElementById('drawer');
  if (burger && drawer) {
    burger.addEventListener('click', function () {
      var open = drawer.classList.toggle('open');
      burger.setAttribute('aria-expanded', open);
      document.body.style.overflow = open ? 'hidden' : '';
    });
  }

  var els = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var o = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('visible'); o.unobserve(e.target); } }); }, { threshold: .1 });
    els.forEach(function (el) { o.observe(el); });
  } else els.forEach(function (el) { el.classList.add('visible'); });

  /* Formulaire acquéreurs (table Supabase « recherches ») */
  var form = document.getElementById('rechercheForm');
  if (!form) return;
  var choix = new Set();
  form.querySelectorAll('.chip').forEach(function (b) {
    b.addEventListener('click', function () {
      var on = b.getAttribute('aria-pressed') === 'true';
      b.setAttribute('aria-pressed', String(!on));
      if (on) choix.delete(b.dataset.v); else choix.add(b.dataset.v);
    });
  });
  var msg = document.getElementById('rMsg');
  function v(id) { return document.getElementById(id).value.trim(); }
  function info(t, ok) { msg.innerHTML = t; msg.className = 'msg ' + (ok ? 'ok' : 'err'); msg.scrollIntoView({ block: 'nearest' }); }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (document.getElementById('r_hp').value) return info('Merci, votre recherche a bien été envoyée.', true);
    if (!v('r_nom') || !v('r_prenom') || !v('r_tel') || !v('r_email')) return info('Merci de remplir les champs obligatoires (*).');
    if (!choix.size) return info('Sélectionnez au moins un type de terrain recherché.');
    if (!document.getElementById('r_consent').checked) return info('Merci d\'accepter d\'être recontacté.');
    var d = { nom: v('r_nom'), prenom: v('r_prenom'), tel: v('r_tel'), email: v('r_email'), societe: v('r_societe'),
      qualite: v('r_qualite'), surface_min: parseFloat(v('r_surface').replace(',', '.')) || null,
      types_bien: Array.from(choix).join(', '), notes: v('r_description'), parcelles: '[]' };
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    var cfg = window.FS_CONFIG;
    var secours = function () {
      btn.disabled = false;
      var corps = Object.keys(d).map(function (k) { return k + ' : ' + (d[k] == null ? '' : d[k]); }).join('\n');
      info('L\'envoi automatique n\'a pas fonctionné. <a href="mailto:' + cfg.email + '?subject=' + encodeURIComponent('Recherche de terrain') + '&body=' + encodeURIComponent(corps) + '"><b>Envoyez-la-nous par e-mail</b></a> (déjà remplie) ou écrivez à ' + cfg.email + '.');
    };
    try {
      window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey).from('recherches').insert(d).then(function (r) {
        if (r.error) return secours();
        form.reset(); choix.clear(); form.querySelectorAll('.chip').forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
        btn.disabled = false;
        info('<b>Recherche envoyée.</b> Nous revenons vers vous sous 48 h ouvrées.', true);
      }, secours);
    } catch (err) { secours(); }
  });
})();
