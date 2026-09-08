// Versioned scene templates inspired by bold editorial App Store screenshot layouts.
const TEMPLATE_CATALOG_VERSION = 9;
const TEMPLATE_BACKGROUND_COLOR = '#F4F1EA';

const TIDAL_DEVICE_STYLE = {
  cornerRadius: 32,
  frame: { enabled: true, color: '#172329', width: 14, opacity: 100 },
  shadow: { enabled: true, color: '#12333D', blur: 44, opacity: 34, x: 0, y: 22 }
};

function createTidalDevice(sourceOffset, centerX, centerY, scale, rotation, opacity = 100) {
  return {
    ...TIDAL_DEVICE_STYLE,
    frame: { ...TIDAL_DEVICE_STYLE.frame },
    shadow: { ...TIDAL_DEVICE_STYLE.shadow },
    sourceOffset,
    positionMode: 'canvas',
    centerX,
    centerY,
    scale,
    x: 50,
    y: 50,
    rotation,
    perspective: 0,
    opacity
  };
}

function createTemplateBackground(overrides = {}) {
  return {
    type: 'solid', solid: TEMPLATE_BACKGROUND_COLOR, image: null, imageSrc: null,
    imageFit: 'cover', imageBlur: 0, overlayColor: '#000000', overlayOpacity: 0,
    noise: false, noiseIntensity: 10,
    gradient: { angle: 168, stops: [{ color: TEMPLATE_BACKGROUND_COLOR, position: 0 }, { color: TEMPLATE_BACKGROUND_COLOR, position: 100 }] },
    ...overrides
  };
}

const TIDAL_MARKER_SETS = [
  [
    { type: 'ellipse', x: 18, y: 32, width: 5, height: 2.3, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 72 },
    { type: 'ellipse', x: 78, y: 20, width: 2.5, height: 1.2, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 55 }
  ],
  [
    { type: 'ellipse', x: 88, y: 22, width: 4, height: 1.8, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 60 },
    { type: 'ellipse', x: 15, y: 82, width: 2.5, height: 1.2, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 48 }
  ],
  [
    { type: 'ellipse', x: 26, y: 45, width: 5, height: 2.3, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 62 },
    { type: 'ellipse', x: 78, y: 62, width: 2.5, height: 1.2, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 50 }
  ]
];

function createTidalText(position) {
  return {
    position,
    offsetY: position === 'top' ? 7 : 6,
    blockX: 50,
    blockWidth: position === 'top' ? 84 : 82,
    align: 'center',
    headlineSize: 92,
    headlineWeight: '700',
    headlineColor: '#12333D',
    subheadlineColor: '#12333D'
  };
}

function createTidalVariant(definition, variantIndex) {
  const continuationCycle = definition.devices.map(devices => {
    const currentDevice = devices.find(device => (device.sourceOffset ?? 0) === 0);
    if (!currentDevice) return null;
    return {
      positionMode: 'canvas',
      centerX: currentDevice.centerX,
      centerY: currentDevice.centerY,
      scale: currentDevice.scale,
      x: currentDevice.x,
      y: currentDevice.y,
      rotation: currentDevice.rotation,
      perspective: currentDevice.perspective,
      opacity: currentDevice.opacity
    };
  }).filter(Boolean);
  const lastSceneIndex = definition.devices.length - 1;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    category: 'Tidal Sequences',
    type: 'sequence',
    version: 1,
    screenCount: 3,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#FFFFFF', '#12333D'],
    scenes: definition.devices.map((devices, sceneIndex) => ({
      background: createTemplateBackground(),
      shapes: TIDAL_MARKER_SETS[(sceneIndex + variantIndex) % TIDAL_MARKER_SETS.length].map(shape => ({ ...shape })),
      devices: devices.map(device => ({
        ...device,
        ...(sceneIndex === lastSceneIndex && (device.sourceOffset ?? 0) === 0
          ? {
              continueToNext: true,
              sequenceName: definition.name,
              continuationCycle,
              continuationStep: continuationCycle.length - 1,
              continuationTextPositions: [...definition.textPositions]
            }
          : {})
      })),
      text: createTidalText(definition.textPositions[sceneIndex])
    }))
  };
}

