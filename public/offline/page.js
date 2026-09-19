// The little the downloaded game page does on its own: enlarge a picture, play the theme
// music. Everything else about the page is already in the HTML the server wrote.
//
// This runs from a folder on disk with no server behind it, so it is a plain script rather
// than a module (a module opened as file:// counts as cross-origin and won't load).

(() => {
  const lightbox = document.getElementById('lightbox');
  const stage = lightbox.querySelector('.lightbox-stage');
  const count = lightbox.querySelector('.lightbox-count');
  // Every picture that can be enlarged, in the order they appear on the page.
  const shots = [...document.querySelectorAll('[data-full]')];
  let index = 0;
  let opener = null;

  // Old games render at 320×200; scale those up with hard pixels rather than blur.
  const crisp = (img) => {
    const mark = () => { if (img.naturalWidth && img.naturalWidth <= 640) img.classList.add('pixelated'); };
    if (img.complete) mark();
    else img.addEventListener('load', mark, { once: true });
  };
  for (const img of document.querySelectorAll('.shots img')) crisp(img);

  function show() {
    const button = shots[index];
    const img = document.createElement('img');
    img.src = button.dataset.full;
    img.alt = button.dataset.label ?? '';
    crisp(img);
    stage.replaceChildren(img);
    for (const el of lightbox.querySelectorAll('.lightbox-nav, .lightbox-count')) el.hidden = shots.length < 2;
    count.textContent = shots.length < 2 ? '' : `${index + 1} of ${shots.length}`;
  }

  function open(at) {
    index = at;
    opener = document.activeElement;
    lightbox.hidden = false;
    show();
    lightbox.querySelector('.lightbox-close').focus();
  }

  function close() {
    lightbox.hidden = true;
    stage.replaceChildren();
    opener?.focus?.({ preventScroll: true });
    opener = null;
  }

  const step = (by) => {
    if (shots.length < 2) return;
    index = (index + by + shots.length) % shots.length;
    show();
  };

  shots.forEach((button, at) => button.addEventListener('click', () => open(at)));

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target.closest('.lightbox-close')) close();
    else if (e.target.closest('.lightbox-prev')) step(-1);
    else if (e.target.closest('.lightbox-next')) step(1);
  });

  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // The theme music, where the download has one.
  const music = document.getElementById('music');
  const button = document.getElementById('music-button');
  if (music && button) {
    button.addEventListener('click', () => {
      if (!music.paused) {
        music.pause();
        music.currentTime = 0;
      } else {
        music.play().catch(() => {});
      }
    });
    const paint = () => {
      button.textContent = music.paused ? 'Play music' : 'Stop music';
      button.setAttribute('aria-pressed', String(!music.paused));
    };
    for (const event of ['play', 'pause', 'ended']) music.addEventListener(event, paint);
    paint();
  }

  // The first video plays quietly on its own, the way the app's own game page does.
  const video = document.querySelector('.room-video');
  if (video) {
    video.muted = true;
    video.play().catch(() => {});
  }
})();
