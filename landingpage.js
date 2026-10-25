// Tells the inline head script that this file actually ran, so it keeps the
// reveal-ready class armed.
window.__revealInit = true;

const navbar = document.getElementById('navbar');
if (navbar) {
  const updateNavbar = () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
  };
  window.addEventListener('scroll', updateNavbar, { passive: true });
  updateNavbar();
}

// Mobile menu
function toggleMenu() {
  const menu = document.getElementById('mobile-menu');
  if (menu) menu.classList.toggle('open');
}

// Scroll reveal ---------------------------------------------------------------
// One-shot IntersectionObserver reveals. Every element is observed once, shown
// once, then unobserved. The reveal classes are stripped after the entrance so
// Tailwind's own hover transitions take over again.
function initScrollReveal() {
  const REVEAL_CLASSES = ['reveal', 'is-visible', 'reveal-delay-1', 'reveal-delay-2', 'reveal-delay-3', 'reveal-delay-4'];

  const strip = (el) => {
    REVEAL_CLASSES.forEach((name) => el.classList.remove(name));
    el.removeAttribute('data-reveal-item');
    el.style.removeProperty('--reveal-i');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
  };

  const els = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  if (!els.length) return;

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Stagger index per group: DOM order is left-to-right on desktop and
  // top-to-bottom once the grid stacks, which is the reading order either way.
  const groups = document.querySelectorAll('[data-reveal-group]');
  for (let g = 0; g < groups.length; g++) {
    const items = groups[g].querySelectorAll('[data-reveal-item]');
    for (let i = 0; i < items.length; i++) {
      items[i].style.setProperty('--reveal-i', String(Math.min(i, 6)));
    }
  }

  // No observer, or the visitor asked for less motion: everything is already
  // visible in CSS, so just drop the bookkeeping classes.
  if (prefersReduced || !('IntersectionObserver' in window)) {
    els.forEach(strip);
    return;
  }

  const settle = (el) => {
    if (el.classList.contains('is-visible')) return;
    el.classList.add('is-visible');

    let done = false;
    let fallback = 0;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(fallback);
      strip(el);
    };
    const onEnd = (event) => {
      if (event.target === el && event.propertyName === 'opacity') finish();
    };

    el.addEventListener('transitionend', onEnd);
    // Safety net in case transitionend never fires (background tab, interrupted
    // paint). 0.55s duration + up to 6 * 80ms of stagger.
    fallback = setTimeout(finish, 1600);
  };

  // threshold 0.15 is the whole trigger: the element has to be ~15% visible
  // before it animates. No negative bottom rootMargin, because a short footer
  // at the very end of the page could never reach it and would stay hidden.
  const observer = new IntersectionObserver((entries) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      settle(entry.target);
    }
  }, { threshold: 0.15 });

  els.forEach((el) => observer.observe(el));
}

document.addEventListener('DOMContentLoaded', () => {
  try {
    initScrollReveal();
  } catch (err) {
    // Never leave content hidden because the observer failed to start.
    document.documentElement.classList.remove('reveal-ready');
    document.querySelectorAll('.reveal').forEach((el) => {
      el.classList.remove('reveal', 'is-visible', 'reveal-delay-1', 'reveal-delay-2', 'reveal-delay-3', 'reveal-delay-4');
    });
  }
});
