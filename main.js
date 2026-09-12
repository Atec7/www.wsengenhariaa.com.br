let navInited = false;

function initNav() {
  if (navInited) return;
  navInited = true;
  const links = document.querySelector('.nav-links');
  const toggle = document.querySelector('.nav-toggle');
  const overlay = document.querySelector('.nav-overlay');
  if (!links || !toggle) return;

  function open() {
    links.classList.add('open');
    toggle.classList.add('active');
    if (overlay) overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    links.classList.remove('open');
    toggle.classList.remove('active');
    if (overlay) overlay.classList.remove('show');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', () => {
    links.classList.contains('open') ? close() : open();
  });
  if (overlay) overlay.addEventListener('click', close);
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', close));

  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

function initAccordions() {
  const heads = document.querySelectorAll('.acc-head');
  heads.forEach(head => {
    head.addEventListener('click', () => {
      const item = head.closest('.accordion-item');
      const body = item.querySelector('.acc-body');
      const isOpen = item.classList.contains('open');

      document.querySelectorAll('.accordion-item.open').forEach(o => {
        if (o !== item) {
          o.classList.remove('open');
          const ob = o.querySelector('.acc-body');
          if (ob) ob.style.maxHeight = null;
        }
      });

      if (isOpen) {
        item.classList.remove('open');
        body.style.maxHeight = null;
      } else {
        item.classList.add('open');
        body.style.maxHeight = body.scrollHeight + 'px';
      }
    });

    // Sincroniza abas abertas no HTML (classe "open")
    const item = head.closest('.accordion-item');
    if (item.classList.contains('open')) {
      const body = item.querySelector('.acc-body');
      if (body) body.style.maxHeight = body.scrollHeight + 'px';
    }
  });
}

function initCookieBanner() {
  if (localStorage.getItem('ws_cookie_ok')) return;
  const banner = document.getElementById('cookieConsent');
  if (!banner) return;
  banner.style.display = 'flex';
  const btn = document.getElementById('cookieConsentBtn');
  if (btn) btn.onclick = () => {
    localStorage.setItem('ws_cookie_ok', '1');
    banner.style.display = 'none';
  };
}

document.addEventListener('DOMContentLoaded', () => {
  initNav();
  if (typeof initAccordionOnly === 'undefined') initAccordions();
  initCookieBanner();
});
