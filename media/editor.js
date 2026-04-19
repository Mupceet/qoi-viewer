(function () {
    const vscode = acquireVsCodeApi();

    var canvas = document.getElementById('canvas');
    var ctx = canvas.getContext('2d');
    var container = document.getElementById('canvas-container');
    var errorDiv = document.getElementById('error');

    // Zoom state
    var zoomLevel = 1;
    var baseScale = 1;
    var panX = 0;
    var panY = 0;
    var isPanning = false;
    var panStartX = 0;
    var panStartY = 0;
    var panStartOffsetX = 0;
    var panStartOffsetY = 0;
    var imageLoaded = false;

    var MIN_ZOOM = 0.1;
    var MAX_ZOOM = 32;
    var ZOOM_STEP = 1.15;

    // Chunked transfer state
    var pendingImage = null;
    var chunkQueue = [];
    var chunkDraining = false;

    function computeBaseScale() {
        var cw = container.clientWidth;
        var ch = container.clientHeight;
        var iw = canvas.width;
        var ih = canvas.height;
        if (iw === 0 || ih === 0) return;
        baseScale = Math.min(cw / iw, ch / ih, 1);
    }

    function applyTransform() {
        var w = Math.round(canvas.width * baseScale * zoomLevel);
        var h = Math.round(canvas.height * baseScale * zoomLevel);
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px)';
        container.classList.toggle('pannable', zoomLevel > 1 && !isPanning);
        if (imageLoaded) {
            vscode.postMessage({ type: 'zoom', value: zoomLevel });
        }
    }

    function resetView() {
        zoomLevel = 1;
        panX = 0;
        panY = 0;
        computeBaseScale();
        applyTransform();
        vscode.postMessage({ type: 'zoom', value: 'fit' });
    }

    function zoomBy(factor) {
        if (!imageLoaded) return;
        var oldZoom = zoomLevel;
        zoomLevel = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor));
        var ratio = zoomLevel / oldZoom;
        panX *= ratio;
        panY *= ratio;
        applyTransform();
    }

    // Mouse wheel zoom centered on cursor
    container.addEventListener('wheel', function (e) {
        if (!imageLoaded) return;
        e.preventDefault();
        var rect = container.getBoundingClientRect();
        var cx = e.clientX - rect.left - rect.width / 2;
        var cy = e.clientY - rect.top - rect.height / 2;
        var oldZoom = zoomLevel;
        var factor = e.deltaY < 0 ? ZOOM_STEP : (1 / ZOOM_STEP);
        zoomLevel = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor));
        var ratio = zoomLevel / oldZoom;
        panX = cx - ratio * (cx - panX);
        panY = cy - ratio * (cy - panY);
        applyTransform();
    }, { passive: false });

    // Drag to pan
    container.addEventListener('mousedown', function (e) {
        if (!imageLoaded) return;
        isPanning = true;
        panStartX = e.clientX;
        panStartY = e.clientY;
        panStartOffsetX = panX;
        panStartOffsetY = panY;
        container.classList.remove('pannable');
        container.classList.add('panning');
        e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
        if (!isPanning) return;
        panX = panStartOffsetX + (e.clientX - panStartX);
        panY = panStartOffsetY + (e.clientY - panStartY);
        applyTransform();
    });

    window.addEventListener('mouseup', function () {
        if (!isPanning) return;
        isPanning = false;
        container.classList.remove('panning');
        container.classList.toggle('pannable', zoomLevel > 1);
    });

    // Right-click context menu → export PNG
    container.addEventListener('contextmenu', function (e) {
        if (!imageLoaded) return;
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({ type: 'showContextMenu' });
    });

    // ── Image rendering helpers ────────────────────────────────────

    function finalizeImage(msg) {
        canvas.style.display = 'block';
        errorDiv.style.display = 'none';

        var displayName = msg.name || '';
        var sizeStr = msg.fileSize < 1024 ? msg.fileSize + ' B'
            : msg.fileSize < 1048576 ? (msg.fileSize / 1024).toFixed(1) + ' KB'
            : (msg.fileSize / 1048576).toFixed(2) + ' MB';

        imageLoaded = true;
        resetView();
        vscode.postMessage({ type: 'info', value: msg.width + ' x ' + msg.height + '  |  ' + sizeStr });
    }

    // ── Chunked rendering ──────────────────────────────────────────

    function drainChunkQueue() {
        // Render all queued chunks, then let the browser repaint
        while (chunkQueue.length > 0) {
            var msg = chunkQueue.shift();
            var u8 = new Uint8ClampedArray(msg.data);
            var chunkImageData = new ImageData(u8, canvas.width, msg.rows);
            ctx.putImageData(chunkImageData, 0, msg.offsetY);
        }
        chunkDraining = false;
    }

    function scheduleChunkDrain() {
        if (!chunkDraining) {
            chunkDraining = true;
            requestAnimationFrame(drainChunkQueue);
        }
    }

    // ── Message handling ───────────────────────────────────────────

    window.addEventListener('message', function (e) {
        var msg = e.data;

        switch (msg.type) {
            // Single-transfer image (Transferable ArrayBuffer, small images)
            case 'image': {
                var t0 = performance.now();
                canvas.width = msg.width;
                canvas.height = msg.height;
                var u8 = new Uint8ClampedArray(msg.data);
                var imageData = ctx.createImageData(msg.width, msg.height);
                imageData.data.set(u8);
                ctx.putImageData(imageData, 0, 0);

                var renderMs = (performance.now() - t0).toFixed(1);
                msg.timing = msg.timing || {};
                msg.timing.render = renderMs;
                finalizeImage(msg);
                console.log('[QOI Viewer webview] renderImage ' + msg.width + 'x' + msg.height + ': ' + renderMs + 'ms');
                break;
            }

            // Chunked transfer: start
            case 'imageInit': {
                pendingImage = {
                    width: msg.width,
                    height: msg.height,
                    channels: msg.channels,
                    colorspace: msg.colorspace,
                    fileSize: msg.fileSize,
                    uri: msg.uri,
                    name: msg.name,
                    timing: msg.timing,
                    _startTime: performance.now(),
                };
                chunkQueue = [];
                chunkDraining = false;
                canvas.width = msg.width;
                canvas.height = msg.height;
                canvas.style.display = 'block';
                errorDiv.style.display = 'none';
                zoomLevel = 1;
                panX = 0;
                panY = 0;
                computeBaseScale();
                applyTransform();
                break;
            }

            // Chunked transfer: chunk — queue and render on next frame
            case 'imageChunk': {
                chunkQueue.push(msg);
                scheduleChunkDrain();
                break;
            }

            // Chunked transfer: done
            case 'imageDone': {
                if (pendingImage) {
                    var totalMs = (performance.now() - pendingImage._startTime).toFixed(1);
                    pendingImage.timing = pendingImage.timing || {};
                    pendingImage.timing.render = totalMs;
                    finalizeImage(pendingImage);
                    console.log('[QOI Viewer webview] renderImage chunked ' + pendingImage.width + 'x' + pendingImage.height + ': ' + totalMs + 'ms');
                    pendingImage = null;
                }
                break;
            }

            case 'error': {
                canvas.style.display = 'none';
                errorDiv.style.display = 'block';
                errorDiv.textContent = 'Error: ' + msg.message;
                break;
            }

            case 'setScale': {
                if (!imageLoaded) break;
                if (msg.scale === 'fit') {
                    resetView();
                } else {
                    zoomLevel = msg.scale;
                    applyTransform();
                }
                break;
            }

            case 'requestExport': {
                if (!imageLoaded) return;
                var dataUrl = canvas.toDataURL('image/png');
                vscode.postMessage({ type: 'exportPng', dataUrl: dataUrl });
                break;
            }
        }
    });

    window.addEventListener('resize', function () {
        if (!imageLoaded) return;
        computeBaseScale();
        applyTransform();
    });

    // Signal the extension host that the webview is ready to receive messages
    vscode.postMessage({ type: 'ready' });
})();