import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { endpoint } = body;

    if (!endpoint) {
      return new NextResponse("Endpoint is required", { status: 400 });
    }

    await dbApi.removePushSubscription(endpoint);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("❌ Unsubscribe API Error:", err);
    return new NextResponse(`Error unsubscribing: ${err.message}`, { status: 500 });
  }
}
