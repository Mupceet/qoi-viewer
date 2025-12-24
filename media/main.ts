/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* global acquireVsCodeApi */

declare function acquireVsCodeApi(): any;

(function () {
    function clamp(value: number, min: number, max: number): number {
        return Math.min(Math.max(value, min), max);
    }

    function getSettings(): { src: string } {
        const element = document.getElementById('image-preview-settings');
        if (element) {
            const data = element.getAttribute('data-settings');
            if (data) {
                return JSON.parse(data);
            }
        }

        throw new Error(`Could not load settings`);
    }

    const PIXELATION_THRESHOLD = 3;
    const SCALE_PINCH_FACTOR = 0.075;
    const MAX_SCALE = 20;
    const MIN_SCALE = 0.1;

    const zoomLevels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 5, 7, 10, 15, 20];

    const settings = getSettings();
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    // acquireVsCodeApi is provided by VS Code webview runtime
    const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : ({ getState: () => undefined, setState: (_: any) => { }, postMessage: (_: any) => { } } as any);

    const initialState = vscode.getState() || { scale: 'fit', offsetX: 0, offsetY: 0 };

    let scale: 'fit' | number = (initialState.scale as any) || 'fit';
    let ctrlPressed = false;
    let altPressed = false;
    let hasLoadedImage = false;
    let consumeClick = true;
    let isActive = false;

    // Panning state when zoomed
    let isDragging = false;
    let panStart: { x: number; y: number; scrollX: number; scrollY: number } | undefined;

    // Pinch-to-zoom state
    let pinchActive = false;
    let pinchStartDist = 0;
    let pinchStartScale: number = 1;

    const container = document.body as HTMLBodyElement;
    let image: HTMLImageElement | (HTMLCanvasElement & { naturalWidth?: number; naturalHeight?: number }) = document.createElement('img') as HTMLImageElement;
    let canvas: (HTMLCanvasElement & { naturalWidth?: number; naturalHeight?: number }) | undefined;

    function updateScale(newScale: 'fit' | number) {
        if (!image || !hasLoadedImage || !image.parentElement) {
            return;
        }

        if (newScale === 'fit') {
            scale = 'fit';
            image.classList.add('scale-to-fit');
            image.classList.remove('pixelated');
            // @ts-ignore Non-standard CSS property
            (image as any).style.zoom = 'normal';
            vscode.setState(undefined);
        } else {
            scale = clamp(newScale as number, MIN_SCALE, MAX_SCALE);
            if (scale >= PIXELATION_THRESHOLD) {
                image.classList.add('pixelated');
            } else {
                image.classList.remove('pixelated');
            }

            const dx = (window.scrollX + container.clientWidth / 2) / container.scrollWidth;
            const dy = (window.scrollY + container.clientHeight / 2) / container.scrollHeight;

            image.classList.remove('scale-to-fit');
            // @ts-ignore Non-standard CSS property
            (image as any).style.zoom = scale as any;

            const newScrollX = container.scrollWidth * dx - container.clientWidth / 2;
            const newScrollY = container.scrollHeight * dy - container.clientHeight / 2;

            window.scrollTo(newScrollX, newScrollY);

            vscode.setState({ scale: scale, offsetX: newScrollX, offsetY: newScrollY });
        }

        vscode.postMessage({ type: 'zoom', value: scale });
    }

    function setActive(value: boolean) {
        isActive = value;
        if (value) {
            if (isMac ? altPressed : ctrlPressed) {
                container.classList.remove('zoom-in');
                container.classList.add('zoom-out');
            } else {
                container.classList.remove('zoom-out');
                container.classList.add('zoom-in');
            }
        } else {
            ctrlPressed = false;
            altPressed = false;
            container.classList.remove('zoom-out');
            container.classList.remove('zoom-in');
        }
    }

    function firstZoom() {
        if (!image || !hasLoadedImage) { return; }
        scale = (image as any).clientWidth / ((image as any).naturalWidth || 1);
        updateScale(scale);
    }

    function zoomIn() {
        if (scale === 'fit') { firstZoom(); }
        let i = 0; for (; i < zoomLevels.length; ++i) { if (zoomLevels[i] > (scale as number)) break; }
        updateScale(zoomLevels[i] || MAX_SCALE);
    }

    function zoomOut() {
        if (scale === 'fit') { firstZoom(); }
        let i = zoomLevels.length - 1; for (; i >= 0; --i) { if (zoomLevels[i] < (scale as number)) break; }
        updateScale(zoomLevels[i] || MIN_SCALE);
    }

    window.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!image || !hasLoadedImage) return;
        ctrlPressed = e.ctrlKey; altPressed = e.altKey;
        if (isMac ? altPressed : ctrlPressed) { container.classList.remove('zoom-in'); container.classList.add('zoom-out'); }
    });

    window.addEventListener('keyup', (e: KeyboardEvent) => {
        if (!image || !hasLoadedImage) return;
        ctrlPressed = e.ctrlKey; altPressed = e.altKey;
        if (!(isMac ? altPressed : ctrlPressed)) { container.classList.remove('zoom-out'); container.classList.add('zoom-in'); }
    });

    container.addEventListener('mousedown', (e: MouseEvent) => {
        if (!image || !hasLoadedImage) return;
        if (e.button !== 0) return;
        ctrlPressed = e.ctrlKey; altPressed = e.altKey; consumeClick = !isActive;
        // start potential panning if zoomed
        if (scale !== 'fit') {
            isDragging = false;
            panStart = { x: e.clientX, y: e.clientY, scrollX: window.scrollX, scrollY: window.scrollY };
        }
    });

    container.addEventListener('click', (e: MouseEvent) => {
        if (!image || !hasLoadedImage) return; if (e.button !== 0) return;
        if (isDragging) { isDragging = false; return; }
        if (consumeClick) { consumeClick = false; return; }
        if (scale === 'fit') firstZoom();
        if (!(isMac ? altPressed : ctrlPressed)) zoomIn(); else zoomOut();
    });

    container.addEventListener('wheel', (e: WheelEvent) => {
        if (e.ctrlKey) e.preventDefault();
        if (!image || !hasLoadedImage) return;
        const isScrollWheelKeyPressed = isMac ? altPressed : ctrlPressed;
        if (!isScrollWheelKeyPressed && !e.ctrlKey) return;
        if (scale === 'fit') firstZoom();
        let delta = e.deltaY > 0 ? 1 : -1;
        updateScale((scale === 'fit' ? 1 : (scale as number)) * (1 - delta * SCALE_PINCH_FACTOR));
    }, { passive: false });

    // Mouse move/up handlers for panning
    window.addEventListener('mousemove', (e: MouseEvent) => {
        if (!panStart) return;
        const dx = panStart.x - e.clientX;
        const dy = panStart.y - e.clientY;
        if (!isDragging) {
            // threshold to start dragging
            if (Math.hypot(dx, dy) < 4) return;
            isDragging = true;
        }
        window.scrollTo(panStart.scrollX + dx, panStart.scrollY + dy);
    }, { passive: true });

    window.addEventListener('mouseup', (_e: MouseEvent) => {
        panStart = undefined;
        // keep isDragging flag until click handler clears it
    });

    // Touch handlers for panning (mobile / touch devices)
    window.addEventListener('touchstart', (e: TouchEvent) => {
        if (!image || !hasLoadedImage) return;
        if (e.touches && e.touches.length === 2) {
            // start pinch
            const t0 = e.touches[0];
            const t1 = e.touches[1];
            pinchStartDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
            pinchActive = true;
            pinchStartScale = (scale === 'fit') ? ((image as any).clientWidth / ((image as any).naturalWidth || 1)) : (scale as number);
            panStart = undefined;
            isDragging = false;
            return;
        }
        // single touch -> start potential panning
        if (scale === 'fit') return;
        const t = e.touches && e.touches[0];
        if (!t) return;
        panStart = { x: t.clientX, y: t.clientY, scrollX: window.scrollX, scrollY: window.scrollY };
        isDragging = false;
    }, { passive: true });

    window.addEventListener('touchmove', (e: TouchEvent) => {
        if (pinchActive && e.touches && e.touches.length >= 2) {
            // handle pinch-to-zoom
            const t0 = e.touches[0];
            const t1 = e.touches[1];
            const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
            if (pinchStartDist > 0) {
                const ratio = dist / pinchStartDist;
                let target = pinchStartScale * ratio;
                updateScale(target);
            }
            // prevent default to stop host scrolling/zooming
            e.preventDefault();
            return;
        }
        if (!panStart) return;
        const t = e.touches && e.touches[0];
        if (!t) return;
        const dx = panStart.x - t.clientX;
        const dy = panStart.y - t.clientY;
        if (!isDragging) {
            if (Math.hypot(dx, dy) < 4) return;
            isDragging = true;
        }
        // prevent page from handling the touch (scrolling the webview)
        e.preventDefault();
        window.scrollTo(panStart.scrollX + dx, panStart.scrollY + dy);
    }, { passive: false });

    window.addEventListener('touchend', (e: TouchEvent) => {
        if (pinchActive) {
            // if still two touches remain, keep; otherwise end pinch
            if (!e.touches || e.touches.length < 2) {
                pinchActive = false;
                pinchStartDist = 0;
            }
        }
        if (!e.touches || e.touches.length === 0) {
            panStart = undefined;
        }
        // keep isDragging until click handling ignores the tap
    });

    window.addEventListener('scroll', (e: Event) => {
        if (!image || !hasLoadedImage || !image.parentElement || scale === 'fit') return;
        const entry = vscode.getState();
        if (entry) vscode.setState({ scale: entry.scale, offsetX: window.scrollX, offsetY: window.scrollY });
    }, { passive: true });

    container.classList.add('image');
    image.classList.add('scale-to-fit');

    image.addEventListener('load', () => {
        if (hasLoadedImage) return;
        hasLoadedImage = true;
        vscode.postMessage({ type: 'size', value: `${(image as any).naturalWidth}x${(image as any).naturalHeight}` });
        document.body.classList.remove('loading'); document.body.classList.add('ready'); document.body.append(image);
        updateScale(scale);
        if ((initialState as any).scale !== 'fit') window.scrollTo((initialState as any).offsetX, (initialState as any).offsetY);
    });

    image.addEventListener('error', () => { if (hasLoadedImage) return; hasLoadedImage = true; document.body.classList.add('error'); document.body.classList.remove('loading'); });

    image.src = settings.src;

    const openFileLink = document.querySelector('.open-file-link');
    if (openFileLink) {
        openFileLink.addEventListener('click', () => { vscode.postMessage({ type: 'reopen-as-text' }); });
    }

    window.addEventListener('message', (e: MessageEvent) => {
        if (e.origin !== window.origin) { console.error('Dropping message from unknown origin in image preview'); return; }
        switch (e.data.type) {
            case 'qoiPixelsInit': {
                const m = e.data as any;
                const width = m.width as number;
                const height = m.height as number;
                const channels = m.channels as number;
                if (!canvas) {
                    canvas = document.createElement('canvas') as any;
                    if (canvas) {
                        canvas.width = width; canvas.height = height; canvas.naturalWidth = width; canvas.naturalHeight = height; image = canvas; document.body.append(canvas);
                    }
                }
                break;
            }
            case 'qoiPixelsChunk': {
                const m = e.data as any; const offsetY = m.offsetY as number; const rows = m.rows as number; const channels = (m.channels as number) || 4;
                let u8 = new Uint8ClampedArray(m.data as ArrayBuffer);
                if (channels === 3) {
                    const src = u8; const dst = new Uint8ClampedArray((src.length / 3) * 4);
                    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) { dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255; }
                    u8 = dst;
                }
                const width = (canvas as HTMLCanvasElement).width; const ctx = (canvas as HTMLCanvasElement).getContext('2d')!; const img = new ImageData(u8, width, rows); ctx.putImageData(img, 0, offsetY); vscode.postMessage({ type: 'size', value: `${(canvas as any).naturalWidth}x${(canvas as any).naturalHeight}` });
                break;
            }
            case 'qoiPixelsDone': { document.body.classList.remove('loading'); document.body.classList.add('ready'); hasLoadedImage = true; break; }
            case 'setScale': updateScale(e.data.scale as any); break;
            case 'setActive': setActive(e.data.value as boolean); break;
            case 'zoomIn': zoomIn(); break;
            case 'zoomOut': zoomOut(); break;
            case 'qoiPixels': {
                const m = e.data as any; const width = m.width as number; const height = m.height as number; const channels = m.channels as number; let u8 = new Uint8ClampedArray(m.data as ArrayBuffer);
                if (channels === 3) { const src = u8; const dst = new Uint8ClampedArray((src.length / 3) * 4); for (let i = 0, j = 0; i < src.length; i += 3, j += 4) { dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255; } u8 = dst; }
                if (canvas) { canvas.width = width; canvas.height = height; } else { canvas = document.createElement('canvas') as any; if (canvas) { canvas.width = width; canvas.height = height; canvas.naturalWidth = width; canvas.naturalHeight = height; image = canvas; } }
                if (canvas) { const ctx = (canvas as HTMLCanvasElement).getContext('2d')!; const img = new ImageData(u8, width, height); ctx.putImageData(img, 0, 0); vscode.postMessage({ type: 'size', value: `${width}x${height}` }); document.body.classList.remove('loading'); document.body.classList.add('ready'); if (!canvas.parentElement) document.body.append(canvas); hasLoadedImage = true; } break;
            }
            case 'qoiError': { document.body.classList.add('error'); document.body.classList.remove('loading'); break; }
        }
    });
})();
