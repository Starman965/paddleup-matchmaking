const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;

export function hasPushVapidKey() {
  return Boolean(vapidKey);
}

function supportsWebPush() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export function pushSubscriptionEndpoint(subscription: PushSubscription) {
  return subscription.toJSON().endpoint || subscription.endpoint || "";
}

export async function getExistingWebPushSubscription() {
  if (!supportsWebPush()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

export async function requestWebPushSubscription() {
  if (!vapidKey) {
    throw new Error("Push setup needs a Web Push public key.");
  }
  if (!supportsWebPush()) {
    throw new Error("This browser does not support match alerts.");
  }

  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") {
    throw new Error(permission === "denied" ? "Notifications are blocked." : "Notifications were not allowed.");
  }

  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();
  if (existingSubscription) return existingSubscription;

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey)
  });
}
