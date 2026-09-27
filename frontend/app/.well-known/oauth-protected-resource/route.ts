import { NextRequest } from 'next/server';
import { protectedResource } from '@/components/oauthMetadata';

export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) { return protectedResource(request); }
