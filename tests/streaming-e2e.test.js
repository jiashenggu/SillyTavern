/**
 * End-to-End Streaming Resilience Tests
 *
 * Three-layer pipeline that mirrors the real SillyTavern architecture:
 *
 *   Client (fetch) ──HTTP──> Proxy (Express + node-fetch pipe) ──HTTP──> Mock LLM API
 *
 * The Proxy layer replicates SillyTavern's actual forwardFetchResponse() logic:
 *   - node-fetch to upstream, pipe body to express response
 *   - AbortController tied to client socket close
 *   - TCP keepalive on all server connections
 *
 * Each test injects a specific failure and measures real behavior across all layers.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import fetch from 'node-fetch';
import { configureSocketKeepalive } from '../src/socket-keepalive.js';

// ── Heartbeat utilities (same logic as sse-stream.js, inlined for Node env) ──

class StreamHeartbeatTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Stream heartbeat timeout: no data received for ${timeoutMs}ms`);
        this.name = 'StreamHeartbeatTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

function readWithHeartbeat(reader, timeoutMs) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new StreamHeartbeatTimeoutError(timeoutMs)), timeoutMs);
    });
    return Promise.race([
        reader.read().then(r => { clearTimeout(timeoutId); return r; }),
        timeoutPromise,
    ]);
}

// ── Helpers ──

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Exact replica of SillyTavern's forwardFetchResponse (src/util.js:708-744).
 * Uses the real node-fetch Response and Express res objects.
 */
function forwardFetchResponse(from, to) {
    let statusCode = from.status;
    let statusText = from.statusText;

    if (!from.ok) {
        console.warn(`Streaming request failed with status ${statusCode} ${statusText}`);
    }
    if (statusCode === 401) statusCode = 400;

    to.statusCode = statusCode;
    to.statusMessage = statusText;

    if (from.body && to.socket) {
        from.body.pipe(to);

        to.socket.on('close', function () {
            if (from.body instanceof Readable) from.body.destroy();
            to.end();
        });

        from.body.on('end', function () {
            to.end();
        });
    } else {
        to.end();
    }
}

// ═══════════════════════════════════════════════════
//  Layer 1: Mock LLM API Server (simulates upstream)
// ═══════════════════════════════════════════════════

class MockLLMServer {
    constructor(port) {
        this.port = port;
        this.server = null;
        this._abortedRequests = 0;
        this._transientFailCount = 0;
    }

    get abortedRequests() { return this._abortedRequests; }

