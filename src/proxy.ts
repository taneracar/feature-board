import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "fb_session";
const MAX_AGE = 30 * 86_400;

/**
 * Optimistic checks only: no database here. A missing cookie on an app route
 * goes straight to /login; a present cookie gets its max-age refreshed so an
 * active user's cookie outlives the sliding server-side session. The real
 * check (token hash lookup, expiry, membership) runs in the Data Access Layer.
 */
export function proxy(req: NextRequest) {
  const token = req.cookies.get(COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/",
    maxAge: MAX_AGE,
  });
  return res;
}

export const config = {
  matcher: ["/workspaces", "/w/:path*"],
};
