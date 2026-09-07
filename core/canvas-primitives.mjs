// Canvas primitives extracted from the existing editor. No editor state or persistence dependencies.

export function drawBackgroundToContext(context, dims, bg) {
    if (bg.type === 'gradient') {
        const angle = bg.gradient.angle * Math.PI / 180;
        const x1 = dims.width / 2 - Math.cos(angle) * dims.width;
        const y1 = dims.height / 2 - Math.sin(angle) * dims.height;
        const x2 = dims.width / 2 + Math.cos(angle) * dims.width;
        const y2 = dims.height / 2 + Math.sin(angle) * dims.height;

        const gradient = context.createLinearGradient(x1, y1, x2, y2);
        bg.gradient.stops.forEach(stop => {
            gradient.addColorStop(stop.position / 100, stop.color);
        });

        context.fillStyle = gradient;
        context.fillRect(0, 0, dims.width, dims.height);
    } else if (bg.type === 'solid') {
        context.fillStyle = bg.solid;
        context.fillRect(0, 0, dims.width, dims.height);
    } else if (bg.type === 'image' && bg.image) {
        const img = bg.image;
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        let dx = 0, dy = 0, dw = dims.width, dh = dims.height;

        if (bg.imageFit === 'cover') {
            const imgRatio = img.width / img.height;
            const canvasRatio = dims.width / dims.height;

            if (imgRatio > canvasRatio) {
                sw = img.height * canvasRatio;
                sx = (img.width - sw) / 2;
            } else {
                sh = img.width / canvasRatio;
                sy = (img.height - sh) / 2;
            }
        } else if (bg.imageFit === 'contain') {
            const imgRatio = img.width / img.height;
            const canvasRatio = dims.width / dims.height;

            if (imgRatio > canvasRatio) {
                dh = dims.width / imgRatio;
                dy = (dims.height - dh) / 2;
            } else {
                dw = dims.height * imgRatio;
                dx = (dims.width - dw) / 2;
            }

            context.fillStyle = '#000';
            context.fillRect(0, 0, dims.width, dims.height);
        }

        if (bg.imageBlur > 0) {
            context.filter = `blur(${bg.imageBlur}px)`;
        }

        context.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        context.filter = 'none';

        if (bg.overlayOpacity > 0) {
            context.fillStyle = bg.overlayColor;
            context.globalAlpha = bg.overlayOpacity / 100;
            context.fillRect(0, 0, dims.width, dims.height);
            context.globalAlpha = 1;
        }
    }
}

// Shared by drawing and layout QA so crop/position math cannot drift apart.
export function getScreenshotGeometry(dims, img, settings) {
    const crop = settings.crop;
    const sourceX = crop ? img.width * (crop.x || 0) / 100 : 0;
    const sourceY = crop ? img.height * (crop.y || 0) / 100 : 0;
    const sourceWidth = crop ? img.width * (crop.width ?? 100) / 100 : img.width;
    const sourceHeight = crop ? img.height * (crop.height ?? 100) / 100 : img.height;
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('Device crop must have positive width and height');

    const scale = settings.scale / 100;
    let imgWidth = dims.width * scale;
    let imgHeight = (sourceHeight / sourceWidth) * imgWidth;

    if (imgHeight > dims.height * scale) {
        imgHeight = dims.height * scale;
        imgWidth = (sourceWidth / sourceHeight) * imgHeight;
    }

    let x;
    let y;
    let centerX;
    let centerY;
    if (settings.positionMode === 'canvas' && Number.isFinite(settings.centerX) && Number.isFinite(settings.centerY)) {
        centerX = dims.width * settings.centerX;
        centerY = dims.height * settings.centerY;
        x = centerX - imgWidth / 2;
        y = centerY - imgHeight / 2;
    } else {
        // Ensure minimum movement range so position works even at 100% scale
        const moveX = Math.max(dims.width - imgWidth, dims.width * 0.15);
        const moveY = Math.max(dims.height - imgHeight, dims.height * 0.15);
        x = (dims.width - imgWidth) / 2 + (settings.x / 100 - 0.5) * moveX;
        y = (dims.height - imgHeight) / 2 + (settings.y / 100 - 0.5) * moveY;
        centerX = x + imgWidth / 2;
        centerY = y + imgHeight / 2;
    }

    return { sourceX, sourceY, sourceWidth, sourceHeight, imgWidth, imgHeight, x, y, centerX, centerY };
}

