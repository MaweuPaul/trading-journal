import { NextRequest } from 'next/server';
import { protectedResource } from '@/components/oauthMetadata';

// Path-suffixed form some clients ask for: /.well-known/oauth-protected-resource/api/mcp
export const dynamic = 'force-dynamic';
export function GET(request: NextRequest) { return protectedResource(request); }
