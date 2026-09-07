// Capability metadata, not a promise of visual quality. Keep this shared by
// catalog discovery, job admission and the renderer's final safety boundary.
const limitations = {
  DEVICE_3D: '3D devices are available in the local editor only.',
  LAYERED_PHOTO: 'Layered lifestyle photos are available in the local editor only.',
};

export function getCloudRenderSupport(value) {
  const scenes = value.scenes || [value], codes = new Set();
  if (scenes.some(scene => scene.screenshot?.use3D || scene.devices?.some(device => device.use3D)) || value.deviceGroups?.some(group => group.geometry?.use3D)) codes.add('DEVICE_3D');
  if (scenes.some(scene => scene.background?.photo?.enabled)) codes.add('LAYERED_PHOTO');
  return { cloudCompatible: codes.size === 0, cloudLimitations: [...codes].map(code => ({ code, message: limitations[code] })) };
}

export function cloudSupportMessage(support) {
  return `${support.cloudLimitations.map(item => item.message).join(' ')} Choose a supported 2D template, or finish this design in the local editor.`;
}
