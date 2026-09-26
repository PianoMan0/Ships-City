const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const host = '127.0.0.1';
const port = Number(process.env.PORT) || 3000;
const apiUrl = 'https://ships.hackclub.com/api/v1/ysws_entries';
const cacheDuration = 5 * 60 * 1000;
let cachedProjects = null;
let cacheExpiresAt = 0;

async function requestProjects() {
    let lastError;

    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);

        try {
            const response = await fetch(apiUrl, {
                signal: controller.signal,
                headers: { accept: 'application/json' }
            });

            if (!response.ok) {
                throw new Error(`Ships API returned HTTP ${response.status}`);
            }

            const projects = await response.json();
            if (!Array.isArray(projects)) {
                throw new Error('Ships API returned an unexpected response format');
            }

            cachedProjects = projects.filter(project => typeof project?.id === 'string' && project.id.length > 0);
            cacheExpiresAt = Date.now() + cacheDuration;
            return { projects: cachedProjects, source: 'live' };
        } catch (error) {
            lastError = error;
            if (attempt === 0) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    if (cachedProjects) {
        return { projects: cachedProjects, source: 'saved' };
    }

    throw lastError;
}

function sendJson(response, statusCode, body, source) {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...(source ? { 'x-data-source': source } : {})
    });
    response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (requestUrl.pathname === '/api/projects') {
        if (request.method !== 'GET') {
            sendJson(response, 405, { error: 'Method not allowed' });
            return;
        }

        try {
            const result = Date.now() < cacheExpiresAt
                ? { projects: cachedProjects, source: 'saved' }
                : await requestProjects();
            sendJson(response, 200, {
                total: result.projects.length,
                projects: result.projects.slice(0, 100)
            }, result.source);
        } catch (error) {
            console.error('Could not load projects:', error.message);
            sendJson(response, 502, { error: 'The Ships API is unavailable. Check your internet connection and retry.' });
        }
        return;
    }

    if (request.method !== 'GET' || (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html')) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }

    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache'
    });
    response.end(html);
});

function listenOnAvailablePort(candidate = port) {
    const onListening = () => {
        console.log(`Ships City is running at http://${host}:${candidate}`);
        console.log('Press Ctrl+C to stop the server.');
    };

    const onError = error => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE' && candidate < port + 20) {
            console.warn(`Port ${candidate} is busy; trying ${candidate + 1}.`);
            listenOnAvailablePort(candidate + 1);
            return;
        }
        throw error;
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(candidate, host);
}

listenOnAvailablePort();