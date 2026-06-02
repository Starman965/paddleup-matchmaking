export type PwaPlatform = "ios" | "android" | "desktop" | "unknown";
export type PwaBrowser = "safari" | "chrome" | "firefox" | "edge" | "unknown";

export type PwaInstallState = {
  platform: PwaPlatform;
  browser: PwaBrowser;
  isStandalone: boolean;
  canUseBeforeInstallPrompt: boolean;
  canRequestNotifications: boolean;
  shouldShowIosSafariInstallGuide: boolean;
  shouldSuggestOpenInSafari: boolean;
};

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

function detectPlatform(userAgent: string, platform: string): PwaPlatform {
  const normalizedUserAgent = userAgent.toLowerCase();
  const normalizedPlatform = platform.toLowerCase();
  const isIpadOsDesktopMode = normalizedPlatform === "macintel" && navigator.maxTouchPoints > 1;

  if (/iphone|ipad|ipod/.test(normalizedUserAgent) || isIpadOsDesktopMode) return "ios";
  if (/android/.test(normalizedUserAgent)) return "android";
  if (/mac|win|linux|cros/.test(normalizedPlatform)) return "desktop";
  return "unknown";
}

function detectBrowser(userAgent: string): PwaBrowser {
  const normalizedUserAgent = userAgent.toLowerCase();
  const isCriOs = normalizedUserAgent.includes("crios");
  const isFxiOs = normalizedUserAgent.includes("fxios");
  const isEdge = normalizedUserAgent.includes("edg/") || normalizedUserAgent.includes("edgios");
  const isChrome = normalizedUserAgent.includes("chrome") || isCriOs;
  const isSafari = normalizedUserAgent.includes("safari") && !isChrome && !isFxiOs && !isEdge;

  if (isEdge) return "edge";
  if (isChrome) return "chrome";
  if (isFxiOs || normalizedUserAgent.includes("firefox")) return "firefox";
  if (isSafari) return "safari";
  return "unknown";
}

export function getPwaInstallState(): PwaInstallState {
  if (typeof window === "undefined") {
    return {
      platform: "unknown",
      browser: "unknown",
      isStandalone: false,
      canUseBeforeInstallPrompt: false,
      canRequestNotifications: false,
      shouldShowIosSafariInstallGuide: false,
      shouldSuggestOpenInSafari: false
    };
  }

  const platform = detectPlatform(navigator.userAgent, navigator.platform);
  const browser = detectBrowser(navigator.userAgent);
  const navigatorWithStandalone = navigator as NavigatorWithStandalone;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
  const supportsNotifications = "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  const canRequestNotifications = supportsNotifications && isStandalone;

  return {
    platform,
    browser,
    isStandalone,
    canUseBeforeInstallPrompt: platform === "android" && !isStandalone,
    canRequestNotifications,
    shouldShowIosSafariInstallGuide: platform === "ios" && browser === "safari" && !isStandalone,
    shouldSuggestOpenInSafari: platform === "ios" && browser !== "safari" && !isStandalone
  };
}
