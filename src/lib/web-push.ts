import webpush from "web-push";
import { libsqlClient } from "./db";

const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
const vapidSubject = process.env.VAPID_SUBJECT || "mailto:sowon@savefancam.com";

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  console.warn("⚠️ Web Push VAPID keys are missing from environment variables!");
}

export async function sendWebPushNotification(title: string, body: string, urlPath: string) {
  if (!vapidPublicKey || !vapidPrivateKey) {
    console.error("❌ Cannot send web push: VAPID keys are not configured.");
    return;
  }

  try {
    const result = await libsqlClient.execute(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions"
    );

    if (result.rows.length === 0) {
      console.log("🔔 [Web Push] No active subscribers. Skipping dispatch.");
      return;
    }

    console.log(`🔔 [Web Push] Dispatching notification to ${result.rows.length} subscribers...`);

    const payload = JSON.stringify({
      title,
      body,
      url: urlPath,
      icon: '/favicon.ico',
      badge: '/favicon.ico'
    });

    const promises = result.rows.map(async (row) => {
      const subscription = {
        endpoint: String(row.endpoint),
        keys: {
          p256dh: String(row.p256dh),
          auth: String(row.auth)
        }
      };

      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.log(`🗑️ [Web Push] Pruning expired subscription: ${subscription.endpoint.substring(0, 50)}...`);
          await libsqlClient.execute({
            sql: "DELETE FROM push_subscriptions WHERE endpoint = ?",
            args: [subscription.endpoint]
          });
        } else {
          console.error(`❌ [Web Push] Push failed for ${subscription.endpoint.substring(0, 40)}:`, err.message || err);
        }
      }
    });

    await Promise.allSettled(promises);
    console.log("✅ [Web Push] Finished dispatching push notifications.");
  } catch (err: any) {
    console.error("❌ [Web Push] Error querying subscriptions or dispatching push:", err.message || err);
  }
}
