import { NextRequest } from 'next/server';
import { authorizationServer } from '@/components/oauthMetadata';

export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) { return authorizationServer(request); }