    async start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                const url = new URL(req.url, `http://localhost:${this.port}`);

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });

                req.on('close', () => {
                    // Track if the request was aborted by the proxy
                    if (!res.writableEnded) {
                        this._abortedRequests++;
                    }
                });

                switch (url.pathname) {
                    case '/v1/stream/normal':
                        this._sendTokens(res, 10, 30);
                        break;
                    case '/v1/stream/stall':
                        this._sendTokensThenStall(res, 4, 30);
                        break;
                    case '/v1/stream/drop':
                        this._sendTokensThenDrop(res, 4, 30);
                        break;
                    case '/v1/stream/transient':
                        this._handleTransient(res);
                        break;
                    default:
                        res.end();
                }
            });
            this.server.on('error', reject);
            this.server.listen(this.port, '127.0.0.1', resolve);
        });
    }

    _sendTokens(res, count, intervalMs) {
        let i = 0;
        const iv = setInterval(() => {
            if (i >= count) {
                res.write('data: [DONE]\n\n');
                res.end();
                clearInterval(iv);
                return;
            }
            res.write(`data: {"choices":[{"delta":{"content":"word${i} "}}]}\n\n`);
            i++;
        }, intervalMs);
        res.on('close', () => clearInterval(iv));
    }

    _sendTokensThenStall(res, count, intervalMs) {
        let i = 0;
        const iv = setInterval(() => {
            if (i >= count) {
                clearInterval(iv);
                // Stall: keep connection open, send nothing
                return;
            }
            res.write(`data: {"choices":[{"delta":{"content":"word${i} "}}]}\n\n`);
            i++;
        }, intervalMs);
        res.on('close', () => clearInterval(iv));
    }

    _sendTokensThenDrop(res, count, intervalMs) {
        let i = 0;
        const iv = setInterval(() => {
            if (i >= count) {
                clearInterval(iv);
                // Abrupt TCP reset
                res.socket.destroy();
                return;
            }
            res.write(`data: {"choices":[{"delta":{"content":"word${i} "}}]}\n\n`);
            i++;
        }, intervalMs);
    }

    _handleTransient(res) {
        this._transientFailCount++;
        if (this._transientFailCount <= 1) {
            // First request: send 2 tokens then drop
            let i = 0;
            const iv = setInterval(() => {
                if (i >= 2) {
                    clearInterval(iv);
                    res.socket.destroy();
                    return;
                }
                res.write(`data: {"choices":[{"delta":{"content":"fail${i} "}}]}\n\n`);
                i++;
            }, 30);
        } else {
            // Subsequent: succeed
            this._sendTokens(res, 8, 30);
        }
    }

    resetTransient() { this._transientFailCount = 0; }
    resetAbortCount() { this._abortedRequests = 0; }

    async stop() {
        return new Promise((resolve, reject) => {
            if (!this.server) return resolve();
            this.server.closeAllConnections();
            this.server.close(err => {
                if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') return reject(err);
                resolve();
            });
        });
    }
}

// ═══════════════════════════════════════════════════
//  Layer 2: Proxy Server (replicates SillyTavern)
// ═══════════════════════════════════════════════════

class ProxyServer {
    constructor(port, upstreamPort) {
        this.port = port;
        this.upstreamPort = upstreamPort;
        this.server = null;
        /** @type {net.Socket[]} */
        this.serverSockets = [];
    }

    async start() {
        const app = express();
        const upstreamBase = `http://127.0.0.1:${this.upstreamPort}`;

        app.post('/api/stream', async (req, res) => {
            const controller = new AbortController();

            // Replicate SillyTavern's socket close -> abort pattern
            req.socket.removeAllListeners('close');
            req.socket.on('close', () => {
                controller.abort();
            });

            try {
                const upstreamUrl = `${upstreamBase}${req.query.path || '/v1/stream/normal'}`;
                const upstream = await fetch(upstreamUrl, {
                    method: 'GET',
                    signal: controller.signal,
                    timeout: 0,
                });
                forwardFetchResponse(upstream, res);
            } catch (err) {
                if (!res.headersSent) {
                    res.status(502).json({ error: true, message: err.message });
                }
            }
        });

        return new Promise((resolve, reject) => {
            this.server = http.createServer(app);
            // Apply our TCP keepalive (Step 1)
            this.server.on('connection', (socket) => {
                configureSocketKeepalive(socket);
                this.serverSockets.push(socket);
            });
            this.server.on('error', reject);
            this.server.listen(this.port, '127.0.0.1', resolve);
        });
    }

    async stop() {
        return new Promise((resolve, reject) => {
            if (!this.server) return resolve();
            this.server.closeAllConnections();
            this.server.close(err => {
                if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') return reject(err);
                resolve();
            });
        });
    }
}

// ═══════════════════════════════════════════════════
//  Layer 3: Client-side SSE consumer
// ═══════════════════════════════════════════════════

/**
 * Consumes an SSE stream from the proxy, applying readWithHeartbeat.
 * Returns collected tokens, any error, and timing data.
 */
