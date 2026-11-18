// Gemeinsamer Übersetzungs-Helfer für Dashboard/Overlay/Setup.
// Holt die Texte für die eingestellte Sprache und ersetzt sie in Elementen mit data-i18n-*.
// Fällt die Abfrage aus (z. B. Server noch nicht bereit), bleibt die Seite auf dem
// eingebauten deutschen Text stehen, der im HTML als Standardwert steht - nichts bricht.
(function () {
  'use strict';
  function apply(strings) {
    for (const el of document.querySelectorAll('[data-i18n]')) {
      const v = strings[el.getAttribute('data-i18n')];
      if (v != null) el.textContent = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
      const v = strings[el.getAttribute('data-i18n-html')];
      if (v != null) el.innerHTML = v;
    }
    for (const el of document.querySelectorAll('[data-i18n-ph]')) {
      const v = strings[el.getAttribute('data-i18n-ph')];
      if (v != null) el.setAttribute('placeholder', v);
    }
    for (const el of document.querySelectorAll('[data-i18n-aria]')) {
      const v = strings[el.getAttribute('data-i18n-aria')];
      if (v != null) el.setAttribute('aria-label', v);
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
      const v = strings[el.getAttribute('data-i18n-title')];
      if (v != null) el.setAttribute('title', v);
    }
  }
  async function run() {
    try {
      const res = await fetch('/api/i18n');
      if (!res.ok) return;
      const data = await res.json();
      window.__I18N__ = data.strings || {};
      if (data.lang) document.documentElement.lang = data.lang;
      apply(window.__I18N__);
      // Seiten, die Texte per Skript zeichnen, zeichnen danach neu (sonst bliebe dort der deutsche Standardtext).
      document.dispatchEvent(new Event('i18n-ready'));
    } catch { /* kein Netz/Server noch nicht bereit - Seite bleibt beim eingebauten Text */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
