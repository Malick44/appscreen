// Three.js 3D Renderer for iPhone mockups

let threeRenderer = null;
let threeScene = null;
let threeCamera = null;
let phoneModel = null;
let phonePivot = null;  // Pivot group for rotation around screen center
let screenMesh = null;
let customScreenPlane = null;
let orbitControls = null;
let isThreeJSInitialized = false;
let phoneModelLoaded = false;
let phoneModelLoading = false;
let phoneModelLoadRequestId = 0;
let lastThreeDUnavailableMessage = '';

// Screen texture for the screenshot
let screenTexture = null;

// Store original model scale
let baseModelScale = 1;

// Store base position offset to keep model centered after screen alignment
let basePositionOffset = { x: 0, y: 0, z: 0 };

// Current device model type
let currentDeviceModel = 'iphone';

// Cache for loaded phone models (for rendering different devices in side previews)
let phoneModelCache = {};  // { deviceType: { model, pivot, screenPlane, baseScale, loaded } }

function reportThreeDUnavailable(deviceType = 'iphone', error = null) {
    const launchedFromFile = typeof window !== 'undefined' && window.location?.protocol === 'file:';
    const deviceLabel = deviceType === 'samsung' ? 'Samsung' : 'iPhone';
    const message = launchedFromFile
        ? '3D requires the local server. Open http://localhost:8000/ instead of index.html directly.'
        : `${deviceLabel} 3D could not start. Check WebGL and reload the page.`;
    if (message === lastThreeDUnavailableMessage) return;
    lastThreeDUnavailableMessage = message;

    if (error) console.error(message, error);
    if (typeof setWorkspaceStatus === 'function') setWorkspaceStatus('error', '3D unavailable');
    if (typeof showTemplateToast === 'function') showTemplateToast(message);
}

function clearThreeDUnavailable() {
    const hadReportedError = Boolean(lastThreeDUnavailableMessage);
    lastThreeDUnavailableMessage = '';
    const status = typeof document !== 'undefined' ? document.getElementById('save-status') : null;
    const statusCopy = status?.querySelector('.status-copy')?.textContent;
    if (hadReportedError && status?.classList.contains('is-error') && statusCopy === '3D unavailable'
        && typeof setWorkspaceStatus === 'function') {
        setWorkspaceStatus('saved', '3D ready', 1800);
    }
}

function isThreeJSRendererReady() {
    return Boolean(isThreeJSInitialized && threeRenderer && threeScene && threeCamera);
}

// Device-specific configurations
const deviceConfigs = {
    iphone: {
        modelPath: 'models/iphone-15-pro-max.glb',
        aspectRatio: 1290 / 2796,
        screenHeightFactor: 0.826,
        screenOffset: { x: 0.027, y: 0.745, z: 0.098 },
        positionOffsetFactor: 0.81,
        cornerRadiusFactor: 0.16,
        modelRotation: { x: 0, y: 0, z: 0 }  // No correction needed
    },
    samsung: {
        modelPath: 'models/samsung-galaxy-s25-ultra.glb',
        aspectRatio: 1440 / 3120,
        screenHeightFactor: 0.66,
        screenOffset: { x: 0, y: 0.0, z: 0.08},  // Will need adjustment
        positionOffsetFactor: 0.5,
        cornerRadiusFactor: 0.04,
        modelRotation: { x: 0, y: 0, z: 0 }  // Adjust to correct model tilt (in degrees)
    }
};

// Frame color presets per device (real device colors)
// Using var so it's accessible from app.js
var frameColorPresets = {
    iphone: [
        { id: 'natural', label: 'Natural Titanium', swatch: '#9d927f',
          materials: { backpanel: '#9d927f', metalframe: '#5f5950', gray: '#221f1b' } },
        { id: 'blue', label: 'Blue Titanium', swatch: '#3d4d5c',
          materials: { backpanel: '#394d5f', metalframe: '#3a4553', gray: '#1a1f24' } },
        { id: 'white', label: 'White Titanium', swatch: '#e3ddd4',
          materials: { backpanel: '#e3ddd4', metalframe: '#c4bdb4', gray: '#2a2825' } },
        { id: 'black', label: 'Black Titanium', swatch: '#3a3632',
          materials: { backpanel: '#3a3632', metalframe: '#2a2725', gray: '#1a1918' } },
        { id: 'desert', label: 'Desert Titanium', swatch: '#c4a882',
          materials: { backpanel: '#c4a882', metalframe: '#8a7560', gray: '#2a2218' } },
        { id: 'deep-purple', label: 'Deep Purple', swatch: '#5b4a6e',
          materials: { backpanel: '#5b4a6e', metalframe: '#3d3348', gray: '#1e1825' } },
        { id: 'gold', label: 'Gold', swatch: '#e3c8a0',
          materials: { backpanel: '#e3c8a0', metalframe: '#c9a96e', gray: '#2a2418' } },
        { id: 'red', label: 'Product Red', swatch: '#c1272d',
          materials: { backpanel: '#c1272d', metalframe: '#8a1c20', gray: '#1a0a0a' } },
    ],
    samsung: [
        { id: 'gray', label: 'Titanium Gray', swatch: '#8a8a8a',
          materials: { back_glass: '#4c4c4c', frame: '#cdcdcd', antenna: '#707070' } },
        { id: 'black', label: 'Titanium Black', swatch: '#2a2a2a',
          materials: { back_glass: '#1a1a1a', frame: '#3a3a3a', antenna: '#2a2a2a' } },
        { id: 'silverblue', label: 'Titanium Silverblue', swatch: '#a8b8c8',
          materials: { back_glass: '#8a9eb0', frame: '#b8c8d4', antenna: '#7a8ea0' } },
        { id: 'whitesilver', label: 'Titanium Whitesilver', swatch: '#e8e4df',
          materials: { back_glass: '#d8d4cf', frame: '#e8e4df', antenna: '#c0bcb7' } },
        { id: 'pinkgold', label: 'Titanium Pinkgold', swatch: '#d4a89a',
          materials: { back_glass: '#c89888', frame: '#d4b0a0', antenna: '#b08878' } },
        { id: 'jadegreen', label: 'Titanium Jadegreen', swatch: '#9aaa9c',
          materials: { back_glass: '#7a9a7c', frame: '#a8b8aa', antenna: '#6a8a6c' } },
        { id: 'jetblack', label: 'Titanium Jetblack', swatch: '#404040',
          materials: { back_glass: '#2a2a2a', frame: '#484848', antenna: '#353535' } },
    ]
};

