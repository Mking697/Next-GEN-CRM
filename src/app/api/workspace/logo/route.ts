import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { readLogo } from "@/server/organisation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The signed-in company's own logo.
 *
 * Scoped to the viewer's organisation and nothing else - there is no id in the
 * URL, so this route cannot be pointed at somebody else's. `private` caching,
 * because a shared cache in front of this would be serving one company's logo
 * to another's browser.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse(null, { status: 401 });

  const logo = await readLogo(user.orgId);
  if (!logo) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(logo.bytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": logo.mime,
      "cache-control": "private, max-age=60",
    },
  });
}
