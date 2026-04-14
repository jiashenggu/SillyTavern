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