// Store original material colors for the current model
let originalMaterialColors = {};

// Apply a frame color preset to the phone model
function setPhoneFrameColor(presetId, deviceType) {
    if (!phoneModel) return;

    deviceType = deviceType || currentDeviceModel;
    if (deviceType !== currentDeviceModel) return;
    const presets = frameColorPresets[deviceType];
    if (!presets) return;

    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;

    phoneModel.traverse((child) => {
        if (child.isMesh && child.material) {
            const matName = (child.material.name || '').toLowerCase();
            if (preset.materials[matName]) {
                child.material.color.set(preset.materials[matName]);
            }
        }
    });

    requestThreeJSRender();
}

// Apply frame color to a cached model (for side previews)
function setCachedModelFrameColor(presetId, deviceType) {
    const cached = phoneModelCache[deviceType];
    if (!cached?.loaded) return;

    const presets = frameColorPresets[deviceType];
    if (!presets) return;

    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;

    cached.model.traverse((child) => {
        if (child.isMesh && child.material) {
            const matName = (child.material.name || '').toLowerCase();
            if (preset.materials[matName]) {
                child.material.color.set(preset.materials[matName]);
            }
        }
    });
}

// Initialize Three.js scene
function initThreeJS() {
    if (isThreeJSInitialized) return;

    const container = document.getElementById('threejs-container');
    if (!container) return;
    if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
        reportThreeDUnavailable();
        return;
    }

    // Create scene with a gradient background color (we'll update this dynamically)
    threeScene = new THREE.Scene();
    threeScene.background = new THREE.Color(0x667eea); // Default gradient start color

    // Create camera
    const aspect = 400 / 700;
    threeCamera = new THREE.PerspectiveCamera(35, aspect, 0.1, 1000);
    threeCamera.position.set(0, 0, 6);

    // Create renderer - disable antialiasing for faster interactive performance
    // Quality rendering is done at export time with higher resolution
    try {
        threeRenderer = new THREE.WebGLRenderer({
            antialias: false,  // Disable for better performance
            alpha: true,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance'
        });
    } catch (error) {
        threeRenderer = null;
        threeScene = null;
        threeCamera = null;
        reportThreeDUnavailable(currentDeviceModel, error);
        return;
    }
    threeRenderer.setSize(400, 700);
    // Use device pixel ratio of 1 for fastest interactive rendering
    threeRenderer.setPixelRatio(1);
    threeRenderer.outputEncoding = THREE.sRGBEncoding;
    threeRenderer.toneMapping = THREE.NoToneMapping;
    // Disable automatic clearing - we control this manually
    threeRenderer.autoClear = false;

    container.appendChild(threeRenderer.domElement);

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    threeScene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
    keyLight.position.set(2, 3, 4);
    threeScene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-2, 1, 2);
    threeScene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
    rimLight.position.set(0, -2, -3);
    threeScene.add(rimLight);

    // Add orbit controls (disabled - we use custom drag handling for better performance)
    // orbitControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
    // orbitControls.enableDamping = true;
    // orbitControls.dampingFactor = 0.05;
    // orbitControls.enableZoom = false;
    // orbitControls.enablePan = false;
    // orbitControls.rotateSpeed = 0.5;
    // orbitControls.minPolarAngle = Math.PI / 4;
    // orbitControls.maxPolarAngle = Math.PI * 3 / 4;
    // orbitControls.minAzimuthAngle = -Math.PI / 3;
    // orbitControls.maxAzimuthAngle = Math.PI / 3;

    isThreeJSInitialized = true;

    // Load the phone model - check state for which device to use
    let deviceToLoad = 'iphone';
    if (typeof state !== 'undefined' && typeof getScreenshotSettings === 'function') {
        const ss = getScreenshotSettings();
        if (ss?.device3D) {
            deviceToLoad = ss.device3D;
        }
    }
    currentDeviceModel = deviceToLoad;
    loadPhoneModel();

    // Start animation loop
    animateThreeJS();
}

