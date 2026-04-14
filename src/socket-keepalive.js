/**
 * Configures TCP keepalive and timeout on a socket for streaming resilience.
 * Helps detect dead connections faster in NAT/proxy/tunnel environments
 * where the default Linux keepalive interval (7200s) is far too slow.
 *
 * @param {import('net').Socket} socket The socket to configure
 * @param {object} [options] Configuration options
 * @param {number} [options.keepAliveInitialDelay=30000] Keepalive probe interval in ms
 * @param {number} [options.idleTimeout=120000] Idle timeout in ms before destroying the socket
 */
export function configureSocketKeepalive(socket, options = {}) {
    const {
        keepAliveInitialDelay = 30000,
        idleTimeout = 120000,
    } = options;

    socket.setKeepAlive(true, keepAliveInitialDelay);
    socket.setTimeout(idleTimeout, () => {
        socket.destroy();
    });
}
