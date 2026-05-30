import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { subscription } = body;

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {
      return new NextResponse("Invalid subscription payload", { status: 400 });
    }

    await dbApi.addPushSubscription(
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth
    );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("❌ Subscribe API Error:", err);
    return new NextResponse(`Error subscribing: ${err.message}`, { status: 500 });
  }
}
