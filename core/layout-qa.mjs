import { drawScreenshotToContext, drawTextToContext, getScreenshotGeometry } from './canvas-primitives.mjs';

// Full-resolution ink tests, but never full-resolution auxiliary canvases.
// Two reusable 256px tiles bound live mask buffers independently of export size.
const TILE_SIZE = 256;
const MIN_ALPHA = 16;
const MIN_CONTACT = 2; // Two opaque-pixel equivalents; ignore isolated antialias dust.

export function getDeviceBounds(dims, image, device) {
  const { imgWidth: width, imgHeight: height, centerX: cx, centerY: cy } = getScreenshotGeometry(dims, image, device);
  const frame = device.frame?.enabled && (device.frame.opacity ?? 100) > 0 ? device.frame.width * width / 400 : 0;
  const rotation = (device.rotation || 0) * Math.PI / 180, sine = Math.sin(rotation), cosine = Math.cos(rotation), shear = (device.perspective || 0) * 0.01;
  const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const u = x * (width / 2 + frame), v = y * (height / 2 + frame) + shear * u;
    return { x: cx + cosine * u - sine * v, y: cy + sine * u + cosine * v };
  });
  return { left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y)) };
}

export function measureTextBounds(context, dims, text) {
  const bounds = [];
  const measureOnly = new Proxy(context, {
    get(target, key) {
      if (key === 'fillRect') return (x, y, width, height) => {
        if (width && height) bounds.push({ left: Math.min(x, x + width), right: Math.max(x, x + width), top: Math.min(y, y + height), bottom: Math.max(y, y + height) });
      };
      if (key === 'fillText') return (copy, x, y) => {
        if (!copy.trim()) return;
        const m = target.measureText(copy);
        bounds.push({ left: x - m.actualBoundingBoxLeft, right: x + m.actualBoundingBoxRight, top: y - m.actualBoundingBoxAscent, bottom: y + m.actualBoundingBoxDescent });
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { return Reflect.set(target, key, value, target); },
  });
  context.save();
  try { drawTextToContext(measureOnly, dims, text); } finally { context.restore(); }
  return bounds;
}

// This checks main headline/subheadline ink and their decorations, not arbitrary
// element text or screenshot UI. Screenshot interiors count as a device even if
// the uploaded image has transparent pixels. Decorative shadows do not count.
export function createTextDeviceInspector(dims, text, textBounds) {
  let textCanvas, deviceCanvas;
  const makeCanvas = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE_SIZE;
    return canvas;
  };
  return {
    overlaps(image, device, deviceBounds = getDeviceBounds(dims, image, device)) {
      if (device.hidden || (device.opacity ?? 100) <= 0 || !textBounds.length) return false;
      // Broad phase: only visit tiles intersecting text ink bounds, the rotated
      // device's conservative bounds, and the visible scene. A tile is read once
      // even when several text/decorations share it.
      const tiles = new Set();
      for (const bounds of textBounds) {
        const left = Math.max(0, Math.floor(Math.max(bounds.left, deviceBounds.left)));
        const top = Math.max(0, Math.floor(Math.max(bounds.top, deviceBounds.top)));
        const right = Math.min(dims.width, Math.ceil(Math.min(bounds.right, deviceBounds.right)));
        const bottom = Math.min(dims.height, Math.ceil(Math.min(bounds.bottom, deviceBounds.bottom)));
        if (right <= left || bottom <= top) continue;
        for (let y = Math.floor(top / TILE_SIZE); y < Math.ceil(bottom / TILE_SIZE); y++) {
          for (let x = Math.floor(left / TILE_SIZE); x < Math.ceil(right / TILE_SIZE); x++) tiles.add(`${x},${y}`);
        }
      }
      if (!tiles.size) return false;
      textCanvas ||= makeCanvas(); deviceCanvas ||= makeCanvas();
      const ink = textCanvas.getContext('2d', { willReadFrequently: true });
      const silhouette = deviceCanvas.getContext('2d', { willReadFrequently: true });
      const shapeOnly = new Proxy(silhouette, {
        get(target, key) {
          // Keep the renderer's exact crop dimensions, rounded clip, shear,
          // rotation, frame stroke and opacity without reading source pixels.
          if (key === 'drawImage') return (_image, _sx, _sy, _sw, _sh, x, y, width, height) => {
            target.fillStyle = '#000'; target.fillRect(x, y, width, height);
          };
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, key, value) { return Reflect.set(target, key, value, target); },
      });
      let contact = 0;
      for (const tile of tiles) {
        const [column, row] = tile.split(',').map(Number), x = column * TILE_SIZE, y = row * TILE_SIZE;
        const width = Math.min(TILE_SIZE, dims.width - x), height = Math.min(TILE_SIZE, dims.height - y);
        ink.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        silhouette.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
        ink.save(); silhouette.save();
        try {
          ink.translate(-x, -y); silhouette.translate(-x, -y);
          drawTextToContext(ink, dims, text);
          silhouette.globalAlpha = (device.opacity ?? 100) / 100;
          drawScreenshotToContext(shapeOnly, dims, image, { ...device, shadow: { enabled: false } });
        } finally { ink.restore(); silhouette.restore(); }
        const textPixels = ink.getImageData(0, 0, width, height).data;
        const devicePixels = silhouette.getImageData(0, 0, width, height).data;
        for (let i = 3; i < textPixels.length; i += 4) {
          if (textPixels[i] < MIN_ALPHA || devicePixels[i] < MIN_ALPHA) continue;
          contact += textPixels[i] * devicePixels[i] / (255 * 255);
          if (contact >= MIN_CONTACT) return true;
        }
      }
      return false;
    },
    dispose() {
      // Release backing surfaces promptly in long export batches.
      if (textCanvas) textCanvas.width = textCanvas.height = 0;
      if (deviceCanvas) deviceCanvas.width = deviceCanvas.height = 0;
      textCanvas = deviceCanvas = undefined;
    },
  };
}
