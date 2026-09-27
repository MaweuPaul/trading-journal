import { NextRequest, NextResponse } from 'next/server';

const BACKEND_API_URL =
  process.env.BACKEND_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:4000/api';

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

function buildBackendUrl(path: string[], search: string) {
  const base = BACKEND_API_URL.replace(/\/$/, '');
  const route = path.map(segment => encodeURIComponent(segment)).join('/');
  return `${base}/${route}${search}`;
}

function buildForwardHeaders(request: NextRequest) {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue;
    if (lowerKey === 'origin' || lowerKey === 'referer') continue;
    headers.set(key, value);
  }
  return headers;
}

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const backendUrl = buildBackendUrl(path, request.nextUrl.search);
  const method = request.method.toUpperCase();

  const headers = buildForwardHeaders(request);
  // The address the browser/app used, so the backend can point OAuth clients back here.
  headers.set('x-tj-public-origin', request.nextUrl.origin);
  const response = await fetch(backendUrl, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer(),
    cache: 'no-store',
  });

  const responseHeaders = new Headers();
  for (const [key, value] of response.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}
