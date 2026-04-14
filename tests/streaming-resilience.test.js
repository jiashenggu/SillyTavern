import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import net from 'node:net';
import { configureSocketKeepalive } from '../src/socket-keepalive.js';

/**
 * Creates a mock ReadableStreamDefaultReader for testing.
 * @param {Array<{delay: number, value: any, done?: boolean}>} chunks Chunks to emit
 * @returns {ReadableStreamDefaultReader}
 */
function createMockReader(chunks) {
    let index = 0;
    return {
        read() {
            if (index >= chunks.length) {
                return Promise.resolve({ done: true, value: undefined });
            }
            const chunk = chunks[index++];
            if (chunk.delay > 0) {
                return new Promise(resolve =>
                    setTimeout(() => resolve({ done: !!chunk.done, value: chunk.value }), chunk.delay),
                );
            }
            return Promise.resolve({ done: !!chunk.done, value: chunk.value });
        },
        cancel() {},
        releaseLock() {},
    };
}

/**
 * Creates a reader that never resolves (simulates a stalled connection).
 * @returns {ReadableStreamDefaultReader}
 */
function createStalledReader() {
    return {
        read() {
            return new Promise(() => {}); // never resolves
        },
        cancel() {},
        releaseLock() {},
    };
}

// ── Inline readWithHeartbeat + StreamHeartbeatTimeoutError for Node test env ──
// (The originals live in public/scripts/sse-stream.js which has browser-only imports)

const DEFAULT_HEARTBEAT_TIMEOUT = 90000;

class StreamHeartbeatTimeoutError extends Error {
    constructor(timeoutMs) {
        super(`Stream heartbeat timeout: no data received for ${timeoutMs}ms`);
        this.name = 'StreamHeartbeatTimeoutError';
        this.timeoutMs = timeoutMs;
    }
}

function readWithHeartbeat(reader, timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new StreamHeartbeatTimeoutError(timeoutMs));
        }, timeoutMs);
    });

    return Promise.race([
        reader.read().then((result) => {
            clearTimeout(timeoutId);
            return result;
        }),
        timeoutPromise,
    ]);
}

// ── Tests ──

describe('Streaming Resilience - TCP Keepalive', () => {
    /** @type {http.Server} */
    let server;
    /** @type {net.Socket[]} */
    let serverSockets = [];
    const TEST_PORT = 18932;

    beforeAll(async () => {
        await new Promise((resolve, reject) => {
            server = http.createServer((req, res) => {
                res.writeHead(200);
                res.end('ok');
            });
            server.on('connection', (socket) => {
                configureSocketKeepalive(socket);
                serverSockets.push(socket);
            });
            server.on('error', reject);
            server.listen(TEST_PORT, '127.0.0.1', resolve);
        });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => {
            if (!server) return resolve();
            server.closeAllConnections();
            server.close((err) => {
                if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') return reject(err);
                resolve();
            });
        });
    });

    test('configureSocketKeepalive should set timeout on a socket', () => {
        const socket = new net.Socket();
        configureSocketKeepalive(socket);
        expect(socket.timeout).toBe(120000);
        socket.destroy();
    });

    test('configureSocketKeepalive should accept custom options', () => {
        const socket = new net.Socket();
        configureSocketKeepalive(socket, {
            keepAliveInitialDelay: 10000,
            idleTimeout: 60000,
        });
        expect(socket.timeout).toBe(60000);
        socket.destroy();
    });

    test('server should apply keepalive to server-side sockets on connection', async () => {
        serverSockets = [];

        await new Promise((resolve, reject) => {
            const client = net.connect(TEST_PORT, '127.0.0.1', () => {
                setTimeout(() => {
                    client.destroy();
                    resolve();
                }, 50);
            });
            client.on('error', reject);
        });

        expect(serverSockets.length).toBeGreaterThan(0);
        expect(serverSockets[0].timeout).toBe(120000);
    });
});

