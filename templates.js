// Versioned scene templates inspired by bold editorial App Store screenshot layouts.
const TEMPLATE_CATALOG_VERSION = 1;

const APP_TEMPLATES = [
  {
    id: 'violet-orbit-left', name: 'Violet Orbit', category: 'Bold Minimal', version: 1,
    palette: ['#5144F5', '#E9E8F7', '#FFFFFF'],
    background: { type: 'solid', solid: '#5144F5' },
    shapes: [{ type: 'ellipse', x: 78, y: 48, width: 116, height: 52, fill: '#E9E8F7', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 78, x: 62, y: 57, rotation: 8, perspective: 0 }],
    text: { position: 'top', offsetY: 6, blockX: 22, blockWidth: 36, align: 'left', headlineSize: 104, headlineWeight: '700', headlineColor: '#FFFFFF', subheadlineColor: '#FFFFFF' }
  },
  {
    id: 'lavender-stage-top', name: 'Lavender Stage', category: 'Bold Minimal', version: 1,
    palette: ['#E9E8F7', '#5144F5', '#17171B'],
    background: { type: 'solid', solid: '#E9E8F7' },
    shapes: [{ type: 'ellipse', x: 50, y: 78, width: 145, height: 52, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 72, x: 50, y: 57, rotation: 0, perspective: 0 }],
    text: { position: 'top', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 100, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'lavender-stage-bottom', name: 'Lavender Bottom', category: 'Bold Minimal', version: 1,
    palette: ['#E9E8F7', '#5144F5', '#17171B'],
    background: { type: 'solid', solid: '#E9E8F7' },
    shapes: [{ type: 'ellipse', x: 18, y: 24, width: 92, height: 44, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 76, x: 52, y: 40, rotation: 0, perspective: 0 }],
    text: { position: 'bottom', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 100, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'violet-spotlight', name: 'Violet Spotlight', category: 'Bold Minimal', version: 1,
    palette: ['#5144F5', '#E9E8F7', '#FFFFFF'],
    background: { type: 'solid', solid: '#5144F5' },
    shapes: [{ type: 'ellipse', x: -5, y: 50, width: 88, height: 56, fill: '#E9E8F7', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 70, x: 57, y: 54, rotation: -2, perspective: 0 }],
    text: { position: 'top', offsetY: 6, blockX: 50, blockWidth: 82, align: 'center', headlineSize: 100, headlineWeight: '700', headlineColor: '#FFFFFF', subheadlineColor: '#FFFFFF' }
  },
  {
    id: 'dual-device-cascade', name: 'Dual Cascade', category: 'Editorial', version: 1,
    palette: ['#E9E8F7', '#5144F5', '#17171B'],
    background: { type: 'solid', solid: '#E9E8F7' },
    shapes: [{ type: 'ellipse', x: 50, y: 10, width: 130, height: 45, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [
      { source: 'current', scale: 58, x: 34, y: 48, rotation: -5, perspective: 0, opacity: 92 },
      { source: 'current', scale: 64, x: 66, y: 57, rotation: 5, perspective: 0 }
    ],
    text: { position: 'bottom', offsetY: 6, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 96, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'split-library', name: 'Split Library', category: 'Editorial', version: 1,
    palette: ['#5144F5', '#E9E8F7', '#17171B'],
    background: { type: 'solid', solid: '#E9E8F7' },
    shapes: [{ type: 'rectangle', x: 25, y: 50, width: 50, height: 100, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 72, x: 56, y: 54, rotation: 0, perspective: 0 }],
    text: { position: 'top', offsetY: 6, blockX: 72, blockWidth: 46, align: 'center', headlineSize: 94, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  }
];