// Load the phone 3D model based on currentDeviceModel
function loadPhoneModel() {
    if (phoneModelLoading) return; // Prevent double loading
    phoneModelLoading = true;

    const deviceType = currentDeviceModel;
    const requestId = ++phoneModelLoadRequestId;
    const config = deviceConfigs[deviceType] || deviceConfigs.iphone;
    const loader = new THREE.GLTFLoader();

    loader.load(
        config.modelPath,
        (gltf) => {
            if (requestId !== phoneModelLoadRequestId) {
                gltf.scene.traverse(child => {
                    child.geometry?.dispose?.();
                    child.material?.dispose?.();
                });
                return;
            }
            phoneModelLoading = false;
            phoneModel = gltf.scene;
            clearThreeDUnavailable();

            // Center and scale the model
            const box = new THREE.Box3().setFromObject(phoneModel);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());

            // Center the model
            phoneModel.position.sub(center);

            // Scale to fit view (3.75 = 2.5 * 1.5 to match 2D scale at 100%)
            const maxDim = Math.max(size.x, size.y, size.z);
            baseModelScale = 3.75 / maxDim;
            phoneModel.scale.setScalar(baseModelScale);

            // Log all meshes to help identify the screen
            console.log('Phone model meshes:');
            let blackMeshes = [];
            phoneModel.traverse((child) => {
                if (child.isMesh) {
                    console.log('  Mesh:', child.name, '| Material:', child.material?.name);

                    // Look for screen mesh - in this model it's likely "black" material
                    const name = (child.name || '').toLowerCase();
                    const matName = (child.material?.name || '').toLowerCase();

                    if (matName === 'black') {
                        blackMeshes.push(child);
                    }

                    if (name.includes('screen') || name.includes('display') ||
                        matName.includes('screen') || matName.includes('display') ||
                        matName.includes('emission') || matName.includes('emissive')) {
                        screenMesh = child;
                        console.log('  -> Identified as screen mesh');
                    }
                }
            });

            // Find the front glass - that's where the screen actually is
            // Don't use black meshes, those are small elements like notch/dynamic island
            let glassMeshes = [];
            phoneModel.traverse((child) => {
                if (child.isMesh) {
                    const matName = (child.material?.name || '').toLowerCase();
                    if (matName === 'glass') {
                        child.geometry.computeBoundingBox();
                        const box = child.geometry.boundingBox;
                        const size = new THREE.Vector3();
                        box.getSize(size);
                        const area = size.x * size.y;
                        glassMeshes.push({ mesh: child, area, size });
                        console.log('  Glass mesh:', child.name, 'size:', size.x.toFixed(3), 'x', size.y.toFixed(3), 'area:', area.toFixed(3));
                    }
                }
            });

            // Use the largest glass mesh (front screen glass)
            if (glassMeshes.length > 0) {
                glassMeshes.sort((a, b) => b.area - a.area);
                screenMesh = glassMeshes[0].mesh;
                console.log('  -> Using largest glass mesh as screen:', screenMesh.name);
            }

            // Create a pivot group for rotation around screen center
            const config = deviceConfigs[currentDeviceModel] || deviceConfigs.iphone;
            const screenOffset = config.screenOffset;

            phonePivot = new THREE.Group();

            // Offset the phone model so the screen center is at the pivot's origin
            phoneModel.position.set(
                -screenOffset.x * baseModelScale,
                -screenOffset.y * baseModelScale,
                -screenOffset.z * baseModelScale
            );

            phonePivot.add(phoneModel);
            threeScene.add(phonePivot);

            // Create a custom screen plane overlay since the model's UV mapping may be incorrect
            createScreenOverlay();

            phoneModelLoaded = true;

            // Apply initial settings from state
            if (typeof state !== 'undefined') {
                updateThreeJSBackground();
                const ss = typeof getScreenshotSettings === 'function' ? getScreenshotSettings() : state.defaults?.screenshot;
                const rotation3D = ss?.rotation3D || { x: 0, y: 0, z: 0 };
                setThreeJSRotation(rotation3D.x, rotation3D.y, rotation3D.z);

                // Apply frame color
                if (ss?.frameColor) {
                    setPhoneFrameColor(ss.frameColor, currentDeviceModel);
                }

                // Apply screenshot texture
                if (state.screenshots.length > 0) {
                    updateScreenTexture();
                }

                // Refresh canvas now that model is loaded (needed for side previews too)
                if (typeof updateCanvas === 'function') {
                    updateCanvas({ persist: false });
                }
            }

            console.log('Phone model loaded successfully');
        },
        (progress) => {
            const percent = Math.round(progress.loaded / progress.total * 100);
            console.log('Loading phone model... ' + percent + '%');
        },
        (error) => {
            if (requestId !== phoneModelLoadRequestId) return;
            phoneModelLoading = false;
            phoneModelLoaded = false;
            reportThreeDUnavailable(deviceType, error);
        }
    );
}