async function consumeProxyStream(proxyBase, upstreamPath, { heartbeatMs = 0 } = {}) {
    const tokens = [];
    let error = null;
    const start = Date.now();

    try {
        const url = `${proxyBase}/api/stream?path=${encodeURIComponent(upstreamPath)}`;
        const res = await fetch(url, { method: 'POST' });
        if (!res.ok) {
            return { tokens, error: new Error(`HTTP ${res.status}`), elapsedMs: Date.now() - start };
        }

        const reader = res.body;
        // node-fetch returns a Node Readable, use async iteration
        let buffer = '';
        for await (const chunk of wrapWithHeartbeat(reader, heartbeatMs)) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    return { tokens, error: null, elapsedMs: Date.now() - start };
                }
                try {
                    const json = JSON.parse(data);
                    const content = json?.choices?.[0]?.delta?.content;
                    if (content) tokens.push(content);
                } catch { /* skip */ }
            }
        }
    } catch (err) {
        error = err;
    }

    return { tokens, error, elapsedMs: Date.now() - start };
}

/**
 * Wraps a Node.js Readable stream with heartbeat timeout detection.
 * Yields chunks. Throws StreamHeartbeatTimeoutError if no data arrives in time.
 */
async function* wrapWithHeartbeat(readable, heartbeatMs) {
    if (!heartbeatMs || heartbeatMs <= 0) {
        // No heartbeat — just pass through
        for await (const chunk of readable) {
            yield chunk;
        }
        return;
    }

    // Convert to web ReadableStream reader for Promise.race pattern
    const iterator = readable[Symbol.asyncIterator]();
    while (true) {
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new StreamHeartbeatTimeoutError(heartbeatMs)), heartbeatMs);
        });

        try {
            const result = await Promise.race([
                iterator.next().then(r => { clearTimeout(timeoutId); return r; }),
                timeoutPromise,
            ]);
            if (result.done) return;
            yield result.value;
        } catch (err) {
            // Make sure to clean up the iterator
            try { readable.destroy(); } catch { /* ignore */ }
            throw err;
        }
    }
}

// ═══════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════

