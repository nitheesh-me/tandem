// The page's only script: the Auto / Light / Dark switch, and the two recordings. The theme choice is kept in this
// browser only.
const KEY = 'tandem-site-theme';
const root = document.documentElement;
const buttons = document.querySelectorAll('.theme button');
function show(choice) {
  if (choice === 'auto') delete root.dataset.theme; else root.dataset.theme = choice;
  for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.set === choice));
}
let saved = 'auto';
try { saved = localStorage.getItem(KEY) || 'auto'; } catch {}
show(saved === 'light' || saved === 'dark' ? saved : 'auto');
for (const b of buttons) b.addEventListener('click', () => {
  show(b.dataset.set);
  try { if (b.dataset.set === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, b.dataset.set); } catch {}
});

// The recordings: each <img data-anim> shows a small still first. Once the page has loaded, and only when the
// visitor has not asked for reduced motion, the animated WebP is fetched as the still nears the screen, and it
// plays over it once it has arrived, so the first paint never waits on it.
const still = matchMedia('(prefers-reduced-motion: reduce)');
function animate(img) {
  if (still.matches || img.dataset.animated) return;
  img.dataset.animated = '1';
  // The recording goes over the still as its own picture, the same size, so the still stays the page's largest
  // paint and nothing moves.
  const next = new Image();
  next.decoding = 'async';
  next.alt = '';
  next.className = 'anim';
  next.width = img.width; next.height = img.height;
  next.setAttribute('aria-hidden', 'true');
  next.onload = () => img.after(next);
  next.src = img.dataset.anim;
}
function start() {
  const pics = document.querySelectorAll('img[data-anim]');
  if (!('IntersectionObserver' in window)) { pics.forEach(animate); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); animate(e.target); }
  }, { rootMargin: '400px 0px' });
  pics.forEach((p) => io.observe(p));
}
if (document.readyState === 'complete') start(); else addEventListener('load', start, { once: true });