describe('Streaming Resilience - Heartbeat Timeout', () => {
    test('readWithHeartbeat should return data when reader responds promptly', async () => {
        const reader = createMockReader([
            { delay: 0, value: { data: 'chunk1' } },
            { delay: 0, value: { data: 'chunk2' } },
        ]);

        const result1 = await readWithHeartbeat(reader, 1000);
        expect(result1.done).toBe(false);
        expect(result1.value).toEqual({ data: 'chunk1' });

        const result2 = await readWithHeartbeat(reader, 1000);
        expect(result2.done).toBe(false);
        expect(result2.value).toEqual({ data: 'chunk2' });
    });

    test('readWithHeartbeat should signal done when reader is exhausted', async () => {
        const reader = createMockReader([]);
        const result = await readWithHeartbeat(reader, 1000);
        expect(result.done).toBe(true);
    });

    test('readWithHeartbeat should throw StreamHeartbeatTimeoutError on stalled reader', async () => {
        const reader = createStalledReader();

        await expect(readWithHeartbeat(reader, 200))
            .rejects
            .toThrow(StreamHeartbeatTimeoutError);

        await expect(readWithHeartbeat(reader, 200))
            .rejects
            .toThrow(/no data received for 200ms/);
    });

    test('readWithHeartbeat should not timeout if data arrives before deadline', async () => {
        const reader = createMockReader([
            { delay: 100, value: { data: 'slow-but-ok' } },
        ]);

        const result = await readWithHeartbeat(reader, 500);
        expect(result.done).toBe(false);
        expect(result.value).toEqual({ data: 'slow-but-ok' });
    });

    test('StreamHeartbeatTimeoutError has correct properties', () => {
        const err = new StreamHeartbeatTimeoutError(5000);
        expect(err.name).toBe('StreamHeartbeatTimeoutError');
        expect(err.timeoutMs).toBe(5000);
        expect(err.message).toContain('5000ms');
        expect(err instanceof Error).toBe(true);
    });

    test('readWithHeartbeat uses default timeout of 90s', async () => {
        // We just verify the function works with default args (doesn't throw TypeError)
        const reader = createMockReader([{ delay: 0, value: { data: 'ok' } }]);
        const result = await readWithHeartbeat(reader);
        expect(result.value).toEqual({ data: 'ok' });
    });
});

describe('Streaming Resilience - Partial Content Preservation', () => {
    /**
     * Minimal mock of onErrorStreaming logic for testing hasPartialContent detection.
     */
    function simulateOnErrorStreaming(result) {
        const state = {
            result: result,
            isStopped: false,
            hasPartialContent: false,
        };
        // Reproduce the onErrorStreaming logic
        state.isStopped = true;
        state.hasPartialContent = !!(state.result && state.result !== '' && state.result !== '...');
        return state;
    }

    test('hasPartialContent should be true when result has meaningful text', () => {
        const state = simulateOnErrorStreaming('Hello, this is a partial');
        expect(state.isStopped).toBe(true);
        expect(state.hasPartialContent).toBe(true);
    });

    test('hasPartialContent should be false when result is empty', () => {
        const state = simulateOnErrorStreaming('');
        expect(state.hasPartialContent).toBe(false);
    });

    test('hasPartialContent should be false when result is placeholder "..."', () => {
        const state = simulateOnErrorStreaming('...');
        expect(state.hasPartialContent).toBe(false);
    });

    test('hasPartialContent should be false when result is null/undefined', () => {
        expect(simulateOnErrorStreaming(null).hasPartialContent).toBe(false);
        expect(simulateOnErrorStreaming(undefined).hasPartialContent).toBe(false);
    });

    test('hasPartialContent should be true even for very short text', () => {
        const state = simulateOnErrorStreaming('H');
        expect(state.hasPartialContent).toBe(true);
    });

    test('partial save decision: should save when isStopped and hasPartialContent', () => {
        const state = simulateOnErrorStreaming('Partial response from LLM...');
        const getMessage = state.result;
        const shouldSave = state.hasPartialContent && getMessage;
        expect(shouldSave).toBeTruthy();
    });

    test('partial save decision: should NOT save when stream finished normally', () => {
        // Normal completion: isStopped = false, isFinished = true
        const state = { isStopped: false, isFinished: true, hasPartialContent: false, result: 'Full response' };
        const isStreamFinished = !state.isStopped && state.isFinished;
        expect(isStreamFinished).toBe(true);
        // In this case the normal onFinishStreaming path handles saving
    });
});