// Switch to a different phone model
function switchPhoneModel(deviceType) {
    if (!deviceConfigs[deviceType]) {
        console.error('Unknown device type:', deviceType);
        return;
    }
    if (!isThreeJSRendererReady()) {
        if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
            reportThreeDUnavailable(deviceType);
        }
        return;
    }

    // Skip if same device and already loaded or loading
    if (currentDeviceModel === deviceType && (phoneModelLoaded || phoneModelLoading)) {
        return;
    }

    // Update current device type
    currentDeviceModel = deviceType;
    phoneModelLoading = true;
    const requestId = ++phoneModelLoadRequestId;

    // Remove current pivot (which contains the model) from scene
    if (phonePivot && threeScene) {
        threeScene.remove(phonePivot);
        phonePivot.traverse((child) => {
            if (child.isMesh) {
                child.geometry?.dispose();
                child.material?.dispose();
            }
        });
        phonePivot = null;
        phoneModel = null;
    }

    // Clean up screen plane
    if (customScreenPlane) {
        if (customScreenPlane.parent) {
            customScreenPlane.parent.remove(customScreenPlane);
        }
        customScreenPlane.geometry?.dispose();
        customScreenPlane.material?.dispose();
        customScreenPlane = null;
    }

    screenMesh = null;
    phoneModelLoaded = false;

    // Load new model using the config
    const config = deviceConfigs[currentDeviceModel];
    const loader = new THREE.GLTFLoader();

    loader.load(
        config.modelPath,
        (gltf) => {
            if (requestId !== phoneModelLoadRequestId) {
                gltf.scene.traverse(child => {
                    child.geometry?.dispose?.();
                    child.material?.dispose?.();
                });
                return;
            }
            phoneModelLoading = false;
            phoneModel = gltf.scene;
            clearThreeDUnavailable();

            // Center and scale the model
            const box = new THREE.Box3().setFromObject(phoneModel);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());

            phoneModel.position.sub(center);

            const maxDim = Math.max(size.x, size.y, size.z);
            baseModelScale = 3.75 / maxDim;
            phoneModel.scale.setScalar(baseModelScale);

            // Create a pivot group for rotation around screen center
            const screenOffset = config.screenOffset;
            phonePivot = new THREE.Group();

            // Offset the phone model so the screen center is at the pivot's origin
            phoneModel.position.set(
                -screenOffset.x * baseModelScale,
                -screenOffset.y * baseModelScale,
                -screenOffset.z * baseModelScale
            );

            phonePivot.add(phoneModel);
            threeScene.add(phonePivot);

            // Create screen overlay for this device
            createScreenOverlay();

            phoneModelLoaded = true;

            // Apply settings
            if (typeof state !== 'undefined') {
                updateThreeJSBackground();
                const ss = typeof getScreenshotSettings === 'function' ? getScreenshotSettings() : state.defaults?.screenshot;
                const rotation3D = ss?.rotation3D || { x: 0, y: 0, z: 0 };
                setThreeJSRotation(rotation3D.x, rotation3D.y, rotation3D.z);

                // Apply frame color
                if (ss?.frameColor) {
                    setPhoneFrameColor(ss.frameColor, currentDeviceModel);
                }

                if (state.screenshots.length > 0) {
                    updateScreenTexture();
                }

                // Only call updateCanvas if not suppressed (e.g., during slide transitions)
                if (typeof updateCanvas === 'function' && !window.suppressSwitchModelUpdate) {
                    updateCanvas({ persist: false });
                }
            }

            console.log(deviceType + ' model loaded successfully');
        },
        (progress) => {
            const percent = Math.round(progress.loaded / progress.total * 100);
            console.log('Loading ' + deviceType + ' model... ' + percent + '%');
        },
        (error) => {
            if (requestId !== phoneModelLoadRequestId) return;
            phoneModelLoading = false;
            phoneModelLoaded = false;
            reportThreeDUnavailable(deviceType, error);
        }
    );
}

// Load a phone model into the cache (for side preview rendering with different devices)
function loadCachedPhoneModel(deviceType) {
    if (!deviceConfigs[deviceType]) return Promise.reject('Unknown device type');

    // Already loaded or loading
    if (phoneModelCache[deviceType]?.loaded) {
        return Promise.resolve(phoneModelCache[deviceType]);
    }
    if (phoneModelCache[deviceType]?.loading) {
        return phoneModelCache[deviceType].loadingPromise;
    }

    const config = deviceConfigs[deviceType];
    const loader = new THREE.GLTFLoader();

    phoneModelCache[deviceType] = { loading: true, loaded: false };

    phoneModelCache[deviceType].loadingPromise = new Promise((resolve, reject) => {
        loader.load(
            config.modelPath,
            (gltf) => {
                const model = gltf.scene;

                // Center and scale the model
                const box = new THREE.Box3().setFromObject(model);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());

                model.position.sub(center);

                const maxDim = Math.max(size.x, size.y, size.z);
                const modelBaseScale = 3.75 / maxDim;
                model.scale.setScalar(modelBaseScale);

                // Create pivot for this model
                const screenOffset = config.screenOffset;
                const pivot = new THREE.Group();

                model.position.set(
                    -screenOffset.x * modelBaseScale,
                    -screenOffset.y * modelBaseScale,
                    -screenOffset.z * modelBaseScale
                );

                pivot.add(model);

                // Create screen plane for this model
                const aspectRatio = config.aspectRatio;
                const planeHeight = 4.3 * config.screenHeightFactor;
                const planeWidth = planeHeight * aspectRatio;

                const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
                const material = new THREE.MeshBasicMaterial({
                    color: 0x111111,
                    side: THREE.DoubleSide
                });

                const screenPlane = new THREE.Mesh(geometry, material);
                screenPlane.position.set(screenOffset.x, screenOffset.y, screenOffset.z);

                const modelRot = config.modelRotation || { x: 0, y: 0, z: 0 };
                screenPlane.rotation.set(
                    -modelRot.x * Math.PI / 180,
                    -modelRot.y * Math.PI / 180,
                    -modelRot.z * Math.PI / 180
                );

                model.add(screenPlane);

                phoneModelCache[deviceType] = {
                    model: model,
                    pivot: pivot,
                    screenPlane: screenPlane,
                    baseScale: modelBaseScale,
                    loaded: true,
                    loading: false
                };
                clearThreeDUnavailable();

                console.log('Cached ' + deviceType + ' model for side previews');
                resolve(phoneModelCache[deviceType]);
            },
            undefined,
            (error) => {
                phoneModelCache[deviceType] = { loading: false, loaded: false };
                reportThreeDUnavailable(deviceType, error);
                reject(error);
            }
        );
    });

    return phoneModelCache[deviceType].loadingPromise;
}

// Preload all device models for side previews
function preloadAllPhoneModels() {
    const deviceTypes = Object.keys(deviceConfigs);
    return Promise.all(deviceTypes.map(type => loadCachedPhoneModel(type).catch(() => null)));
}

