/** Owns the decorative photo and the color exported to mobile browser chrome. */
export function initializeWallpaper() {
  const root = document.documentElement;
  const mobile = matchMedia('(max-width: 767px)');
  let image: HTMLImageElement | undefined;
  let disposed = false;
  let frame = 0;
  let loadGeneration = 0;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  const updateWallpaperColor = () => {
    const sharp = document.querySelector<HTMLElement>('.bg-sharp');
    const matte = document.querySelector<HTMLElement>('.bg-matte');
    if (!image || !context || !sharp || !matte || !mobile.matches
      || !root.dataset.theme?.startsWith('glass') || root.dataset.appSurface === 'auth') {
      root.style.removeProperty('--wallpaper-edge-color');
      return;
    }

    // iOS can fill the obscured status area from the page's solid background,
    // even though the photo covers every CSS pixel. Match that single-color
    // extension to the visible photo edge; it cannot carry an image/gradient.
    // Sample the actual cover crop and a Gaussian-weighted vertical band. Do
    // not use Canvas filter: it is unavailable in some supported Safari builds.
    const bounds = sharp.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const filter = getComputedStyle(sharp).filter;
    const blur = Number(filter.match(/blur\(([\d.]+)px\)/)?.[1] ?? 0);
    const brightness = Number(filter.match(/brightness\(([\d.]+)\)/)?.[1] ?? 1);
    const scale = Math.max(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
    const x = ((image.naturalWidth * scale - bounds.width) / 2 - bounds.left) / scale;
    const y = ((image.naturalHeight * scale - bounds.height) / 2 - bounds.top) / scale;
    const radius = Math.max(1, blur * 2);
    context.clearRect(0, 0, 32, 32);
    context.drawImage(image, x, y - radius / scale, innerWidth / scale, radius * 2 / scale, 0, 0, 32, 32);
    const pixels = context.getImageData(0, 0, 32, 32).data;
    const sums = [0, 0, 0];
    let weightSum = 0;
    for (let row = 0; row < 32; row += 1) {
      const weight = Math.exp(-.5 * ((row + .5 - 16) / 8) ** 2);
      for (let column = 0; column < 32; column += 1) {
        const offset = (row * 32 + column) * 4;
        for (let channel = 0; channel < 3; channel += 1) sums[channel]! += pixels[offset + channel]! * weight;
        weightSum += weight;
      }
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(matte, '::before').backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const tint = context.getImageData(0, 0, 1, 1).data;
    const alpha = tint[3]! / 255;
    const rgb = sums.map((sum, channel) => Math.round(sum / weightSum * brightness * (1 - alpha) + tint[channel]! * alpha));
    root.style.setProperty('--wallpaper-edge-color', `rgb(${rgb.join(', ')})`);
  };
  const updateCanvasColor = () => {
    updateWallpaperColor();
    // CSS owns the fallback and surface rules. Export that same resolved color
    // to browsers using theme-color instead of maintaining a second palette.
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', getComputedStyle(root).backgroundColor);
  };
  const scheduleUpdate = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(updateCanvasColor);
  };
  const observer = new MutationObserver(updateCanvasColor);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-app-surface', 'data-appearance-custom'] });
  window.addEventListener('resize', scheduleUpdate);
  window.addEventListener('pageshow', scheduleUpdate);

  const load = async (url: string): Promise<boolean> => {
    const request = ++loadGeneration;
    const photo = new Image();
    photo.src = url;
    try { await photo.decode(); } catch { return disposed || request !== loadGeneration; }
    // Superseded loads must not trigger a fallback over the newer custom photo.
    if (disposed || request !== loadGeneration) return true;
    root.style.setProperty('--bg-url', `url('${url}')`);
    image = photo;
    root.setAttribute('data-wallpaper-ready', '');
    // WebKit may retain pre-load edge pixels on a filtered fixed layer.
    const sharp = document.querySelector('.bg-sharp');
    sharp?.replaceWith(sharp.cloneNode(true));
    updateCanvasColor();
    return true;
  };
  root.removeAttribute('data-wallpaper-ready');
  updateCanvasColor();
  const url = `/bg-${Math.floor(Math.random() * 6) + 1}.jpg`;
  const changeWallpaper = (event: Event) => {
    const custom = (event as CustomEvent<{ url: string | null }>).detail.url;
    root.dataset.customWallpaper = String(Boolean(custom));
    void load(custom ?? url).then(loaded => { if (!loaded && !disposed) { root.dataset.customWallpaper = 'false'; void load('/bg-1.jpg'); } });
  };
  window.addEventListener('todograph-wallpaper', changeWallpaper);
  void load(url).then(async loaded => {
    if (!loaded && !disposed && url !== '/bg-1.jpg') await load('/bg-1.jpg');
  });

  return () => {
    disposed = true;
    observer.disconnect();
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('pageshow', scheduleUpdate);
    window.removeEventListener('todograph-wallpaper', changeWallpaper);
    root.style.removeProperty('--wallpaper-edge-color');
    root.removeAttribute('data-wallpaper-ready');
  };
}
