# App Store Screenshot Generator
# Lightweight nginx container serving static files

FROM nginx:alpine

LABEL maintainer="App Store Screenshot Generator"
LABEL description="Browser-based tool for creating App Store marketing screenshots"

# Remove default nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Copy application files
COPY index.html /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/
COPY styles.css /usr/share/nginx/html/
COPY ui-redesign.css /usr/share/nginx/html/
COPY three-renderer.js /usr/share/nginx/html/
COPY language-utils.js /usr/share/nginx/html/
COPY magical-titles.js /usr/share/nginx/html/
COPY llm.js /usr/share/nginx/html/
COPY ai-image-gen.js /usr/share/nginx/html/
COPY lucide-icons.js /usr/share/nginx/html/
COPY templates.js /usr/share/nginx/html/
COPY font-library.js /usr/share/nginx/html/

# Copy browser runtime modules without publishing tests or server-only SaaS code
COPY core/editor-bridge.mjs core/campaign.mjs core/render.mjs core/templates.mjs core/cloud-support.mjs core/canvas-primitives.mjs core/layout-qa.mjs /usr/share/nginx/html/core/
COPY saas/editor-cloud.js saas/api.js saas/session.js saas/auth.mjs saas/utils.mjs saas/editor-cloud.css /usr/share/nginx/html/saas/

# Copy assets
COPY models/ /usr/share/nginx/html/models/
COPY img/ /usr/share/nginx/html/img/
COPY render/fonts/ /usr/share/nginx/html/render/fonts/

# Copy custom nginx configuration for SPA and caching
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1/health || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