// Create a custom screen plane overlay with correct UV mapping
function createScreenOverlay() {
    if (customScreenPlane) {
        if (customScreenPlane.parent) {
            customScreenPlane.parent.remove(customScreenPlane);
        }
        customScreenPlane.geometry.dispose();
        customScreenPlane.material.dispose();
    }

    const config = deviceConfigs[currentDeviceModel] || deviceConfigs.iphone;

    // Use device-specific aspect ratio and screen size
    const aspectRatio = config.aspectRatio;
    const planeHeight = 4.3 * config.screenHeightFactor;
    const planeWidth = planeHeight * aspectRatio;

    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    const material = new THREE.MeshBasicMaterial({
        color: 0x111111,
        side: THREE.DoubleSide
    });

    customScreenPlane = new THREE.Mesh(geometry, material);

    // Position at center of phone, slightly in front of glass
    const screenOffset = config.screenOffset;
    customScreenPlane.position.set(screenOffset.x, screenOffset.y, screenOffset.z);

    // Counter-rotate the screen to cancel out the model's base rotation
    // This keeps the screen facing forward when the pivot applies the base rotation
    const modelRot = config.modelRotation || { x: 0, y: 0, z: 0 };
    customScreenPlane.rotation.set(
        -modelRot.x * Math.PI / 180,
        -modelRot.y * Math.PI / 180,
        -modelRot.z * Math.PI / 180
    );

    // Add directly to phoneModel so it moves with it
    phoneModel.add(customScreenPlane);

    // basePositionOffset is no longer needed since we use pivot-based rotation
    basePositionOffset.y = 0;

    console.log('Created screen overlay for ' + currentDeviceModel + ' at:', customScreenPlane.position);
    console.log('Plane size:', planeWidth.toFixed(4), 'x', planeHeight.toFixed(4));
}

// Create a rounded corner version of the screenshot
function createRoundedScreenImage(image, cornerRadius) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');

    // Draw rounded rectangle path
    const w = canvas.width;
    const h = canvas.height;
    const r = cornerRadius;

    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();

    // Clip to rounded rectangle and draw image
    ctx.clip();
    ctx.drawImage(image, 0, 0);

    return canvas;
}

// Update the screen texture with current screenshot
function updateScreenTexture() {
    if (!phoneModel) return;
    if (typeof state === 'undefined' || !state.screenshots.length) return;

    const screenshot = state.screenshots[state.selectedIndex];
    // Use getScreenshotImage() for localized image support
    const screenshotImage = typeof getScreenshotImage === 'function'
        ? getScreenshotImage(screenshot)
        : screenshot?.image;
    if (!screenshot || !screenshotImage) return;

    // Create texture from screenshot
    if (screenTexture) {
        screenTexture.dispose();
    }

    // Create rounded corner version of the image using device-specific corner radius
    const config = deviceConfigs[currentDeviceModel] || deviceConfigs.iphone;
    const cornerRadius = Math.round(screenshotImage.width * config.cornerRadiusFactor);
    const roundedImage = createRoundedScreenImage(screenshotImage, cornerRadius);

    screenTexture = new THREE.Texture(roundedImage);
    screenTexture.needsUpdate = true;
    screenTexture.encoding = THREE.sRGBEncoding;
    screenTexture.flipY = true;

    // Create a material for the screen with transparency for rounded corners
    const screenMaterial = new THREE.MeshBasicMaterial({
        map: screenTexture,
        side: THREE.FrontSide,
        transparent: true
    });

    // Apply to custom screen plane (preferred)
    if (customScreenPlane) {
        customScreenPlane.material.dispose();
        customScreenPlane.material = screenMaterial;
        console.log('Applied rounded texture to custom screen plane');
    }

    // Trigger render update
    requestThreeJSRender();
}

// Set 3D rotation from sliders (in degrees)
function setThreeJSRotation(rotX, rotY, rotZ) {
    if (!phonePivot) return;

    // Add the device's base model rotation to the user's rotation
    const config = deviceConfigs[currentDeviceModel] || deviceConfigs.iphone;
    const modelRot = config.modelRotation || { x: 0, y: 0, z: 0 };

    console.log('setThreeJSRotation:', currentDeviceModel, 'modelRot:', modelRot, 'user:', rotX, rotY, rotZ);

    // Rotate the pivot (which rotates around the screen center)
    phonePivot.rotation.x = (rotX + modelRot.x) * Math.PI / 180;
    phonePivot.rotation.y = (rotY + modelRot.y) * Math.PI / 180;
    phonePivot.rotation.z = (rotZ + modelRot.z) * Math.PI / 180;

    // Trigger render update
    requestThreeJSRender();
}

// Set 3D scale
function setThreeJSScale(scale) {
    if (!phoneModel) return;

    phoneModel.scale.setScalar(baseModelScale * (scale / 100));

    // Trigger render update
    requestThreeJSRender();
}

// Render on demand instead of continuous animation loop
let renderRequested = false;

function requestThreeJSRender() {
    if (renderRequested) return;
    renderRequested = true;
    requestAnimationFrame(() => {
        renderRequested = false;
        if (threeRenderer && threeScene && threeCamera) {
            threeRenderer.clear();
            threeRenderer.render(threeScene, threeCamera);
        }
    });
}

// Legacy function name for compatibility - now triggers on-demand render
function animateThreeJS() {
    requestThreeJSRender();
}

const pendingThreeDRenderLoads = new Set();

function getThreeDModelHandle(deviceType) {
    if (!deviceConfigs[deviceType]) return null;
    if (deviceType === currentDeviceModel && phoneModelLoaded && phoneModel && phonePivot && customScreenPlane) {
        return { deviceType, model: phoneModel, pivot: phonePivot, screenPlane: customScreenPlane, current: true };
    }
    const cached = phoneModelCache[deviceType];
    return cached?.loaded
        ? { deviceType, model: cached.model, pivot: cached.pivot, screenPlane: cached.screenPlane, current: false }
        : null;
}

function isPhoneModelReady(deviceType = currentDeviceModel) {
    return Boolean(getThreeDModelHandle(deviceType));
}