const TIDAL_POSITION_VARIANTS = [
  {
    id: 'tidal-low-tide',
    name: 'Low Tide',
    description: 'Low crops with generous headline space',
    textPositions: ['top', 'top', 'top'],
    devices: [
      [createTidalDevice(0, 0.87, 0.82, 78, 4)],
      [createTidalDevice(-1, -0.13, 0.82, 78, 4), createTidalDevice(0, 0.88, 0.81, 82, -5)],
      [createTidalDevice(-1, -0.12, 0.81, 82, -5), createTidalDevice(0, 0.76, 0.80, 76, 3)]
    ]
  },
  {
    id: 'tidal-high-tide',
    name: 'High Tide',
    description: 'High crops with an open footer',
    textPositions: ['bottom', 'bottom', 'bottom'],
    devices: [
      [createTidalDevice(0, 0.86, 0.23, 78, -4)],
      [createTidalDevice(-1, -0.14, 0.23, 78, -4), createTidalDevice(0, 0.86, 0.22, 84, 5)],
      [createTidalDevice(-1, -0.14, 0.22, 84, 5), createTidalDevice(0, 0.76, 0.25, 78, -3)]
    ]
  },
  {
    id: 'tidal-editorial-gate',
    name: 'Editorial Gate',
    description: 'Clean upright edge-to-edge framing',
    textPositions: ['top', 'top', 'top'],
    devices: [
      [createTidalDevice(0, 0.92, 0.65, 86, 0)],
      [createTidalDevice(-1, -0.08, 0.65, 86, 0), createTidalDevice(0, 1.08, 0.65, 86, 0)],
      [createTidalDevice(-1, 0.08, 0.65, 86, 0), createTidalDevice(0, 0.84, 0.72, 72, 0)]
    ]
  },
  {
    id: 'tidal-counterflow',
    name: 'Counterflow',
    description: 'Mirrored angles create a lively zigzag',
    textPositions: ['bottom', 'top', 'bottom'],
    devices: [
      [createTidalDevice(0, 0.86, 0.30, 80, 13)],
      [createTidalDevice(-1, -0.14, 0.30, 80, 13), createTidalDevice(0, 0.84, 0.74, 82, -13)],
      [createTidalDevice(-1, -0.16, 0.74, 82, -13), createTidalDevice(0, 0.86, 0.30, 78, 13)]
    ]
  },
  {
    id: 'tidal-rising-current',
    name: 'Rising Current',
    description: 'Alternating low-to-high sweep',
    textPositions: ['top', 'bottom', 'top'],
    devices: [
      [createTidalDevice(0, 0.86, 0.75, 84, -7)],
      [createTidalDevice(-1, -0.14, 0.75, 84, -7), createTidalDevice(0, 0.82, 0.27, 84, 8)],
      [createTidalDevice(-1, -0.18, 0.27, 84, 8), createTidalDevice(0, 0.92, 0.74, 78, -22)]
    ]
  },
  {
    id: 'tidal-falling-ribbon',
    name: 'Falling Ribbon',
    description: 'A high-to-low diagonal rhythm',
    textPositions: ['bottom', 'top', 'bottom'],
    devices: [
      [createTidalDevice(0, 0.84, 0.29, 82, 8)],
      [createTidalDevice(-1, -0.16, 0.29, 82, 8), createTidalDevice(0, 0.86, 0.76, 86, -9)],
      [createTidalDevice(-1, -0.14, 0.76, 86, -9), createTidalDevice(0, 0.88, 0.28, 80, 12)]
    ]
  },
  {
    id: 'tidal-monument-relay',
    name: 'Monument Relay',
    description: 'Bold upright repetition',
    textPositions: ['top', 'top', 'top'],
    devices: [
      [createTidalDevice(0, 0.80, 0.69, 92, 0)],
      [createTidalDevice(-1, -0.20, 0.69, 92, 0), createTidalDevice(0, 0.80, 0.69, 92, 0)],
      [createTidalDevice(-1, -0.20, 0.69, 92, 0), createTidalDevice(0, 0.72, 0.68, 82, 0)]
    ]
  },
  {
    id: 'tidal-centerline',
    name: 'Centerline Handoff',
    description: 'Precise half-device seam treatment',
    textPositions: ['top', 'top', 'top'],
    devices: [
      [createTidalDevice(0, 1.00, 0.66, 84, -3)],
      [createTidalDevice(-1, 0.00, 0.66, 84, -3), createTidalDevice(0, 1.00, 0.38, 80, 3)],
      [createTidalDevice(-1, 0.00, 0.38, 80, 3), createTidalDevice(0, 0.80, 0.70, 74, -10)]
    ]
  },
  {
    id: 'tidal-pinwheel',
    name: 'Pinwheel Handoff',
    description: 'Rotating corner energy',
    textPositions: ['top', 'bottom', 'top'],
    devices: [
      [createTidalDevice(0, 0.90, 0.72, 74, -24)],
      [createTidalDevice(-1, -0.10, 0.72, 74, -24), createTidalDevice(0, 0.88, 0.30, 72, 24)],
      [createTidalDevice(-1, -0.12, 0.30, 72, 24), createTidalDevice(0, 0.92, 0.72, 74, -24)]
    ]
  },
  {
    id: 'tidal-hero-sweep',
    name: 'Hero Sweep',
    description: 'Oversized, high-impact diagonal crop',
    textPositions: ['top', 'bottom', 'top'],
    devices: [
      [createTidalDevice(0, 0.82, 0.73, 96, -17)],
      [createTidalDevice(-1, -0.18, 0.73, 96, -17), createTidalDevice(0, 0.82, 0.26, 92, -17)],
      [createTidalDevice(-1, -0.18, 0.26, 92, -17), createTidalDevice(0, 0.96, 0.76, 82, -34)]
    ]
  }
].map(createTidalVariant);

