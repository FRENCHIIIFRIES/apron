// Notices a new image on the clipboard (Win+Shift+S, Print Screen, "Copy image") so the
// notch can offer to save it or ask AI about it. Only the latest one is kept, in memory.
const crypto = require('crypto');

/** clipboard: Electron's; onShot({ thumb, width, height, at }). */
function screenshotWatcher(clipboard, onShot) {
  let lastHash = null;
  let latest = null; // NativeImage
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      // Cheap check first: most of the time there's no image at all.
      const formats = await Promise.resolve(clipboard.availableFormats());
      if (!(formats || []).some((f) => /^image\//.test(f))) {
        if (lastHash === null) lastHash = '';
        return;
      }
      // readImage may be sync or async depending on the Electron version.
      const img = await Promise.resolve(clipboard.readImage());
      if (!img || img.isEmpty()) {
        if (lastHash === null) lastHash = '';
        return;
      }
      const small = img.resize({ width: 48 });
      const hash = crypto.createHash('sha1').update(small.toBitmap()).digest('hex');
      if (lastHash === null) {
        lastHash = hash; // already there before Apron started
        return;
      }
      if (hash === lastHash) return;
      lastHash = hash;
      latest = img;
      const { width, height } = img.getSize();
      const thumb = img.resize(width >= height ? { width: 320 } : { height: 200 }).toDataURL();
      onShot({ thumb, width, height, at: Date.now() });
    } catch {
      // clipboard busy: next tick
    } finally {
      busy = false;
    }
  }, 1000);
  return {
    /** The latest image as JPEG base64 (for AI), or null. */
    jpeg() {
      if (!latest) return null;
      const { width, height } = latest.getSize();
      const scale = Math.min(1, 1568 / Math.max(width, height));
      return latest.resize({ width: Math.round(width * scale), height: Math.round(height * scale) }).toJPEG(85).toString('base64');
    },
    png: () => (latest ? latest.toPNG() : null),
    forget() {
      latest = null;
    },
    stop: () => clearInterval(timer),
  };
}

module.exports = { screenshotWatcher };