function requestThreeDModelForRender(deviceType) {
    if (!deviceConfigs[deviceType] || isPhoneModelReady(deviceType) || pendingThreeDRenderLoads.has(deviceType)) return;
    // The active model loader already refreshes the canvas when it completes.
    if (deviceType === currentDeviceModel && phoneModelLoading) return;
    pendingThreeDRenderLoads.add(deviceType);
    loadCachedPhoneModel(deviceType)
        .then(() => {
            if (typeof updateCanvas === 'function') updateCanvas({ persist: false });
        })
        .catch(() => {})
        .finally(() => pendingThreeDRenderLoads.delete(deviceType));
}

function forEachModelMaterial(model, callback) {
    const visited = new Set();
    model?.traverse(child => {
        if (!child.isMesh || !child.material) return;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(material => {
            if (!material || visited.has(material)) return;
            visited.add(material);
            callback(material);
        });
    });
}

function snapshotModelColors(model) {
    const snapshot = [];
    forEachModelMaterial(model, material => {
        if (material.color?.clone) snapshot.push({ material, color: material.color.clone() });
    });
    return snapshot;
}

function restoreModelColors(snapshot) {
    snapshot.forEach(({ material, color }) => material.color?.copy(color));
}

function applyModelFrameColor(model, presetId, deviceType) {
    const presets = frameColorPresets[deviceType] || [];
    const preset = presets.find(candidate => candidate.id === presetId) || presets[0];
    if (!preset) return;
    forEachModelMaterial(model, material => {
        const materialName = (material.name || '').toLowerCase();
        if (preset.materials[materialName] && material.color?.set) {
            material.color.set(preset.materials[materialName]);
        }
    });
}

function getCameraViewSnapshot(camera) {
    return camera.view ? { ...camera.view } : null;
}

function restoreCameraView(camera, view) {
    camera.view = view ? { ...view } : null;
}

function applyThreeDPlacementTransform(pivot, settings, dims, screenIndex, screenCount, deviceType) {
    const scale = Math.max(0.01, Number(settings.scale ?? 70) / 100);
    const config = deviceConfigs[deviceType] || deviceConfigs.iphone;
    const modelRotation = config.modelRotation || { x: 0, y: 0, z: 0 };
    const rotation3D = settings.rotation3D || { x: 0, y: 0, z: 0 };
    const cameraDistance = Math.abs(threeCamera.position.z - basePositionOffset.z);
    const worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(threeCamera.fov) / 2) * cameraDistance;
    const screenWorldWidth = worldHeight * (dims.width / dims.height);
    let worldX;
    let worldY;

    if (settings.positionMode === 'canvas'
        && Number.isFinite(settings.centerX)
        && Number.isFinite(settings.centerY)) {
        // Canvas coordinates are globalized across the virtual strip. Matching
        // outgoing/incoming placements therefore render as two crops of the same
        // 3D object, keeping a continuation exact at the screen seam.
        worldX = (screenIndex + settings.centerX - screenCount / 2) * screenWorldWidth;
        worldY = (0.5 - settings.centerY) * worldHeight;
    } else {
        // Preserve the established single-screen 3D positioning semantics. The
        // screen's strip center is the origin for these local offsets.
        const screenCenterX = (screenIndex + 0.5 - screenCount / 2) * screenWorldWidth;
        const availableSpaceY = (1 - scale) * 2;
        const availableSpaceX = (1 - scale) * 0.9;
        worldX = screenCenterX + ((Number(settings.x ?? 50) - 50) / 50) * availableSpaceX;
        worldY = -((Number(settings.y ?? 50) - 50) / 50) * availableSpaceY;
    }

    pivot.position.set(worldX + basePositionOffset.x, worldY + basePositionOffset.y, basePositionOffset.z);
    pivot.scale.setScalar(scale);
    pivot.rotation.set(
        (Number(rotation3D.x || 0) + modelRotation.x) * Math.PI / 180,
        (Number(rotation3D.y || 0) + modelRotation.y) * Math.PI / 180,
        (Number(rotation3D.z || 0) + Number(settings.rotation || 0) + modelRotation.z) * Math.PI / 180
    );
}

