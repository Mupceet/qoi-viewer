/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

(function () {
	/**
	 * @param {number} value
	 * @param {number} min
	 * @param {number} max
	 * @return {number}
	 */
	function clamp(value, min, max) {
		return Math.min(Math.max(value, min), max);
	}

	function getSettings() {
		const element = document.getElementById('image-preview-settings');
		if (element) {
			const data = element.getAttribute('data-settings');
			if (data) {
				return JSON.parse(data);
			}
		}

		throw new Error(`Could not load settings`);
	}

	/**
	 * Enable image-rendering: pixelated for images scaled by more than this.
	 */
	const PIXELATION_THRESHOLD = 3;

	const SCALE_PINCH_FACTOR = 0.075;
	const MAX_SCALE = 20;
	const MIN_SCALE = 0.1;

	const zoomLevels = [
		0.1,
		0.2,
		0.3,
		0.4,
		0.5,
		0.6,
		0.7,
		0.8,
		0.9,
		1,
		1.5,
		2,
		3,
		5,
		7,
		10,
		15,
		20
	];

	const settings = getSettings();
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

	const vscode = acquireVsCodeApi();

	const initialState = vscode.getState() || { scale: 'fit', offsetX: 0, offsetY: 0 };

	// State
	let scale = initialState.scale;
	let ctrlPressed = false;
	let altPressed = false;
	let hasLoadedImage = false;
	let consumeClick = true;
	let isActive = false;

	// Elements
	const container = document.body;
	let image = document.createElement('img');
	let canvas = undefined;

	function updateScale(newScale) {
		if (!image || !hasLoadedImage || !image.parentElement) {
			return;
		}

		if (newScale === 'fit') {
			scale = 'fit';
			image.classList.add('scale-to-fit');
			image.classList.remove('pixelated');
			// @ts-ignore Non-standard CSS property
			image.style.zoom = 'normal';
			vscode.setState(undefined);
		} else {
			scale = clamp(newScale, MIN_SCALE, MAX_SCALE);
			if (scale >= PIXELATION_THRESHOLD) {
				image.classList.add('pixelated');
			} else {
				image.classList.remove('pixelated');
			}

			const dx = (window.scrollX + container.clientWidth / 2) / container.scrollWidth;
			const dy = (window.scrollY + container.clientHeight / 2) / container.scrollHeight;

			image.classList.remove('scale-to-fit');
			// @ts-ignore Non-standard CSS property
			image.style.zoom = scale;

			const newScrollX = container.scrollWidth * dx - container.clientWidth / 2;
			const newScrollY = container.scrollHeight * dy - container.clientHeight / 2;

			window.scrollTo(newScrollX, newScrollY);

			vscode.setState({ scale: scale, offsetX: newScrollX, offsetY: newScrollY });
		}

		vscode.postMessage({
			type: 'zoom',
			value: scale
		});
	}

	function setActive(value) {
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
		if (!image || !hasLoadedImage) {
			return;
		}

		scale = image.clientWidth / image.naturalWidth;
		updateScale(scale);
	}

	function zoomIn() {
		if (scale === 'fit') {
			firstZoom();
		}

		let i = 0;
		for (; i < zoomLevels.length; ++i) {
			if (zoomLevels[i] > scale) {
				break;
			}
		}
		updateScale(zoomLevels[i] || MAX_SCALE);
	}

	function zoomOut() {
		if (scale === 'fit') {
			firstZoom();
		}

		let i = zoomLevels.length - 1;
		for (; i >= 0; --i) {
			if (zoomLevels[i] < scale) {
				break;
			}
		}
		updateScale(zoomLevels[i] || MIN_SCALE);
	}

	window.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
		if (!image || !hasLoadedImage) {
			return;
		}
		ctrlPressed = e.ctrlKey;
		altPressed = e.altKey;

		if (isMac ? altPressed : ctrlPressed) {
			container.classList.remove('zoom-in');
			container.classList.add('zoom-out');
		}
	});

	window.addEventListener('keyup', (/** @type {KeyboardEvent} */ e) => {
		if (!image || !hasLoadedImage) {
			return;
		}

		ctrlPressed = e.ctrlKey;
		altPressed = e.altKey;

		if (!(isMac ? altPressed : ctrlPressed)) {
			container.classList.remove('zoom-out');
			container.classList.add('zoom-in');
		}
	});

	container.addEventListener('mousedown', (/** @type {MouseEvent} */ e) => {
		if (!image || !hasLoadedImage) {
			return;
		}

		if (e.button !== 0) {
			return;
		}

		ctrlPressed = e.ctrlKey;
		altPressed = e.altKey;

		consumeClick = !isActive;
	});

	container.addEventListener('click', (/** @type {MouseEvent} */ e) => {
		if (!image || !hasLoadedImage) {
			return;
		}

		if (e.button !== 0) {
			return;
		}

		if (consumeClick) {
			consumeClick = false;
			return;
		}
		// left click
		if (scale === 'fit') {
			firstZoom();
		}

		if (!(isMac ? altPressed : ctrlPressed)) { // zoom in
			zoomIn();
		} else {
			zoomOut();
		}
	});

	container.addEventListener('wheel', (/** @type {WheelEvent} */ e) => {
		// Prevent pinch to zoom
		if (e.ctrlKey) {
			e.preventDefault();
		}

		if (!image || !hasLoadedImage) {
			return;
		}

		const isScrollWheelKeyPressed = isMac ? altPressed : ctrlPressed;
		if (!isScrollWheelKeyPressed && !e.ctrlKey) { // pinching is reported as scroll wheel + ctrl
			return;
		}

		if (scale === 'fit') {
			firstZoom();
		}

		let delta = e.deltaY > 0 ? 1 : -1;
		updateScale(scale * (1 - delta * SCALE_PINCH_FACTOR));
	}, { passive: false });

	window.addEventListener('scroll', e => {
		if (!image || !hasLoadedImage || !image.parentElement || scale === 'fit') {
			return;
		}

		const entry = vscode.getState();
		if (entry) {
			vscode.setState({ scale: entry.scale, offsetX: window.scrollX, offsetY: window.scrollY });
		}
	}, { passive: true });

	container.classList.add('image');

	image.classList.add('scale-to-fit');

	image.addEventListener('load', () => {
		if (hasLoadedImage) {
			return;
		}
		hasLoadedImage = true;

		vscode.postMessage({
			type: 'size',
			value: `${image.naturalWidth}x${image.naturalHeight}`,
		});

		document.body.classList.remove('loading');
		document.body.classList.add('ready');
		document.body.append(image);

		updateScale(scale);

		if (initialState.scale !== 'fit') {
			window.scrollTo(initialState.offsetX, initialState.offsetY);
		}
	});

	image.addEventListener('error', e => {
		if (hasLoadedImage) {
			return;
		}

		hasLoadedImage = true;
		document.body.classList.add('error');
		document.body.classList.remove('loading');
	});

	image.src = settings.src;

	document.querySelector('.open-file-link').addEventListener('click', () => {
		vscode.postMessage({
			type: 'reopen-as-text',
		});
	});

	window.addEventListener('message', e => {
		if (e.origin !== window.origin) {
			console.error('Dropping message from unknown origin in image preview');
			return;
		}

			switch (e.data.type) {

						case 'qoiPixelsInit': {
							const m = e.data;
							const width = m.width;
							const height = m.height;
							const channels = m.channels;
							// create canvas placeholder
							if (!canvas) {
								canvas = document.createElement('canvas');
								canvas.width = width;
								canvas.height = height;
								canvas.naturalWidth = width;
								canvas.naturalHeight = height;
								image = canvas;
								document.body.append(canvas);
							}
							break;
						}

						case 'qoiPixelsChunk': {
							const m = e.data;
							const offsetY = m.offsetY;
							const rows = m.rows;
							const channels = m.channels || 4; // may be undefined on chunks
							let u8 = new Uint8ClampedArray(m.data);
							// expand RGB->RGBA if needed
							if (channels === 3) {
								const src = u8;
								const dst = new Uint8ClampedArray((src.length / 3) * 4);
								for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
									dst[j] = src[i];
									dst[j + 1] = src[i + 1];
									dst[j + 2] = src[i + 2];
									dst[j + 3] = 255;
								}
								u8 = dst;
							}
							const width = canvas.width;
							const ctx = canvas.getContext('2d');
							const img = new ImageData(u8, width, rows);
							ctx.putImageData(img, 0, offsetY);
							vscode.postMessage({ type: 'size', value: `${canvas.naturalWidth}x${canvas.naturalHeight}` });
							break;
						}

						case 'qoiPixelsDone': {
							// finalization: mark loaded
							document.body.classList.remove('loading');
							document.body.classList.add('ready');
							hasLoadedImage = true;
							break;
						}

			case 'setScale':
				updateScale(e.data.scale);
				break;

			case 'setActive':
				setActive(e.data.value);
				break;

			case 'zoomIn':
				zoomIn();
				break;

			case 'zoomOut':
				zoomOut();
				break;

			case 'qoiPixels': {
				// e.data.data is an ArrayBuffer (transferable)
				const m = e.data;
				const width = m.width;
				const height = m.height;
				const channels = m.channels;
				let u8 = new Uint8ClampedArray(m.data);
				// If channels === 3, expand to RGBA by adding opaque alpha
				if (channels === 3) {
					const src = u8;
					const dst = new Uint8ClampedArray((src.length / 3) * 4);
					for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
						dst[j] = src[i];
						dst[j + 1] = src[i + 1];
						dst[j + 2] = src[i + 2];
						dst[j + 3] = 255;
					}
					u8 = dst;
				}
				// Create canvas if not present
				if (canvas) {
					canvas.width = width;
					canvas.height = height;
				} else {
					canvas = document.createElement('canvas');
					canvas.width = width;
					canvas.height = height;
					// expose naturalWidth/Height so existing logic can use them
					canvas.naturalWidth = width;
					canvas.naturalHeight = height;
					// replace the `image` variable with the canvas element so other code paths continue to work
					image = canvas;
				}
				const ctx = canvas.getContext('2d');
				const img = new ImageData(u8, width, height);
				ctx.putImageData(img, 0, 0);
				// report size to extension
				vscode.postMessage({ type: 'size', value: `${width}x${height}` });
				document.body.classList.remove('loading');
				document.body.classList.add('ready');
				if (!canvas.parentElement) {
					document.body.append(canvas);
				}
				hasLoadedImage = true;
				break;
			}

			case 'qoiError': {
				document.body.classList.add('error');
				document.body.classList.remove('loading');
				break;
			}
		}
	});
}());
