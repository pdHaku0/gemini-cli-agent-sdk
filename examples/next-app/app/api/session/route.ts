import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const COOKIE_NAME = 'agentchat_session_id';

export function GET() {
  const sessionId = cookies().get(COOKIE_NAME)?.value ?? null;
  return NextResponse.json({ sessionId });
}

export async function POST(req: Request) {
  let sessionId: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.sessionId === 'string' && body.sessionId.trim()) {
      sessionId = body.sessionId.trim();
    }
  } catch {
    // ignore
  }

  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId is required' }, { status: 400 });
  }

  cookies().set(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });

  return NextResponse.json({ ok: true });
}

