/* Foncier Stratégie — menu mobile, animations, (formulaire de recherche : recherche.js) */
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

})();
