// AI Image Generation
// Generates background images and device screen images
// Providers: Google Gemini, fal.ai Flux, OpenAI gpt-image-2, OpenAI gpt-image-1, OpenAI DALL-E 3

/** Current mode: 'background' | 'screenshot' */
let aiImageGenMode = 'background';

/** Available image generation models */
const IMAGE_GEN_MODELS = [
    {
        id: 'gemini-imagen-3',
        label: 'Google Gemini – Imagen 3 (latest)',
        provider: 'gemini',
        storageKey: 'googleApiKey',
        keyPlaceholder: 'AIza...'
    },
    {
        id: 'openai-gpt-image-2',
        label: 'OpenAI gpt-image-2 (latest)',
        provider: 'openai',
        storageKey: 'openaiApiKey',
        keyPlaceholder: 'sk-...'
    },
    {
        id: 'openai-gpt-image-1',
        label: 'OpenAI gpt-image-1',
        provider: 'openai',
        storageKey: 'openaiApiKey',
        keyPlaceholder: 'sk-...'
    },
    {
        id: 'openai-dalle3',
        label: 'OpenAI DALL-E 3',
        provider: 'openai',
        storageKey: 'openaiApiKey',
        keyPlaceholder: 'sk-...'
    },
    {
        id: 'fal-flux-pro',
        label: 'fal.ai – Flux Pro 1.1',
        provider: 'fal',
        storageKey: 'falApiKey',
        keyPlaceholder: 'key_id:key_secret'
    },
    {
        id: 'fal-flux-schnell',
        label: 'fal.ai – Flux Schnell (fast)',
        provider: 'fal',
        storageKey: 'falApiKey',
        keyPlaceholder: 'key_id:key_secret'
    }
];

/**
 * Get the currently selected image gen model config
 * @returns {Object}
 */
function getImageGenModel() {
    const saved = localStorage.getItem('imageGenModel');
    return IMAGE_GEN_MODELS.find(m => m.id === saved) || IMAGE_GEN_MODELS[0];
}

/**
 * Generate an image using Google Gemini Imagen 3
 * @param {string} apiKey - Google API key
 * @param {string} prompt
 * @returns {Promise<string>} data URL
 */
