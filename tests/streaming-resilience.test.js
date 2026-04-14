import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import net from 'node:net';
import { configureSocketKeepalive } from '../src/socket-keepalive.js';

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
                // Wait for the server-side 'connection' handler to fire
                setTimeout(() => {
                    client.destroy();
                    resolve();
                }, 50);
            });
            client.on('error', reject);
        });

        // Verify the server-side socket got configured
        expect(serverSockets.length).toBeGreaterThan(0);
        expect(serverSockets[0].timeout).toBe(120000);
    });
});