const TIDAL_RELAY_CONTINUATION_CYCLE = [
  { positionMode: 'canvas', centerX: 0.85, centerY: 0.72, scale: 86, x: 50, y: 50, rotation: -8, perspective: 0, opacity: 100 },
  { positionMode: 'canvas', centerX: 0.72, centerY: 0.39, scale: 92, x: 50, y: 50, rotation: -11, perspective: 0, opacity: 100 },
  { positionMode: 'canvas', centerX: 1.03, centerY: 0.76, scale: 84, x: 50, y: 50, rotation: -38, perspective: 0, opacity: 100 }
];

const BASE_APP_TEMPLATES = [
  {
    id: 'violet-orbit-left', name: 'Violet Orbit', category: 'Bold Minimal', version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#E9E8F7', '#17171B'],
    background: createTemplateBackground(),
    shapes: [{ type: 'ellipse', x: 78, y: 48, width: 116, height: 52, fill: '#E9E8F7', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 78, x: 62, y: 57, rotation: 8, perspective: 0 }],
    text: { position: 'top', offsetY: 6, blockX: 22, blockWidth: 36, align: 'left', headlineSize: 104, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'lavender-stage-top', name: 'Lavender Stage', category: 'Bold Minimal', version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#5144F5', '#17171B'],
    background: createTemplateBackground(),
    shapes: [{ type: 'ellipse', x: 50, y: 78, width: 145, height: 52, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 72, x: 50, y: 57, rotation: 0, perspective: 0 }],
    text: { position: 'top', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 100, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'lavender-stage-bottom', name: 'Lavender Bottom', category: 'Bold Minimal', version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#5144F5', '#17171B'],
    background: createTemplateBackground(),
    shapes: [{ type: 'ellipse', x: 18, y: 24, width: 92, height: 44, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 76, x: 52, y: 40, rotation: 0, perspective: 0 }],
    text: { position: 'bottom', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 100, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'violet-spotlight', name: 'Violet Spotlight', category: 'Bold Minimal', version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#E9E8F7', '#17171B'],
    background: createTemplateBackground(),
    shapes: [{ type: 'ellipse', x: -5, y: 50, width: 88, height: 56, fill: '#E9E8F7', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 70, x: 57, y: 54, rotation: -2, perspective: 0 }],
    text: { position: 'top', offsetY: 6, blockX: 50, blockWidth: 82, align: 'center', headlineSize: 100, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'dual-device-cascade', name: 'Dual Cascade', category: 'Editorial', version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#5144F5', '#17171B'],
    background: createTemplateBackground(),
    shapes: [{ type: 'ellipse', x: 50, y: 10, width: 130, height: 45, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [
      { source: 'current', scale: 58, x: 34, y: 48, rotation: -5, perspective: 0, opacity: 92 },
      { source: 'current', scale: 64, x: 66, y: 57, rotation: 5, perspective: 0 }
    ],
    text: { position: 'bottom', offsetY: 6, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 96, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'split-library', name: 'Split Library', category: 'Editorial', version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#5144F5', '#17171B'],
    background: createTemplateBackground(),
    shapes: [{ type: 'rectangle', x: 25, y: 50, width: 50, height: 100, fill: '#5144F5', rotation: 0, layer: 'behind-screenshot', opacity: 100 }],
    devices: [{ source: 'current', scale: 72, x: 56, y: 54, rotation: 0, perspective: 0 }],
    text: { position: 'top', offsetY: 6, blockX: 72, blockWidth: 46, align: 'center', headlineSize: 94, headlineWeight: '700', headlineColor: '#17171B', subheadlineColor: '#17171B' }
  },
  {
    id: 'pulse-portrait',
    name: 'Pulse Portrait',
    description: 'Lifestyle portrait with a feathered photo, glowing pulse, and angled iPhone',
    category: 'Lifestyle Editorial',
    version: 2,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#B89CFF', '#17122F'],
    previewCopy: {
      headline: ['Your Library,', 'Your Audio'],
      subheadline: ['All your saved', 'listening clips in', 'one place.']
    },
    photoPolicy: 'preserve-existing',
    background: createTemplateBackground({
      photo: {
        enabled: true,
        label: 'Lifestyle photo',
        image: null,
        imageSrc: null,
        fit: 'cover',
        focalX: 28,
        focalY: 54,
        zoom: 112,
        opacity: 100,
        blur: 0,
        feather: {
          enabled: true,
          start: 19,
          end: 44,
          rightEnabled: true,
          rightStart: 78,
          rightEnd: 100,
          rightEndOpacity: 0,
          bottomEnabled: true,
          bottomStart: 88,
          bottomEnd: 100,
          bottomEndOpacity: 0
        }
      }
    }),
    shapes: [
      {
        type: 'pulse',
        name: 'Pulse glow',
        x: 54,
        y: 43,
        width: 112,
        height: 9,
        fill: '#B89CFF',
        opacity: 76,
        layer: 'behind-screenshot',
        lineWidth: 5,
        glowBlur: 38,
        glowOpacity: 74,
        cycles: 2.65,
        phase: 0,
        taper: 1.55
      },
      {
        type: 'pulse',
        name: 'Pulse echo',
        x: 54,
        y: 43,
        width: 112,
        height: 6,
        fill: '#F0E8FF',
        opacity: 42,
        layer: 'behind-screenshot',
        lineWidth: 2,
        glowBlur: 22,
        glowOpacity: 52,
        cycles: 2.65,
        phase: 0.5,
        taper: 1.55
      }
    ],
    devices: [
      {
        source: 'current',
        sourceOffset: 0,
        scale: 83,
        x: 165,
        y: 98,
        rotation: 0,
        perspective: 0,
        opacity: 100,
        use3D: true,
        device3D: 'iphone',
        frameColor: 'natural',
        rotation3D: { x: 2, y: -38, z: -2 }
      }
    ],
    previewDevices: [
      {
        positionMode: 'canvas',
        centerX: 0.77,
        centerY: 0.64,
        scale: 78,
        previewWidth: 47,
        previewAspect: 2.78,
        rotation: -2,
        perspective: 0
      }
    ],
    text: {
      headlineEnabled: true,
      subheadlineEnabled: true,
      perLanguageLayout: false,
      position: 'top',
      offsetY: 6,
      lineHeight: 138,
      blockX: 38,
      blockWidth: 60,
      align: 'left',
      headlineFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
      headlineSize: 126,
      headlineWeight: '800',
      headlineColor: '#100B2D',
      subheadlineFont: "-apple-system, BlinkMacSystemFont, 'SF Pro Display'",
      subheadlineSize: 58,
      subheadlineWeight: '400',
      subheadlineColor: '#17132F',
      subheadlineOpacity: 100
    }
  },
  {
    id: 'tidal-relay', name: 'Tidal Relay', description: 'Balanced diagonal device handoff', category: 'Sequences', type: 'sequence', version: 1,
    screenCount: 3,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#FFFFFF', '#12333D'],
    scenes: [
      {
        background: createTemplateBackground(),
        shapes: [
          { type: 'ellipse', x: 18, y: 32, width: 5, height: 2.3, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 72 },
          { type: 'ellipse', x: 78, y: 20, width: 2.5, height: 1.2, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 55 }
        ],
        devices: [
          { ...TIDAL_DEVICE_STYLE, sourceOffset: 0, positionMode: 'canvas', centerX: 0.85, centerY: 0.72, scale: 86, x: 50, y: 50, rotation: -8, perspective: 0 }
        ],
        text: { position: 'top', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 92, headlineWeight: '700', headlineColor: '#12333D', subheadlineColor: '#12333D' }
      },
      {
        background: createTemplateBackground(),
        shapes: [
          { type: 'ellipse', x: 88, y: 22, width: 4, height: 1.8, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 60 },
          { type: 'ellipse', x: 15, y: 82, width: 2.5, height: 1.2, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 48 }
        ],
        devices: [
          { ...TIDAL_DEVICE_STYLE, sourceOffset: -1, positionMode: 'canvas', centerX: -0.15, centerY: 0.72, scale: 86, x: 50, y: 50, rotation: -8, perspective: 0 },
          { ...TIDAL_DEVICE_STYLE, sourceOffset: 0, positionMode: 'canvas', centerX: 0.72, centerY: 0.39, scale: 92, x: 50, y: 50, rotation: -11, perspective: 0 }
        ],
        text: { position: 'bottom', offsetY: 6, blockX: 50, blockWidth: 82, align: 'center', headlineSize: 92, headlineWeight: '700', headlineColor: '#12333D', subheadlineColor: '#12333D' }
      },
      {
        background: createTemplateBackground(),
        shapes: [
          { type: 'ellipse', x: 26, y: 45, width: 5, height: 2.3, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 62 },
          { type: 'ellipse', x: 78, y: 62, width: 2.5, height: 1.2, fill: '#FFFFFF', rotation: 0, layer: 'behind-screenshot', opacity: 50 }
        ],
        devices: [
          { ...TIDAL_DEVICE_STYLE, sourceOffset: -1, positionMode: 'canvas', centerX: -0.28, centerY: 0.39, scale: 92, x: 50, y: 50, rotation: -11, perspective: 0 },
          {
            ...TIDAL_DEVICE_STYLE,
            sourceOffset: 0,
            positionMode: 'canvas',
            centerX: 1.03,
            centerY: 0.76,
            scale: 84,
            x: 50,
            y: 50,
            rotation: -38,
            perspective: 0,
            continueToNext: true,
            sequenceName: 'Tidal Relay',
            continuationCycle: TIDAL_RELAY_CONTINUATION_CYCLE,
            continuationStep: 2,
            continuationTextPositions: ['top', 'bottom', 'top']
          }
        ],
        text: { position: 'top', offsetY: 7, blockX: 50, blockWidth: 84, align: 'center', headlineSize: 92, headlineWeight: '700', headlineColor: '#12333D', subheadlineColor: '#12333D' }
      }
    ]
  },
  ...TIDAL_POSITION_VARIANTS
];

const FIXED_SEQUENCE_LENGTHS = [3, 6];
const SEQUENCE_CONTINUATION_FIELDS = [
  'continueToNext',
  'sequenceName',
  'continuationCycle',
  'continuationStep',
  'continuationTextPositions'
];

function cloneTemplateValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripSequenceContinuation(device) {
  const cleaned = cloneTemplateValue(device || {});
  SEQUENCE_CONTINUATION_FIELDS.forEach(field => delete cleaned[field]);
  return cleaned;
}

function fitTerminalDevice(device) {
  const terminal = stripSequenceContinuation(device);
  if (terminal.positionMode !== 'canvas') return { ...terminal, continueToNext: false };

  // Finish the story with a fully contained phone instead of another open seam.
  const scale = Math.min(68, Math.max(1, Number(terminal.scale) || 68));
  const rotation = Math.max(-8, Math.min(8, Number(terminal.rotation) || 0));
  const radians = Math.abs(rotation) * Math.PI / 180;
  const assumedPhoneAspect = 2556 / 1179;
  const horizontalHalfExtent = scale / 200
    * (Math.abs(Math.cos(radians)) + assumedPhoneAspect * Math.abs(Math.sin(radians)));
  const verticalHalfExtent = scale / 200
    * (Math.abs(Math.cos(radians)) + (1 / assumedPhoneAspect) * Math.abs(Math.sin(radians)));
  const safeMargin = 0.035;
  const minimumCenterX = safeMargin + horizontalHalfExtent;
  const maximumCenterX = Math.max(minimumCenterX, 1 - safeMargin - horizontalHalfExtent);
  const minimumCenterY = safeMargin + verticalHalfExtent;
  const maximumCenterY = Math.max(minimumCenterY, 1 - safeMargin - verticalHalfExtent);

  terminal.scale = scale;
  terminal.rotation = rotation;
  terminal.centerX = Math.min(maximumCenterX, Math.max(minimumCenterX, Number(terminal.centerX) || 0.5));
  terminal.centerY = Math.min(maximumCenterY, Math.max(minimumCenterY, Number(terminal.centerY) || 0.5));
  terminal.x = terminal.centerX * 100;
  terminal.y = terminal.centerY * 100;
  terminal.continueToNext = false;
  return terminal;
}

function createFixedLengthSequenceTemplate(template, screenCount) {
  const baseScenes = cloneTemplateValue(template.scenes || []);
  const currentDeviceCycle = baseScenes.map(scene =>
    (scene.devices || []).find(device => (device.sourceOffset ?? 0) === 0)
  ).filter(Boolean);
  if (!baseScenes.length || !currentDeviceCycle.length) return cloneTemplateValue(template);

  const scenes = Array.from({ length: screenCount }, (_, sceneIndex) => {
    const scene = cloneTemplateValue(baseScenes[sceneIndex % baseScenes.length]);
    const currentDevice = stripSequenceContinuation(currentDeviceCycle[sceneIndex % currentDeviceCycle.length]);
    currentDevice.sourceOffset = 0;

    const devices = [];
    if (sceneIndex > 0) {
      const previousDevice = stripSequenceContinuation(
        currentDeviceCycle[(sceneIndex - 1) % currentDeviceCycle.length]
      );
      previousDevice.sourceOffset = -1;
      if (previousDevice.positionMode === 'canvas' && Number.isFinite(previousDevice.centerX)) {
        previousDevice.centerX -= 1;
      }
      devices.push(previousDevice);
    }

    devices.push(sceneIndex === screenCount - 1 ? fitTerminalDevice(currentDevice) : currentDevice);
    scene.devices = devices;
    return scene;
  });

  return {
    ...cloneTemplateValue(template),
    id: screenCount === 3 ? template.id : `${template.id}-${screenCount}`,
    version: screenCount === 3 ? Math.max(4, Number(template.version) || 1) : 3,
    screenCount,
    fixedLength: true,
    scenes
  };
}

function createInsightShowcaseTemplates() {
  const device = (centerX, centerY, scale, rotation) => ({
    sourceOffset: 0, positionMode: 'canvas', centerX, centerY,
    scale, x: 50, y: 50, rotation, perspective: 0, opacity: 100,
    cornerRadius: 32,
    frame: { enabled: true, color: '#242426', width: 9, opacity: 100 },
    shadow: { enabled: true, color: '#252322', blur: 38, opacity: 22, x: 0, y: 18 },
    use3D: true, device3D: 'iphone', frameColor: 'white',
    rotation3D: { x: 10, y: -16, z: 0 }
  });
  const detailCard = (x, y, cropY = 20, cropHeight = 30, width = 48) => ({
    cropX: 6, cropY, cropWidth: 88, cropHeight,
    x, y, width, rotation: 0, opacity: 100, cornerRadius: 19,
    shadow: { enabled: true, color: '#242321', blur: 34, opacity: 20, x: 0, y: 14 },
    border: { enabled: true, color: '#FFFFFF', width: 6, opacity: 100 }
  });
  const insetPhone = {
    cropX: 0, cropY: 0, cropWidth: 100, cropHeight: 100,
    x: 28, y: 80, width: 34, rotation: -1, opacity: 100, cornerRadius: 35,
    shadow: { enabled: true, color: '#242321', blur: 40, opacity: 25, x: 0, y: 16 },
    border: { enabled: true, color: '#242426', width: 7, opacity: 100 }
  };
  const text = {
    headlineEnabled: true, subheadlineEnabled: true, perLanguageLayout: false,
    position: 'top', offsetY: 5.5, blockX: 50, blockWidth: 80, align: 'left',
    headlineFont: '-apple-system, BlinkMacSystemFont, sans-serif',
    headlineSize: 112, headlineWeight: '700', headlineColor: '#191919',
    headlineGradient: false, headlineItalic: false,
    subheadlineFont: '-apple-system, BlinkMacSystemFont, sans-serif',
    subheadlineSize: 54, subheadlineWeight: '400', subheadlineColor: '#57554F',
    subheadlineOpacity: 100, lineHeight: 115
  };
  const previewCopy = [
    { headline: ['Every detail,', 'in focus.'], subheadline: ['Give the important', 'parts room to shine.'] },
    { headline: ['A closer look.', 'A clearer story.'], subheadline: [] },
    { headline: ['The whole', 'picture.'], subheadline: ['One place for', 'every detail.'] }
  ];
  const base = {
    id: 'insight-showcase', name: 'Insight Showcase', category: 'Editorial Showcase',
    description: 'An oversized angled phone with floating screenshot detail cards',
    type: 'sequence', version: 1,
    palette: [TEMPLATE_BACKGROUND_COLOR, '#FFFFFF', '#191919'],
    scenes: [
      { devices: [device(1.06, 0.81, 116, 20)], popouts: [detailCard(38, 46), insetPhone] },
      { devices: [device(1.04, 0.78, 78, -12)], popouts: [detailCard(62, 80, 46, 34)] },
      { devices: [device(0.83, 0.72, 86, 20)], popouts: [detailCard(32, 84, 26, 24, 44)] }
    ].map((scene, index) => ({
      ...scene, background: createTemplateBackground(), shapes: [],
      text: { ...text }, previewCopy: previewCopy[index]
    }))
  };
  const single = {
    id: 'insight-showcase-single', name: base.name, category: base.category,
    description: 'An angled hero phone with an inset screen and editable detail card',
    version: 1, screenCount: 1, fixedLength: true,
    palette: [...base.palette], background: createTemplateBackground(), shapes: [],
    devices: [fitTerminalDevice(device(0.65, 0.66, 68, 8))],
    popouts: [detailCard(33, 48, 20, 24, 42), { ...insetPhone, x: 26, y: 81, width: 29 }],
    text: { ...text }, previewCopy: previewCopy[0]
  };
  return [single, ...[2, ...FIXED_SEQUENCE_LENGTHS].map(count => createFixedLengthSequenceTemplate(base, count))];
}

const APP_TEMPLATES = BASE_APP_TEMPLATES.flatMap(template => {
  if (template.type !== 'sequence') return [{ ...template, screenCount: 1, fixedLength: true }];
  return FIXED_SEQUENCE_LENGTHS.map(screenCount => createFixedLengthSequenceTemplate(template, screenCount));
}).concat(createInsightShowcaseTemplates());

// The static editor and backend consume the same versioned template catalog.
globalThis.AppScreenTemplates = { version: TEMPLATE_CATALOG_VERSION, templates: APP_TEMPLATES };
