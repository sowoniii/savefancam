"use client";

import React, { useEffect, useState } from "react";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function NotificationSettings() {
  const [isSupported, setIsSupported] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const publicVapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    ) {
      setIsSupported(true);
      checkSubscription();
    } else {
      setIsLoading(false);
    }
  }, []);

  const checkSubscription = async () => {
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      setSubscription(sub);
    } catch (e) {
      console.error("Error checking push subscription:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubscribe = async () => {
    if (!isSupported || !publicVapidKey) return;
    setIsLoading(true);

    try {
      await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });

      await navigator.serviceWorker.ready;

      const result = await Notification.requestPermission();

      if (result !== "granted") {
        alert("알림 권한이 거부되었습니다. 브라우저 설정에서 권한을 허용해 주세요.");
        setIsLoading(false);
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const convertedVapidKey = urlBase64ToUint8Array(publicVapidKey);
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedVapidKey,
      });

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ subscription: sub }),
      });

      if (!response.ok) {
        throw new Error("Failed to save subscription on server");
      }

      setSubscription(sub);
      alert("실시간 아카이브 웹 푸시 알림이 활성화되었습니다! 🔔");
    } catch (e: any) {
      console.error("Failed to subscribe to web push:", e);
      alert(`알림 설정 중 오류가 발생했습니다: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnsubscribe = async () => {
    if (!subscription) return;
    setIsLoading(true);

    try {
      await subscription.unsubscribe();

      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      setSubscription(null);
      alert("아카이브 실시간 웹 푸시 알림이 해제되었습니다.");
    } catch (e: any) {
      console.error("Failed to unsubscribe:", e);
      alert(`알림 해제 중 오류가 발생했습니다: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  if (!isSupported) {
    return null;
  }

  const isSubscribed = !!subscription;

  return (
    <div
      className="gall-lnk-box"
      style={{
        display: "inline-flex",
        alignItems: "center",
        backgroundColor: "#f4f4f5",
        borderRadius: "4px",
        padding: "2px 8px",
        border: "1px solid #e4e4e7",
        height: "28px"
      }}
    >
      <button
        onClick={isSubscribed ? handleUnsubscribe : handleSubscribe}
        disabled={isLoading}
        style={{
          background: "none",
          border: "none",
          padding: "0 4px",
          color: isSubscribed ? "#d22d2d" : "#555555",
          fontSize: "12px",
          fontWeight: "600",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: "4px"
        }}
      >
        <span>{isSubscribed ? "🔔 실시간 알림 중" : "🔕 실시간 알림 받기"}</span>
      </button>
    </div>
  );
}