function renderThreeDItemsToCanvas(targetCanvas, width, height, items) {
    if (!threeRenderer || !threeScene || !threeCamera || !targetCanvas || !Array.isArray(items)) return false;
    const dims = { width: width || 1290, height: height || 2796 };
    const targetContext = targetCanvas.getContext('2d');
    if (!targetContext) return false;
    const originalBackground = threeScene.background;
    const originalSize = threeRenderer.getSize(new THREE.Vector2());
    const originalPixelRatio = threeRenderer.getPixelRatio();
    const originalClearColor = threeRenderer.getClearColor(new THREE.Color()).clone();
    const originalClearAlpha = threeRenderer.getClearAlpha();
    const originalAspect = threeCamera.aspect;
    const originalView = getCameraViewSnapshot(threeCamera);
    let rendered = false;

    try {
        threeScene.background = null;
        threeRenderer.setPixelRatio(1);
        threeRenderer.setClearColor(0x000000, 0);
        threeRenderer.setSize(dims.width, dims.height, false);

        items.forEach(item => {
            if (!item?.image) return;
            const settings = item.settings || {};
            const deviceType = deviceConfigs[settings.device3D] ? settings.device3D : 'iphone';
            const handle = getThreeDModelHandle(deviceType);
            if (!handle) {
                requestThreeDModelForRender(deviceType);
                return;
            }

            const { model, pivot, screenPlane } = handle;
            if (!model || !pivot || !screenPlane) return;
            const originalParent = pivot.parent;
            const originalPosition = pivot.position.clone();
            const originalScale = pivot.scale.clone();
            const originalRotation = pivot.rotation.clone();
            const originalVisibility = pivot.visible;
            const currentVisibility = phonePivot?.visible;
            const originalScreenMaterial = screenPlane.material;
            const colorSnapshot = snapshotModelColors(model);
            let temporaryMaterial = null;

            try {
                const viewportCount = item.viewport?.screenCount === 2 ? 2 : 1;
                const viewportIndex = viewportCount === 2 && item.viewport?.screenIndex === 1 ? 1 : 0;
                threeCamera.aspect = (dims.width * viewportCount) / dims.height;
                if (viewportCount === 2) {
                    threeCamera.setViewOffset(
                        dims.width * viewportCount,
                        dims.height,
                        viewportIndex * dims.width,
                        0,
                        dims.width,
                        dims.height
                    );
                } else {
                    threeCamera.clearViewOffset();
                }
                threeCamera.updateProjectionMatrix();

                if (originalParent !== threeScene) threeScene.add(pivot);
                if (phonePivot && pivot !== phonePivot) phonePivot.visible = false;
                pivot.visible = true;
                applyModelFrameColor(model, settings.frameColor, deviceType);

                const sourceWidth = item.image.naturalWidth || item.image.width || 1;
                const roundedImage = createRoundedScreenImage(
                    item.image,
                    Math.round(sourceWidth * (deviceConfigs[deviceType]?.cornerRadiusFactor || 0))
                );
                const texture = new THREE.Texture(roundedImage);
                texture.needsUpdate = true;
                texture.encoding = THREE.sRGBEncoding;
                texture.flipY = true;
                temporaryMaterial = new THREE.MeshBasicMaterial({
                    map: texture,
                    side: THREE.FrontSide,
                    transparent: true
                });
                screenPlane.material = temporaryMaterial;
                applyThreeDPlacementTransform(pivot, settings, dims, viewportIndex, viewportCount, deviceType);

                threeRenderer.clear();
                threeRenderer.render(threeScene, threeCamera);
                targetContext.save();
                try {
                    targetContext.globalAlpha = Math.max(0, Math.min(1, Number(settings.opacity ?? 100) / 100));
                    targetContext.drawImage(threeRenderer.domElement, 0, 0, dims.width, dims.height);
                } finally {
                    targetContext.restore();
                }
                rendered = true;
            } finally {
                screenPlane.material = originalScreenMaterial;
                temporaryMaterial?.map?.dispose();
                temporaryMaterial?.dispose();
                restoreModelColors(colorSnapshot);
                pivot.position.copy(originalPosition);
                pivot.scale.copy(originalScale);
                pivot.rotation.copy(originalRotation);
                pivot.visible = originalVisibility;
                if (originalParent !== threeScene) {
                    threeScene.remove(pivot);
                    if (originalParent) originalParent.add(pivot);
                }
                if (phonePivot) phonePivot.visible = currentVisibility;
            }
        });
    } finally {
        threeRenderer.setPixelRatio(originalPixelRatio);
        threeRenderer.setSize(originalSize.x, originalSize.y, false);
        threeRenderer.setClearColor(originalClearColor, originalClearAlpha);
        threeScene.background = originalBackground;
        threeCamera.aspect = originalAspect;
        restoreCameraView(threeCamera, originalView);
        threeCamera.updateProjectionMatrix();
    }
    return rendered;
}

// Render every visible placement in template layer order. Standalone devices use
// a local camera; only the two halves of a linked seam share a two-screen camera.
function renderThreeJSToCanvas(targetCanvas, width, height, items, screenIndex) {
    if (!items && typeof state !== 'undefined') {
        const index = Number.isInteger(screenIndex) ? screenIndex : state.selectedIndex;
        const screenshot = state.screenshots[index];
        const fallbackImage = screenshot && typeof getScreenshotImage === 'function' ? getScreenshotImage(screenshot) : screenshot?.image;
        items = typeof getThreeDRenderItems === 'function' ? getThreeDRenderItems(screenshot, index, fallbackImage) : [];
    }
    return renderThreeDItemsToCanvas(targetCanvas, width, height, items || []);
}

// Render the same placement stack for a side preview without changing selection.
function renderThreeJSForScreenshot(targetCanvas, width, height, screenshotIndex, items) {
    if (!items && typeof state !== 'undefined') {
        const screenshot = state.screenshots[screenshotIndex];
        const fallbackImage = screenshot && typeof getScreenshotImage === 'function' ? getScreenshotImage(screenshot) : screenshot?.image;
        items = typeof getThreeDRenderItems === 'function' ? getThreeDRenderItems(screenshot, screenshotIndex, fallbackImage) : [];
    }
    return renderThreeDItemsToCanvas(targetCanvas, width, height, items || []);
}

// Show/hide Three.js container
function showThreeJS(show) {
    const container = document.getElementById('threejs-container');
    const canvas = document.getElementById('preview-canvas');

    // In 3D mode, we show the 2D canvas (which composites everything)
    // The Three.js container is hidden but used for rendering
    if (container) {
        container.style.display = 'none'; // Always hidden - we render to 2D canvas
    }
    if (canvas) {
        canvas.style.display = 'block'; // Always visible
    }

    if (show && !isThreeJSInitialized) {
        initThreeJS();
    }

    // Apply current rotation and background
    if (show && typeof state !== 'undefined') {
        updateThreeJSBackground();
        if (phoneModel) {
            const ss = typeof getScreenshotSettings === 'function' ? getScreenshotSettings() : state.defaults?.screenshot;
            const rotation3D = ss?.rotation3D || { x: 0, y: 0, z: 0 };
            setThreeJSRotation(rotation3D.x, rotation3D.y, rotation3D.z);
            updateScreenTexture();
        }
    }
    return !show || isThreeJSRendererReady();
}