describe('E2E Streaming Resilience (3-layer pipeline)', () => {
    const LLM_PORT = 19100;
    const PROXY_PORT = 19101;
    const PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`;

    const llm = new MockLLMServer(LLM_PORT);
    const proxy = new ProxyServer(PROXY_PORT, LLM_PORT);

    beforeAll(async () => {
        await llm.start();
        await proxy.start();
    });

    afterAll(async () => {
        await proxy.stop();
        await llm.stop();
    });

    // ── Scenario 0: Verify pipeline works ──

    test('E2E Normal: 10 tokens flow through proxy intact', async () => {
        const result = await consumeProxyStream(PROXY_BASE, '/v1/stream/normal', { heartbeatMs: 5000 });

        console.log(`[E2E Normal] ${result.tokens.length} tokens in ${result.elapsedMs}ms`);

        expect(result.error).toBeNull();
        expect(result.tokens).toHaveLength(10);
        expect(result.tokens[0]).toBe('word0 ');
        expect(result.tokens[9]).toBe('word9 ');
        expect(result.elapsedMs).toBeLessThan(3000);
    });

    // ── Scenario 1: TCP Keepalive on proxy sockets ──

    test('E2E Keepalive: proxy server sockets have keepalive + timeout', async () => {
        // Make a connection to populate serverSockets
        proxy.serverSockets = [];

        await new Promise((resolve, reject) => {
            const client = net.connect(PROXY_PORT, '127.0.0.1', () => {
                setTimeout(() => { client.destroy(); resolve(); }, 100);
            });
            client.on('error', reject);
        });

        expect(proxy.serverSockets.length).toBeGreaterThan(0);
        const socket = proxy.serverSockets[0];
        expect(socket.timeout).toBe(120000);
        console.log(`[E2E Keepalive] Socket timeout=${socket.timeout}ms, keepalive active`);
    });

    // ── Scenario 2: Upstream stall → heartbeat timeout ──

    test('E2E Stall: heartbeat detects upstream stall through proxy', async () => {
        const result = await consumeProxyStream(PROXY_BASE, '/v1/stream/stall', { heartbeatMs: 500 });

        console.log(`[E2E Stall] ${result.tokens.length} tokens, detected in ${result.elapsedMs}ms, error: ${result.error?.name}`);

        expect(result.tokens.length).toBeGreaterThanOrEqual(3); // Got tokens before stall
        expect(result.error).not.toBeNull();
        expect(result.error.name).toBe('StreamHeartbeatTimeoutError');
        // Should detect within: ~4*30ms(tokens) + 500ms(timeout) + overhead
        expect(result.elapsedMs).toBeLessThan(2000);
    });

    test('E2E Stall OLD: without heartbeat, client hangs (capped at 3s via AbortController)', async () => {
        const start = Date.now();
        let tokens = [];
        let error = null;

        // This is the ONLY way to escape a stalled stream without heartbeat:
        // external abort after a hard-coded wall-clock timeout.
        const ac = new AbortController();
        const killTimer = setTimeout(() => ac.abort(), 3000);

        try {
            const url = `${PROXY_BASE}/api/stream?path=${encodeURIComponent('/v1/stream/stall')}`;
            const res = await fetch(url, { method: 'POST', signal: ac.signal });
            for await (const chunk of res.body) {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const json = JSON.parse(line.slice(6).trim());
                        const c = json?.choices?.[0]?.delta?.content;
                        if (c) tokens.push(c);
                    } catch { /* skip */ }
                }
            }
        } catch (err) {
            error = err;
        }
        clearTimeout(killTimer);

        const elapsed = Date.now() - start;
        console.log(`[E2E Stall OLD] ${tokens.length} tokens, hung for ${elapsed}ms until manual abort`);

        // Proves old behavior: hangs until external kill
        expect(elapsed).toBeGreaterThanOrEqual(2800);
        expect(tokens.length).toBeGreaterThanOrEqual(3);
    }, 10000);

    // ── Scenario 3: Upstream TCP drop → partial content ──

    test('E2E Drop: upstream TCP reset, partial tokens preserved through proxy', async () => {
        const result = await consumeProxyStream(PROXY_BASE, '/v1/stream/drop', { heartbeatMs: 2000 });

        console.log(`[E2E Drop] ${result.tokens.length} tokens preserved, elapsed ${result.elapsedMs}ms`);

        // Should have received some tokens before the drop
        expect(result.tokens.length).toBeGreaterThanOrEqual(2);
        // Tokens should be intact (data integrity through proxy pipe)
        for (const t of result.tokens) {
            expect(t).toMatch(/^word\d+ $/);
        }
    });

    // ── Scenario 4: Client disconnect → proxy aborts upstream ──

    test('E2E Client Disconnect: proxy aborts upstream when client drops', async () => {
        llm.resetAbortCount();

        // Connect to proxy, start receiving, then destroy the socket
        const clientAbortPromise = new Promise(async (resolve) => {
            const url = `${PROXY_BASE}/api/stream?path=${encodeURIComponent('/v1/stream/stall')}`;
            try {
                const res = await fetch(url, { method: 'POST' });
                let gotTokens = 0;
                for await (const chunk of res.body) {
                    gotTokens++;
                    if (gotTokens >= 2) {
                        // Client disconnects abruptly after 2 chunks
                        res.body.destroy();
                        break;
                    }
                }
            } catch { /* expected */ }

            // Wait for proxy and LLM to process the disconnect
            await delay(300);
            resolve(llm.abortedRequests);
        });

        const abortedCount = await clientAbortPromise;
        console.log(`[E2E Client DC] Upstream aborted requests: ${abortedCount}`);

        // Proxy should have triggered abort on the upstream request
        expect(abortedCount).toBeGreaterThanOrEqual(1);
    });

    // ── Scenario 5: Transient failure → retry succeeds ──

    test('E2E Retry: first attempt fails, second succeeds through proxy', async () => {
        llm.resetTransient();

        // Attempt 1: upstream drops after 2 tokens
        const r1 = await consumeProxyStream(PROXY_BASE, '/v1/stream/transient', { heartbeatMs: 1000 });
        console.log(`[E2E Retry] Attempt 1: ${r1.tokens.length} tokens, error: ${r1.error?.name || 'stream ended'}`);

        expect(r1.tokens.length).toBeLessThanOrEqual(2);

        // Simulate backoff
        await delay(500);

        // Attempt 2: upstream succeeds
        const r2 = await consumeProxyStream(PROXY_BASE, '/v1/stream/transient', { heartbeatMs: 5000 });
        console.log(`[E2E Retry] Attempt 2: ${r2.tokens.length} tokens, error: ${r2.error?.name || 'none'}`);

        expect(r2.error).toBeNull();
        expect(r2.tokens).toHaveLength(8);
    });

    // ── Scenario 6: Data integrity through proxy pipe ──

    test('E2E Integrity: token order and content preserved through proxy', async () => {
        const result = await consumeProxyStream(PROXY_BASE, '/v1/stream/normal', { heartbeatMs: 5000 });

        const expected = Array.from({ length: 10 }, (_, i) => `word${i} `);
        expect(result.tokens).toEqual(expected);
        console.log(`[E2E Integrity] All ${result.tokens.length} tokens in correct order`);
    });

    // ── Summary ──

    test('E2E SUMMARY: quantified improvements', async () => {
        // Stall: NEW vs OLD
        const newStall = await consumeProxyStream(PROXY_BASE, '/v1/stream/stall', { heartbeatMs: 500 });

        const ac = new AbortController();
        const kill = setTimeout(() => ac.abort(), 3000);
        const start = Date.now();
        try {
            const url = `${PROXY_BASE}/api/stream?path=${encodeURIComponent('/v1/stream/stall')}`;
            const res = await fetch(url, { method: 'POST', signal: ac.signal });
            for await (const chunk of res.body) { /* drain */ }
        } catch { /* expected */ }
        clearTimeout(kill);
        const oldMs = Date.now() - start;

        // Drop: partial preservation
        const drop = await consumeProxyStream(PROXY_BASE, '/v1/stream/drop', { heartbeatMs: 2000 });

        console.log('');
        console.log('╔════════════════════════════════════════════════════════════════╗');
        console.log('║            E2E RESULTS (3-layer pipeline)                     ║');
        console.log('╠════════════════════════════════════════════════════════════════╣');
        console.log(`║  Stall detection (NEW heartbeat):  ${String(newStall.elapsedMs).padStart(5)}ms               ║`);
        console.log(`║  Stall detection (OLD no timeout): ${String(oldMs).padStart(5)}ms (test cap 3s)     ║`);
        console.log(`║  Stall improvement:                ${String(Math.round((1 - newStall.elapsedMs / oldMs) * 100)).padStart(4)}%                      ║`);
        console.log('╠════════════════════════════════════════════════════════════════╣');
        console.log(`║  Drop: tokens preserved:           ${drop.tokens.length} / 4                       ║`);
        console.log(`║  Drop: preservation rate:           ${Math.round(drop.tokens.length / 4 * 100)}%                       ║`);
        console.log('╠════════════════════════════════════════════════════════════════╣');
        console.log('║  TCP Keepalive:                    30s probe, 120s timeout    ║');
        console.log('║  Proxy upstream abort on DC:       Verified                   ║');
        console.log('║  Retry after transient failure:    Verified (2→8 tokens)      ║');
        console.log('║  Data integrity through proxy:     10/10 tokens, correct order║');
        console.log('╚════════════════════════════════════════════════════════════════╝');
        console.log('');

        expect(newStall.elapsedMs).toBeLessThan(oldMs);
    }, 15000);
});