export function drawScreenshotToContext(context, dims, img, settings) {
    if (!img) return;
    const { sourceX, sourceY, sourceWidth, sourceHeight, imgWidth, imgHeight, x, y, centerX, centerY } = getScreenshotGeometry(dims, img, settings);

    context.save();

    // Apply transformations
    context.translate(centerX, centerY);

    // Apply rotation
    if (settings.rotation !== 0) {
        context.rotate(settings.rotation * Math.PI / 180);
    }

    // Apply perspective (simulated with scale transform)
    if (settings.perspective !== 0) {
        context.transform(1, settings.perspective * 0.01, 0, 1, 0, 0);
    }

    context.translate(-centerX, -centerY);

    // Scale corner radius with image size
    const radius = (settings.cornerRadius || 0) * (imgWidth / 400);

    // Draw shadow first (needs a filled shape, not clipped)
    if (settings.shadow && settings.shadow.enabled) {
        const shadowOpacity = settings.shadow.opacity / 100;
        const shadowColor = settings.shadow.color + Math.round(shadowOpacity * 255).toString(16).padStart(2, '0');
        context.shadowColor = shadowColor;
        context.shadowBlur = settings.shadow.blur;
        context.shadowOffsetX = settings.shadow.x;
        context.shadowOffsetY = settings.shadow.y;

        // Draw filled rounded rect for shadow
        context.fillStyle = '#000';
        context.beginPath();
        context.roundRect(x, y, imgWidth, imgHeight, radius);
        context.fill();

        // Reset shadow before drawing image
        context.shadowColor = 'transparent';
        context.shadowBlur = 0;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
    }

    // Clip and draw image
    context.beginPath();
    context.roundRect(x, y, imgWidth, imgHeight, radius);
    context.clip();
    context.drawImage(img, sourceX, sourceY, sourceWidth, sourceHeight, x, y, imgWidth, imgHeight);

    context.restore();

    // Draw device frame if enabled
    if (settings.frame && settings.frame.enabled) {
        context.save();
        context.translate(centerX, centerY);
        if (settings.rotation !== 0) {
            context.rotate(settings.rotation * Math.PI / 180);
        }
        if (settings.perspective !== 0) {
            context.transform(1, settings.perspective * 0.01, 0, 1, 0, 0);
        }
        context.translate(-centerX, -centerY);
        drawDeviceFrameToContext(context, x, y, imgWidth, imgHeight, settings);
        context.restore();
    }
}

export function drawDeviceFrameToContext(context, x, y, width, height, settings) {
    const frameColor = settings.frame.color;
    const frameWidth = settings.frame.width * (width / 400);
    const frameOpacity = settings.frame.opacity / 100;
    const radius = (settings.cornerRadius || 0) * (width / 400) + frameWidth;

    const inheritedAlpha = context.globalAlpha;
    context.globalAlpha = inheritedAlpha * frameOpacity;
    context.strokeStyle = frameColor;
    context.lineWidth = frameWidth;
    context.beginPath();
    context.roundRect(x - frameWidth / 2, y - frameWidth / 2, width + frameWidth, height + frameWidth, radius);
    context.stroke();
    context.globalAlpha = inheritedAlpha;
}

