import { createReadStream, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.STACKFALL_DEV_PORT) || 8137;
const WORKER_HOST = process.env.STACKFALL_WORKER_HOST || '127.0.0.1';
const WORKER_PORT = Number(process.env.STACKFALL_WORKER_PORT) || 8788;
const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
});

function isMatchPath(url = ''){ return url === '/matches' || url.startsWith('/matches/'); }

function proxyHttp(clientRequest, clientResponse){
  const upstream = httpRequest({
    hostname: WORKER_HOST,
    port: WORKER_PORT,
    method: clientRequest.method,
    path: clientRequest.url,
    headers: { ...clientRequest.headers, host: `${WORKER_HOST}:${WORKER_PORT}` },
  }, (response) => {
    clientResponse.writeHead(response.statusCode || 502, response.headers);
    response.pipe(clientResponse);
  });
  upstream.on('error', () => {
    if (!clientResponse.headersSent) clientResponse.writeHead(502, { 'Content-Type': 'application/json' });
    clientResponse.end(JSON.stringify({ ok: false, error: 'local_worker_unavailable' }));
  });
  clientRequest.pipe(upstream);
}

function serveStatic(request, response){
  if (request.method !== 'GET' && request.method !== 'HEAD'){
    response.writeHead(405).end();
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${PORT}`).pathname); }
  catch (error){ response.writeHead(400).end(); return; }
  if (pathname === '/') pathname = '/index.html';
  const file = resolve(ROOT, `.${pathname}`);
  if (file !== ROOT && !file.startsWith(ROOT + sep)){
    response.writeHead(403).end();
    return;
  }
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).pipe(response);
  } catch (error){ response.writeHead(404).end('Not found'); }
}

const server = createServer((request, response) => {
  if (isMatchPath(request.url)) proxyHttp(request, response);
  else serveStatic(request, response);
});

server.on('upgrade', (request, clientSocket, head) => {
  if (!isMatchPath(request.url)){
    clientSocket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const upstream = netConnect(WORKER_PORT, WORKER_HOST, () => {
    const headers = Object.entries({ ...request.headers, host: `${WORKER_HOST}:${WORKER_PORT}` })
      .map(([key, value]) => `${key}: ${value}`).join('\r\n');
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream).pipe(clientSocket);
  });
  const close = () => { try { clientSocket.destroy(); } catch (error) {} };
  upstream.on('error', close);
  clientSocket.on('error', () => { try { upstream.destroy(); } catch (error) {} });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`StackFall Duel dev server: http://127.0.0.1:${PORT}`);
  console.log(`Proxying /matches and WebSockets to http://${WORKER_HOST}:${WORKER_PORT}`);
});
