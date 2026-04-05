import { morphdom } from '../../lib.js';

/**
 * Check if the current browser supports native segmentation function.
 * @returns {boolean} True if the Segmenter is supported by the current browser.
 */
export function isSegmenterSupported() {
    return typeof Intl.Segmenter === 'function';
}

/**
 * Segment text in the given HTML content using Intl.Segmenter.
 * @param {HTMLElement} htmlElement Target HTML element
 * @param {string} htmlContent HTML content to segment
 * @param {'word'|'grapheme'|'sentence'} [granularity='word'] Text split granularity
 */
export function segmentTextInElement(htmlElement, htmlContent, granularity = 'word') {
    htmlElement.innerHTML = htmlContent;

    if (!isSegmenterSupported()) {
        return;
    }

    // TODO: Support more locales, make granularity configurable.
    const segmenter = new Intl.Segmenter('en-US', { granularity });
    const textNodes = [];
    const walker = document.createTreeWalker(htmlElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = /** @type {Text} */ (walker.currentNode);

        // Skip ancestors of code/pre
        if (textNode.parentElement && textNode.parentElement.closest('pre, code')) {
            continue;
        }

        // Skip text nodes that are empty or only whitespace
        if (/^\s*$/.test(textNode.data)) {
            continue;
        }

        textNodes.push(textNode);
    }

    // Split every text node into segments using spans
    for (const textNode of textNodes) {
        const fragment = document.createDocumentFragment();
        const segments = segmenter.segment(textNode.data);
        for (const segment of segments) {
            // TODO: Apply a different class for different segment length/content?
            // For now, just use a single class for all segments.
            const span = document.createElement('span');
            span.innerText = segment.segment;
            span.className = 'text_segment';
            fragment.appendChild(span);
        }
        textNode.replaceWith(fragment);
    }
}

/**
 * morphdom options that preserve user-toggled details open state during streaming.
 * @type {object}
 */
const morphdomDetailsOptions = {
    onBeforeElUpdated: function(fromEl, toEl) {
        if (fromEl instanceof HTMLDetailsElement && fromEl.open && !toEl.hasAttribute('open')) {
            toEl.setAttribute('open', '');
        }
        return true;
    },
};

export function applyStreamFadeIn(messageTextElement, htmlContent) {
    const targetElement = /** @type {HTMLElement} */ (messageTextElement.cloneNode());
    segmentTextInElement(targetElement, htmlContent);
    morphdom(messageTextElement, targetElement, morphdomDetailsOptions);
}

/**
 * Apply HTML content via morphdom without text segmentation.
 * Preserves existing DOM elements and their state (e.g. details open).
 * @param {HTMLElement} element Target element
 * @param {string} htmlContent New HTML content
 */
export function applyMorphdom(element, htmlContent) {
    const targetElement = /** @type {HTMLElement} */ (element.cloneNode());
    targetElement.innerHTML = htmlContent;
    morphdom(element, targetElement, morphdomDetailsOptions);
}