export function drawTextToContext(context, dims, txt) {
    // Check enabled states (default headline to true for backwards compatibility)
    const headlineEnabled = txt.headlineEnabled !== false;
    const subheadlineEnabled = txt.subheadlineEnabled || false;

    const headlineLang = txt.currentHeadlineLang || 'en';
    const subheadlineLang = txt.currentSubheadlineLang || 'en';
    const layoutLang = getTextLayoutLanguage(txt);
    const headlineLayout = getEffectiveLayout(txt, headlineLang);
    const subheadlineLayout = getEffectiveLayout(txt, subheadlineLang);
    const layoutSettings = getEffectiveLayout(txt, layoutLang);

    const headline = headlineEnabled && txt.headlines ? (txt.headlines[headlineLang] || '') : '';
    const subheadline = subheadlineEnabled && txt.subheadlines ? (txt.subheadlines[subheadlineLang] || '') : '';

    if (!headline && !subheadline) return;

    const blockWidth = dims.width * ((txt.blockWidth || 84) / 100);
    const blockX = dims.width * ((txt.blockX ?? 50) / 100);
    const padding = (dims.width - blockWidth) / 2;
    const textY = layoutSettings.position === 'top'
        ? dims.height * (layoutSettings.offsetY / 100)
        : dims.height * (1 - layoutSettings.offsetY / 100);

    context.textAlign = txt.align || 'center';
    context.textBaseline = layoutSettings.position === 'top' ? 'top' : 'bottom';

    let currentY = textY;

    // Draw headline
    if (headline) {
        const fontStyle = txt.headlineItalic ? 'italic' : 'normal';
        context.font = `${fontStyle} ${txt.headlineWeight} ${headlineLayout.headlineSize}px ${txt.headlineFont}`;
        if (txt.headlineGradient) {
            const angle = (txt.headlineGradientAngle || 90) * Math.PI / 180;
            const cx = dims.width / 2, cy = dims.height / 2;
            const len = Math.max(dims.width, dims.height);
            const x1 = cx - Math.cos(angle) * len / 2;
            const y1 = cy - Math.sin(angle) * len / 2;
            const x2 = cx + Math.cos(angle) * len / 2;
            const y2 = cy + Math.sin(angle) * len / 2;
            const grad = context.createLinearGradient(x1, y1, x2, y2);
            const stops = txt.headlineGradientStops || [
                { color: txt.headlineColor, position: 0 },
                { color: txt.headlineGradientColor || '#10B981', position: 100 }
            ];
            stops.forEach(s => grad.addColorStop(Math.min(1, Math.max(0, s.position / 100)), s.color));
            context.fillStyle = grad;
        } else {
            context.fillStyle = txt.headlineColor;
        }

        const lines = wrapText(context, headline, blockWidth);
        const lineHeight = headlineLayout.headlineSize * (layoutSettings.lineHeight / 100);

        // For bottom positioning, offset currentY so lines draw correctly
        if (layoutSettings.position === 'bottom') {
            currentY -= (lines.length - 1) * lineHeight;
        }

        let lastLineY;
        lines.forEach((line, i) => {
            const y = currentY + i * lineHeight;
            lastLineY = y;
            const textX = txt.align === 'left' ? blockX - blockWidth / 2 : txt.align === 'right' ? blockX + blockWidth / 2 : blockX;
            context.fillText(line, textX, y);

            // Calculate text metrics for decorations
            const textWidth = context.measureText(line).width;
            const fontSize = headlineLayout.headlineSize;
            const lineThickness = Math.max(2, fontSize * 0.05);
            const x = dims.width / 2 - textWidth / 2;

            // Draw underline
            if (txt.headlineUnderline) {
                const underlineY = layoutSettings.position === 'top'
                    ? y + fontSize * 0.9
                    : y + fontSize * 0.1;
                context.fillRect(x, underlineY, textWidth, lineThickness);
            }

            // Draw strikethrough
            if (txt.headlineStrikethrough) {
                const strikeY = layoutSettings.position === 'top'
                    ? y + fontSize * 0.4
                    : y - fontSize * 0.4;
                context.fillRect(x, strikeY, textWidth, lineThickness);
            }
        });

        // Track where subheadline should start (below the bottom edge of headline)
        // The gap between headline and subheadline should be (lineHeight - fontSize)
        // This is the "extra" spacing beyond the text itself
        const gap = lineHeight - headlineLayout.headlineSize;
        if (layoutSettings.position === 'top') {
            // For top: lastLineY is top of last line, add fontSize to get bottom, then add gap
            currentY = lastLineY + headlineLayout.headlineSize + gap;
        } else {
            // For bottom: lastLineY is already the bottom of last line, just add gap
            currentY = lastLineY + gap;
        }
    }

    // Draw subheadline (always below headline visually)
    if (subheadline) {
        const subFontStyle = txt.subheadlineItalic ? 'italic' : 'normal';
        const subWeight = txt.subheadlineWeight || '400';
        context.font = `${subFontStyle} ${subWeight} ${subheadlineLayout.subheadlineSize}px ${txt.subheadlineFont || txt.headlineFont}`;
        if (txt.subheadlineGradient) {
            const angle = (txt.subheadlineGradientAngle || 90) * Math.PI / 180;
            const cx = dims.width / 2, cy = dims.height / 2;
            const len = Math.max(dims.width, dims.height);
            const x1 = cx - Math.cos(angle) * len / 2;
            const y1 = cy - Math.sin(angle) * len / 2;
            const x2 = cx + Math.cos(angle) * len / 2;
            const y2 = cy + Math.sin(angle) * len / 2;
            const grad = context.createLinearGradient(x1, y1, x2, y2);
            const stops = txt.subheadlineGradientStops || [
                { color: '#ffffff', position: 0 },
                { color: '#10B981', position: 100 }
            ];
            const opacity = txt.subheadlineOpacity / 100;
            stops.forEach(s => grad.addColorStop(Math.min(1, Math.max(0, s.position / 100)), hexToRgba(s.color, opacity)));
            context.fillStyle = grad;
        } else {
            context.fillStyle = hexToRgba(txt.subheadlineColor, txt.subheadlineOpacity / 100);
        }

        const lines = wrapText(context, subheadline, blockWidth);
        const subLineHeight = subheadlineLayout.subheadlineSize * 1.4;

        // Subheadline starts after headline with gap determined by headline lineHeight
        // For bottom position, switch to 'top' baseline so subheadline draws downward
        const subY = currentY;
        if (layoutSettings.position === 'bottom') {
            context.textBaseline = 'top';
        }

        lines.forEach((line, i) => {
            const y = subY + i * subLineHeight;
            const textX = txt.align === 'left' ? blockX - blockWidth / 2 : txt.align === 'right' ? blockX + blockWidth / 2 : blockX;
            context.fillText(line, textX, y);

            // Calculate text metrics for decorations
            const textWidth = context.measureText(line).width;
            const fontSize = subheadlineLayout.subheadlineSize;
            const lineThickness = Math.max(2, fontSize * 0.05);
            const x = dims.width / 2 - textWidth / 2;

            // Draw underline (using 'top' baseline for subheadline)
            if (txt.subheadlineUnderline) {
                const underlineY = y + fontSize * 0.9;
                context.fillRect(x, underlineY, textWidth, lineThickness);
            }

            // Draw strikethrough
            if (txt.subheadlineStrikethrough) {
                const strikeY = y + fontSize * 0.4;
                context.fillRect(x, strikeY, textWidth, lineThickness);
            }
        });

        // Restore baseline if we changed it
        if (layoutSettings.position === 'bottom') {
            context.textBaseline = 'bottom';
        }
    }
}