async function generateImageWithGemini(apiKey, prompt) {
    const model = 'imagen-3.0-generate-002';
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImages?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: { text: prompt },
                number_of_images: 1,
                aspect_ratio: '9:16',
                safety_filter_level: 'block_some',
                person_generation: 'allow_adult'
            })
        }
    );

    if (!response.ok) {
        const status = response.status;
        const errorBody = await response.json().catch(() => ({}));
        console.error('Gemini Imagen Error:', { status, error: errorBody });
        if (status === 401 || status === 403) throw new Error('INVALID_KEY');
        throw new Error(`Gemini error ${status}: ${errorBody.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    const imageBytes = data.generatedImages?.[0]?.imageBytes;
    if (!imageBytes) throw new Error('No image returned from Gemini Imagen');
    return `data:image/png;base64,${imageBytes}`;
}

/**
 * Generate an image using OpenAI (gpt-image-1 or DALL-E 3)
 * @param {string} apiKey
 * @param {string} prompt
 * @param {string} modelId - 'openai-gpt-image-1' | 'openai-dalle3'
 * @returns {Promise<string>} data URL
 */
async function generateImageWithOpenAI(apiKey, prompt, modelId) {
    let model, size;
    if (modelId === 'openai-dalle3') {
        model = 'dall-e-3';
        size = '1024x1792';
    } else if (modelId === 'openai-gpt-image-2') {
        model = 'gpt-image-2';
        size = '1024x1536';
    } else {
        model = 'gpt-image-1';
        size = '1024x1536';
    }

    const bodyParams = { model, prompt, n: 1, size };
    // dall-e-3 supports response_format; gpt-image-1 and gpt-image-2 always return b64_json
    if (modelId === 'openai-dalle3') bodyParams.response_format = 'b64_json';

    const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(bodyParams)
    });

    if (!response.ok) {
        const status = response.status;
        const errorBody = await response.json().catch(() => ({}));
        console.error('OpenAI Image Gen Error:', { status, model, error: errorBody });
        if (status === 401 || status === 403) throw new Error('INVALID_KEY');
        throw new Error(`OpenAI error ${status}: ${errorBody.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return `data:image/png;base64,${data.data[0].b64_json}`;
}

/**
 * Generate an image using fal.ai (Flux Pro 1.1 or Flux Schnell)
 * @param {string} apiKey - fal.ai key (key_id:key_secret)
 * @param {string} prompt
 * @param {string} modelId - 'fal-flux-pro' | 'fal-flux-schnell'
 * @returns {Promise<string>} data URL
 */
async function generateImageWithFal(apiKey, prompt, modelId) {
    const endpoint = modelId === 'fal-flux-pro'
        ? 'https://fal.run/fal-ai/flux-pro/v1.1'
        : 'https://fal.run/fal-ai/flux/schnell';

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Key ${apiKey}`
        },
        body: JSON.stringify({
            prompt: prompt,
            image_size: 'portrait_16_9',
            num_images: 1,
            output_format: 'jpeg',
            enable_safety_checker: true
        })
    });

    if (!response.ok) {
        const status = response.status;
        const errorBody = await response.json().catch(() => ({}));
        console.error('fal.ai Image Gen Error:', { status, error: errorBody });
        if (status === 401 || status === 403) throw new Error('INVALID_KEY');
        throw new Error(`fal.ai error ${status}: ${errorBody.detail || errorBody.message || 'Unknown error'}`);
    }

    const data = await response.json();
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error('No image returned from fal.ai');

    // Fetch the image and convert to data URL
    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) throw new Error('Failed to download generated image from fal.ai');
    const blob = await imgResponse.blob();
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Apply a generated image data URL to background or screenshot
 * @param {string} dataUrl
 * @param {string} mode - 'background' | 'screenshot'
 */
function applyGeneratedImage(dataUrl, mode) {
    const img = new Image();
    img.onload = function () {
        if (mode === 'background') {
            setBackground('type', 'image');
            setBackground('image', img);
            setBackground('imageSrc', dataUrl);
            document.querySelectorAll('#bg-type-selector button').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.type === 'image');
            });
            updateCanvas();
            syncUIWithState();
        } else if (mode === 'screenshot') {
            const lang = state.currentLanguage;
            const name = `ai-generated-${lang}.png`;

            if (state.screenshots.length === 0) {
                // No screenshots yet — create a blank slot first
                createNewScreenshot(null, null, name, lang, state.outputDevice);
                state.selectedIndex = 0;
                updateCanvas();
            }

            const idx = state.selectedIndex;
            addLocalizedImage(idx, lang, img, dataUrl, name);
        }
    };
    img.src = dataUrl;
}

/**
 * Update the API key field placeholder and value when model selection changes
 */
function onAIImageModelChange() {
    const select = document.getElementById('ai-image-gen-model');
    const keyInput = document.getElementById('ai-image-gen-apikey');
    if (!select || !keyInput) return;

    const modelConfig = IMAGE_GEN_MODELS.find(m => m.id === select.value);
    if (!modelConfig) return;

    keyInput.placeholder = modelConfig.keyPlaceholder;
    keyInput.value = localStorage.getItem(modelConfig.storageKey) || '';
    localStorage.setItem('imageGenModel', select.value);
}

/**
 * Show the AI image generation dialog
 * @param {string} mode - 'background' | 'screenshot'
 */
function showAIImageGenDialog(mode) {
    aiImageGenMode = mode;

    const modeEl = document.getElementById('ai-image-gen-mode-label');
    if (modeEl) modeEl.textContent = mode === 'background' ? 'Background Image' : 'Device Screen';

    // Populate model selector
    const select = document.getElementById('ai-image-gen-model');
    if (select) {
        select.innerHTML = IMAGE_GEN_MODELS
            .map(m => `<option value="${m.id}">${m.label}</option>`)
            .join('');
        const saved = localStorage.getItem('imageGenModel');
        if (saved) select.value = saved;
    }

    // Set API key field
    onAIImageModelChange();

    // Update prompt placeholder based on mode
    const promptEl = document.getElementById('ai-image-gen-prompt');
    if (promptEl) {
        promptEl.value = '';
        promptEl.placeholder = mode === 'background'
            ? 'e.g. A vibrant abstract gradient with deep purple and electric blue tones, futuristic, clean, suitable for a mobile app background'
            : 'e.g. A productivity app dashboard screen showing tasks and charts, clean iOS UI, light theme';
    }

    // Show info note for screenshot mode when no screenshot selected
    const infoEl = document.getElementById('ai-image-gen-info');
    if (infoEl) {
        if (mode === 'screenshot' && state.screenshots.length === 0) {
            infoEl.textContent = 'No screenshot selected \u2014 a new screen will be created with the generated image.';
            infoEl.style.display = '';
        } else if (mode === 'screenshot') {
            infoEl.textContent = `Generated image will replace the device screen on screenshot \u201c${state.screenshots[state.selectedIndex]?.name || '#' + (state.selectedIndex + 1)}\u201d.`;
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }

    const statusEl = document.getElementById('ai-image-gen-status');
    if (statusEl) statusEl.style.display = 'none';

    const modal = document.getElementById('ai-image-gen-modal');
    if (modal) modal.classList.add('visible');
}

/**
 * Hide the AI image generation dialog
 */
function hideAIImageGenDialog() {
    const modal = document.getElementById('ai-image-gen-modal');
    if (modal) modal.classList.remove('visible');
}

/**
 * Trigger image generation from the modal
 */
async function runAIImageGen() {
    const promptEl = document.getElementById('ai-image-gen-prompt');
    const prompt = promptEl?.value?.trim();
    if (!prompt) {
        showAppAlert('Please enter a prompt describing the image.', 'info');
        return;
    }

    const select = document.getElementById('ai-image-gen-model');
    const modelId = select?.value;
    const modelConfig = IMAGE_GEN_MODELS.find(m => m.id === modelId);
    if (!modelConfig) return;

    const keyInput = document.getElementById('ai-image-gen-apikey');
    const apiKey = keyInput?.value?.trim();
    if (!apiKey) {
        showAppAlert('Please enter your API key.', 'info');
        keyInput?.focus();
        return;
    }

    // Persist API key
    localStorage.setItem(modelConfig.storageKey, apiKey);
    localStorage.setItem('imageGenModel', modelId);

    const confirmBtn = document.getElementById('ai-image-gen-confirm');
    const originalText = confirmBtn?.textContent;
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Generating…';
    }

    const statusEl = document.getElementById('ai-image-gen-status');
    if (statusEl) {
        statusEl.textContent = 'Generating image, this may take a moment…';
        statusEl.style.display = '';
    }

    try {
        let dataUrl;
        if (modelConfig.provider === 'gemini') {
            dataUrl = await generateImageWithGemini(apiKey, prompt);
        } else if (modelConfig.provider === 'openai') {
            dataUrl = await generateImageWithOpenAI(apiKey, prompt, modelId);
        } else if (modelConfig.provider === 'fal') {
            dataUrl = await generateImageWithFal(apiKey, prompt, modelId);
        } else {
            throw new Error('Unknown provider');
        }

        hideAIImageGenDialog();
        applyGeneratedImage(dataUrl, aiImageGenMode);
        showAppAlert(
            aiImageGenMode === 'background'
                ? 'Background image generated successfully.'
                : 'Device screen image generated successfully.',
            'success'
        );
    } catch (err) {
        console.error('AI Image Gen error:', err);
        if (statusEl) statusEl.style.display = 'none';
        if (err.message === 'INVALID_KEY') {
            showAppAlert('Invalid API key. Please check and try again.', 'error');
        } else {
            showAppAlert(`Generation failed: ${err.message}`, 'error');
        }
    } finally {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = originalText || 'Generate';
        }
        if (statusEl) statusEl.style.display = 'none';
    }
}

/**
 * Initialize AI image generation modal event listeners
 */
function initAIImageGen() {
    const cancelBtn = document.getElementById('ai-image-gen-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', hideAIImageGenDialog);

    const confirmBtn = document.getElementById('ai-image-gen-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', runAIImageGen);

    const modelSelect = document.getElementById('ai-image-gen-model');
    if (modelSelect) modelSelect.addEventListener('change', onAIImageModelChange);

    const overlay = document.getElementById('ai-image-gen-modal');
    if (overlay) {
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) hideAIImageGenDialog();
        });
    }

    // Background AI generate button
    const bgAiBtn = document.getElementById('bg-ai-generate-btn');
    if (bgAiBtn) bgAiBtn.addEventListener('click', () => showAIImageGenDialog('background'));

    // Screenshot AI generate button (left sidebar)
    const screenshotAiBtn = document.getElementById('screenshot-ai-generate-btn');
    if (screenshotAiBtn) screenshotAiBtn.addEventListener('click', () => showAIImageGenDialog('screenshot'));

    // Screenshot AI generate button (Device tab)
    const screenshotAiBtnDevice = document.getElementById('screenshot-ai-generate-btn-device');
    if (screenshotAiBtnDevice) screenshotAiBtnDevice.addEventListener('click', () => showAIImageGenDialog('screenshot'));
}

// Auto-init when DOM is ready
document.addEventListener('DOMContentLoaded', initAIImageGen);