// Get Three.js canvas for export
function getThreeJSCanvas() {
    return threeRenderer ? threeRenderer.domElement : null;
}

// Update Three.js scene background from state
function updateThreeJSBackground() {
    if (!threeScene || typeof state === 'undefined') return;

    // Use getBackground() helper if available, otherwise fall back to defaults
    const bg = typeof getBackground === 'function' ? getBackground() : state.defaults?.background;
    if (!bg) return;

    if (bg.type === 'solid') {
        threeScene.background = new THREE.Color(bg.solid);
    } else if (bg.type === 'gradient') {
        // Use the first gradient color as background (Three.js doesn't support gradients natively)
        const firstStop = bg.gradient.stops[0];
        if (firstStop) {
            threeScene.background = new THREE.Color(firstStop.color);
        }
    } else {
        // For image backgrounds, use a neutral color
        threeScene.background = new THREE.Color(0x1a1a2e);
    }

    // Trigger render update
    requestThreeJSRender();
}

// Cleanup
function disposeThreeJS() {
    if (screenTexture) {
        screenTexture.dispose();
    }
    if (threeRenderer) {
        threeRenderer.dispose();
    }
    isThreeJSInitialized = false;
    phoneModelLoaded = false;
}

// Interactive rotation/movement for 2D canvas in 3D mode
let isDragging3D = false;
let isAltDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;
let dragUpdatePending = false;

function getUse3D() {
    if (typeof getScreenshotSettings === 'function') {
        const ss = getScreenshotSettings();
        return ss?.use3D || false;
    }
    return state.defaults?.screenshot?.use3D || false;
}

function setup3DCanvasInteraction() {
    const canvas = document.getElementById('preview-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', (e) => {
        if (typeof state !== 'undefined' && getUse3D()) {
            isDragging3D = true;
            isAltDragging = e.altKey;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            canvas.style.cursor = isAltDragging ? 'move' : 'grabbing';
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDragging3D || typeof state === 'undefined' || !getUse3D()) return;
        // Don't rotate 3D device while dragging an element
        const wrapper = document.getElementById('canvas-wrapper');
        if (wrapper && wrapper.classList.contains('element-dragging')) {
            isDragging3D = false;
            isAltDragging = false;
            canvas.style.cursor = '';
            return;
        }

        const deltaX = e.clientX - lastMouseX;
        const deltaY = e.clientY - lastMouseY;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;

        // Get current screenshot settings
        const ss = typeof getScreenshotSettings === 'function' ? getScreenshotSettings() : state.defaults?.screenshot;
        if (!ss) return;

        if (isAltDragging) {
            // Alt+drag: move position (x, y)
            const position = typeof nudgeSelectedThreeDDevice === 'function'
                ? nudgeSelectedThreeDDevice(deltaX * 0.2, deltaY * 0.2)
                : null;
            if (!position) {
                ss.x = Math.max(-100, Math.min(200, ss.x + deltaX * 0.2));
                ss.y = Math.max(-100, Math.min(200, ss.y + deltaY * 0.2));
            }

            // Update sliders
            const nextX = position?.x ?? ss.x;
            const nextY = position?.y ?? ss.y;
            document.getElementById('screenshot-x').value = nextX;
            document.getElementById('screenshot-x-value').textContent = Math.round(nextX) + '%';
            document.getElementById('screenshot-y').value = nextY;
            document.getElementById('screenshot-y-value').textContent = Math.round(nextY) + '%';
        } else {
            // Regular drag: rotate
            if (!ss.rotation3D) ss.rotation3D = { x: 0, y: 0, z: 0 };

            const nextY = Math.max(-45, Math.min(45, ss.rotation3D.y + deltaX * 0.5));
            const nextX = Math.max(-45, Math.min(45, ss.rotation3D.x + deltaY * 0.5));
            if (typeof setLinkedThreeDRotation === 'function') {
                setLinkedThreeDRotation('y', nextY);
                setLinkedThreeDRotation('x', nextX);
            } else {
                ss.rotation3D.y = nextY;
                ss.rotation3D.x = nextX;
            }

            // Update sliders
            document.getElementById('rotation-3d-y').value = nextY;
            document.getElementById('rotation-3d-y-value').textContent = Math.round(nextY) + '°';
            document.getElementById('rotation-3d-x').value = nextX;
            document.getElementById('rotation-3d-x-value').textContent = Math.round(nextX) + '°';

            // Apply rotation directly to model (fast path - skip full updateCanvas)
            setThreeJSRotation(nextX, nextY, ss.rotation3D.z);
        }

        // Throttle updateCanvas calls using requestAnimationFrame
        if (!dragUpdatePending) {
            dragUpdatePending = true;
            requestAnimationFrame(() => {
                dragUpdatePending = false;
                if (typeof updateCanvas === 'function') {
                    updateCanvas();
                }
            });
        }
    });

    canvas.addEventListener('mouseup', () => {
        if (isDragging3D) {
            isDragging3D = false;
            isAltDragging = false;
            canvas.style.cursor = getUse3D() ? 'grab' : '';
        }
    });

    canvas.addEventListener('mouseleave', () => {
        if (isDragging3D) {
            isDragging3D = false;
            isAltDragging = false;
            canvas.style.cursor = '';
        }
    });

    // Change cursor when hovering in 3D mode
    canvas.addEventListener('mouseenter', () => {
        if (typeof state !== 'undefined' && getUse3D()) {
            canvas.style.cursor = 'grab';
        }
    });
}

// Initialize interaction when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup3DCanvasInteraction);
} else {
    setup3DCanvasInteraction();
}