export function drawElementsToContext(context, dims, elements, layer) {
    const filtered = elements.filter(el => el.layer === layer);
    filtered.forEach(el => {
        context.save();
        context.globalAlpha = el.opacity / 100;

        const cx = dims.width * (el.x / 100);
        const cy = dims.height * (el.y / 100);
        const elWidth = dims.width * (el.width / 100);

        context.translate(cx, cy);
        if (el.rotation !== 0) {
            context.rotate(el.rotation * Math.PI / 180);
        }

        if (el.type === 'shape') {
            const elHeight = dims.height * ((el.height ?? el.width) / 100);
            context.fillStyle = el.fill || '#ffffff';
            context.beginPath();
            if (el.shapeType === 'ellipse') {
                context.ellipse(0, 0, elWidth / 2, elHeight / 2, 0, 0, Math.PI * 2);
            } else {
                context.roundRect(-elWidth / 2, -elHeight / 2, elWidth, elHeight, el.cornerRadius || 0);
            }
            context.fill();
        } else if (el.type === 'emoji' && el.emoji) {
            const emojiSize = elWidth * 0.85;
            context.font = `${emojiSize}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(el.emoji, 0, 0);
        } else if (el.type === 'icon' && el.image) {
            // Shadow
            if (el.iconShadow?.enabled) {
                const s = el.iconShadow;
                const hex = s.color || '#000000';
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                context.shadowColor = `rgba(${r},${g},${b},${(s.opacity || 0) / 100})`;
                context.shadowBlur = s.blur || 0;
                context.shadowOffsetX = s.x || 0;
                context.shadowOffsetY = s.y || 0;
            }
            // Icons are square (1:1)
            context.drawImage(el.image, -elWidth / 2, -elWidth / 2, elWidth, elWidth);
            // Reset shadow
            if (el.iconShadow?.enabled) {
                context.shadowColor = 'transparent';
                context.shadowBlur = 0;
                context.shadowOffsetX = 0;
                context.shadowOffsetY = 0;
            }
        } else if (el.type === 'graphic' && el.image) {
            const aspect = el.image.height / el.image.width;
            const elHeight = elWidth * aspect;
            context.drawImage(el.image, -elWidth / 2, -elHeight / 2, elWidth, elHeight);
        } else if (el.type === 'text') {
            const elText = getElementText(el);
            if (!elText) { context.restore(); return; }
            const fontStyle = el.italic ? 'italic' : 'normal';
            context.font = `${fontStyle} ${el.fontWeight} ${el.fontSize}px ${el.font}`;
            context.fillStyle = el.fontColor;
            context.textAlign = 'center';
            context.textBaseline = 'middle';

            // Word-wrap text within element width (respects manual line breaks)
            const lines = wrapText(context, elText, elWidth);
            const lineHeight = el.fontSize * 1.05;
            const totalHeight = (lines.length - 1) * lineHeight + el.fontSize;

            // Draw frame behind text if enabled
            if (el.frame && el.frame !== 'none') {
                drawElementFrame(context, el, dims, elWidth, totalHeight);
            }

            // Draw text lines
            const startY = -(totalHeight / 2) + el.fontSize / 2;
            lines.forEach((line, i) => {
                context.fillText(line, 0, startY + i * lineHeight);
            });
        }

        context.restore();
    });
}

export function drawPopoutsToContext(context, dims, popouts, img, screenshotSettings) {
    if (!img || !popouts || popouts.length === 0) return;

    popouts.forEach(p => {
        context.save();
        context.globalAlpha = p.opacity / 100;

        // Crop from source image (percentages -> pixels)
        const sx = (p.cropX / 100) * img.width;
        const sy = (p.cropY / 100) * img.height;
        const sw = (p.cropWidth / 100) * img.width;
        const sh = (p.cropHeight / 100) * img.height;

        // Display position and size (percentages -> canvas pixels)
        const displayW = dims.width * (p.width / 100);
        const cropAspect = sh / sw;
        const displayH = displayW * cropAspect;
        const cx = dims.width * (p.x / 100);
        const cy = dims.height * (p.y / 100);

        context.translate(cx, cy);

        // Apply popout's own rotation only (no 3D transform inheritance)
        if (p.rotation !== 0) {
            context.rotate(p.rotation * Math.PI / 180);
        }

        const halfW = displayW / 2;
        const halfH = displayH / 2;
        const radius = p.cornerRadius * (displayW / 300);

        // Draw shadow
        if (p.shadow && p.shadow.enabled) {
            const shadowOpacity = p.shadow.opacity / 100;
            const hex = p.shadow.color || '#000000';
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            context.shadowColor = `rgba(${r},${g},${b},${shadowOpacity})`;
            context.shadowBlur = p.shadow.blur;
            context.shadowOffsetX = p.shadow.x;
            context.shadowOffsetY = p.shadow.y;

            context.fillStyle = '#000';
            context.beginPath();
            context.roundRect(-halfW, -halfH, displayW, displayH, radius);
            context.fill();

            context.shadowColor = 'transparent';
            context.shadowBlur = 0;
            context.shadowOffsetX = 0;
            context.shadowOffsetY = 0;
        }

        // Draw border behind the image
        if (p.border && p.border.enabled) {
            const bw = p.border.width;
            context.save();
            context.globalAlpha = (p.opacity / 100) * (p.border.opacity / 100);
            context.fillStyle = p.border.color;
            context.beginPath();
            context.roundRect(-halfW - bw, -halfH - bw, displayW + bw * 2, displayH + bw * 2, radius + bw);
            context.fill();
            context.restore();
        }

        // Clip and draw cropped image
        context.beginPath();
        context.roundRect(-halfW, -halfH, displayW, displayH, radius);
        context.clip();
        context.drawImage(img, sx, sy, sw, sh, -halfW, -halfH, displayW, displayH);

        context.restore();
    });
}

export function drawElementFrame(context, el, dims, textWidth, textHeight) {
    const scale = el.frameScale / 100;
    const padding = el.fontSize * 0.4 * scale;
    // Measure the widest line (using wrapText to match rendering)
    const elWidth = dims.width * (el.width / 100);
    const lines = wrapText(context, getElementText(el), elWidth);
    const maxLineW = Math.max(...lines.map(l => context.measureText(l).width));
    const frameW = maxLineW + padding * 2;
    const frameH = textHeight + padding * 2;

    context.save();
    context.strokeStyle = el.frameColor;
    context.fillStyle = 'none';
    context.lineWidth = Math.max(2, el.fontSize * 0.04) * scale;

    const isLaurel = el.frame.startsWith('laurel-');
    const hasStar = el.frame.endsWith('-star');

    if (isLaurel) {
        const variant = el.frame.includes('detailed') ? 'laurel-detailed-left' : 'laurel-simple-left';
        drawLaurelSVG(context, variant, frameW, frameH, scale, el.frameColor);
        if (hasStar) {
            drawStar(context, 0, -frameH / 2 - el.fontSize * 0.2 * scale, el.fontSize * 0.3 * scale, el.frameColor);
        }
    } else if (el.frame === 'badge-circle') {
        context.beginPath();
        const radius = Math.max(frameW, frameH) / 2 + padding * 0.5;
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.stroke();
    } else if (el.frame === 'badge-ribbon') {
        const sw = frameW + padding;
        const sh = frameH + padding * 1.5;
        context.beginPath();
        context.moveTo(-sw / 2, -sh / 2);
        context.lineTo(sw / 2, -sh / 2);
        context.lineTo(sw / 2, sh / 2 - padding);
        context.lineTo(0, sh / 2);
        context.lineTo(-sw / 2, sh / 2 - padding);
        context.closePath();
        context.stroke();
    }

    context.restore();
}

export function drawLaurelSVG(context, variant, w, h, scale, color) {
    const img = laurelImages[variant];
    if (!img || !img.complete || !img.naturalWidth) return;

    // Scale SVG branch to match the frame height
    const branchH = h * 1.1 * scale;
    const aspect = img.naturalWidth / img.naturalHeight;
    const branchW = branchH * aspect;

    // The SVG is black fill — use a temp canvas to recolor it
    const tmp = document.createElement('canvas');
    tmp.width = Math.ceil(branchW);
    tmp.height = Math.ceil(branchH);
    const tctx = tmp.getContext('2d');

    // Draw the SVG scaled into the temp canvas
    tctx.drawImage(img, 0, 0, branchW, branchH);

    // Recolor: draw color on top using source-in composite
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, branchW, branchH);

    // Position: left branch sits to the left of the text area
    const gap = 2 * scale;
    const leftX = -w / 2 - branchW - gap;
    const topY = -branchH / 2;

    // Draw left branch
    context.drawImage(tmp, leftX, topY, branchW, branchH);

    // Draw right branch (mirrored horizontally)
    context.save();
    context.scale(-1, 1);
    context.drawImage(tmp, leftX, topY, branchW, branchH);
    context.restore();
}

export function drawStar(context, cx, cy, size, color) {
    context.save();
    context.fillStyle = color;
    context.beginPath();
    for (let i = 0; i < 5; i++) {
        const outer = (i * 2 * Math.PI / 5) - Math.PI / 2;
        const inner = outer + Math.PI / 5;
        const ox = cx + Math.cos(outer) * size;
        const oy = cy + Math.sin(outer) * size;
        const ix = cx + Math.cos(inner) * size * 0.4;
        const iy = cy + Math.sin(inner) * size * 0.4;
        if (i === 0) context.moveTo(ox, oy);
        else context.lineTo(ox, oy);
        context.lineTo(ix, iy);
    }
    context.closePath();
    context.fill();
    context.restore();
}

export function wrapText(ctx, text, maxWidth) {
    const lines = [];
    const rawLines = String(text).split(/\r?\n/);

    rawLines.forEach((rawLine) => {
        if (rawLine === '') {
            lines.push('');
            return;
        }

        const words = rawLine.split(' ');
        let currentLine = '';

        words.forEach(word => {
            const testLine = currentLine + (currentLine ? ' ' : '') + word;
            const metrics = ctx.measureText(testLine);

            if (metrics.width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        });

        if (currentLine) {
            lines.push(currentLine);
        }

    });

    return lines;
}

export function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const laurelImages = {};
function getTextLayoutLanguage(text) { return text.currentLayoutLang || text.currentHeadlineLang || "en"; }
function getEffectiveLayout(text,lang) { const base={ headlineSize:text.headlineSize||100, subheadlineSize:text.subheadlineSize||50, position:text.position||"top", offsetY:text.offsetY??12, lineHeight:text.lineHeight||110 }; return text.perLanguageLayout ? {...base,...text.languageSettings?.[lang]} : base; }
function getElementText(el) { return el.text || ""; }