describe('Streaming Resilience - Exponential Backoff Retry', () => {
    /**
     * Minimal mock of StreamingProcessor retry logic for testing.
     */
    function createMockProcessor(opts = {}) {
        return {
            isStopped: false,
            isFinished: false,
            result: opts.result || '',
            retryParams: 'retryParams' in opts ? opts.retryParams : { type: 'normal', data: {} },
            maxStreamRetries: opts.maxStreamRetries ?? 2,
            streamRetryCount: 0,
            isRetryableError(err) {
                if (this.isStopped || this.isFinished) return false;
                if (err.name === 'AbortError') return false;
                if (err.name === 'StreamHeartbeatTimeoutError') return true;
                if (err.name === 'TypeError' && /fetch|network/i.test(err.message)) return true;
                return false;
            },
        };
    }

    test('isRetryableError should return true for StreamHeartbeatTimeoutError', () => {
        const proc = createMockProcessor();
        const err = new StreamHeartbeatTimeoutError(90000);
        expect(proc.isRetryableError(err)).toBe(true);
    });

    test('isRetryableError should return true for network TypeError', () => {
        const proc = createMockProcessor();
        const err = new TypeError('Failed to fetch');
        expect(proc.isRetryableError(err)).toBe(true);
    });

    test('isRetryableError should return true for network error message', () => {
        const proc = createMockProcessor();
        const err = new TypeError('NetworkError when attempting to fetch resource');
        expect(proc.isRetryableError(err)).toBe(true);
    });

    test('isRetryableError should return false for AbortError', () => {
        const proc = createMockProcessor();
        const err = new DOMException('The user aborted a request.', 'AbortError');
        expect(proc.isRetryableError(err)).toBe(false);
    });

    test('isRetryableError should return false for generic errors', () => {
        const proc = createMockProcessor();
        const err = new Error('Some API error');
        expect(proc.isRetryableError(err)).toBe(false);
    });

    test('isRetryableError should return false when isStopped (user manually stopped)', () => {
        const proc = createMockProcessor();
        proc.isStopped = true;
        const err = new StreamHeartbeatTimeoutError(90000);
        expect(proc.isRetryableError(err)).toBe(false);
    });

    test('isRetryableError should return false when isFinished', () => {
        const proc = createMockProcessor();
        proc.isFinished = true;
        const err = new StreamHeartbeatTimeoutError(90000);
        expect(proc.isRetryableError(err)).toBe(false);
    });

    test('retry decision: should retry when error is retryable and under max retries', () => {
        const proc = createMockProcessor();
        const err = new StreamHeartbeatTimeoutError(90000);
        const shouldRetry = proc.isRetryableError(err) && proc.retryParams && proc.streamRetryCount < proc.maxStreamRetries;
        expect(shouldRetry).toBe(true);
    });

    test('retry decision: should NOT retry when max retries exceeded', () => {
        const proc = createMockProcessor();
        proc.streamRetryCount = 2; // already at max
        const err = new StreamHeartbeatTimeoutError(90000);
        const shouldRetry = proc.isRetryableError(err) && proc.retryParams && proc.streamRetryCount < proc.maxStreamRetries;
        expect(shouldRetry).toBe(false);
    });

    test('retry decision: should NOT retry when no retryParams', () => {
        const proc = createMockProcessor({ retryParams: null });
        const err = new StreamHeartbeatTimeoutError(90000);
        const shouldRetry = proc.isRetryableError(err) && proc.retryParams && proc.streamRetryCount < proc.maxStreamRetries;
        expect(shouldRetry).toBeFalsy();
    });

    test('exponential backoff timing: delays double each attempt', () => {
        const delays = [1, 2, 3].map(attempt =>
            Math.min(1000 * Math.pow(2, attempt - 1), 15000),
        );
        expect(delays).toEqual([1000, 2000, 4000]);
    });

    test('exponential backoff timing: caps at 15 seconds', () => {
        const delay = Math.min(1000 * Math.pow(2, 10), 15000);
        expect(delay).toBe(15000);
    });
});
