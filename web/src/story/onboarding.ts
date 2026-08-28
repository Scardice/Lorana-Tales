export type OnboardingFlag = "tutorialPromptSeen" | "manualPlaybackHintSeen" | "tutorialPlaybackCoachSeen";

interface AccountMe {
  authenticated?: boolean;
  user?: Partial<Record<OnboardingFlag, boolean>>;
}

let accountAvailable: boolean | undefined;

const cookieNames: Record<OnboardingFlag, string> = {
  tutorialPromptSeen: "lorana_tutorial_prompt_seen",
  manualPlaybackHintSeen: "lorana_manual_playback_hint_seen",
  tutorialPlaybackCoachSeen: "lorana_tutorial_playback_coach_seen",
};

function cookieValue(name: string) {
  return document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || "";
}

function setSeenCookie(flag: OnboardingFlag) {
  document.cookie = `${cookieNames[flag]}=1; Path=/; Max-Age=315360000; SameSite=Lax`;
}

function csrfToken() {
  try { return decodeURIComponent(cookieValue("scardice_account_csrf")); }
  catch { return cookieValue("scardice_account_csrf"); }
}

async function accountMe(): Promise<AccountMe> {
  try {
    if (accountAvailable === undefined) {
      const config = await fetch("/api/account/config", { credentials: "same-origin", cache: "no-store" });
      accountAvailable = config.ok;
    }
    if (!accountAvailable) return {};
    const response = await fetch("/api/account/me", { credentials: "same-origin", cache: "no-store" });
    return response.ok ? await response.json() as AccountMe : {};
  } catch { return {}; }
}

export async function onboardingSeen(flag: OnboardingFlag) {
  const localSeen = cookieValue(cookieNames[flag]) === "1";
  const me = await accountMe();
  if (!me.authenticated) return localSeen;
  const serverSeen = me.user?.[flag] === true;
  if (localSeen && !serverSeen) await markOnboardingSeen(flag);
  return localSeen || serverSeen;
}

export async function markOnboardingSeen(flag: OnboardingFlag) {
  setSeenCookie(flag);
  if (accountAvailable === false) return;
  const token = csrfToken();
  if (!token) return;
  try {
    await fetch("/api/account/onboarding", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ [flag]: true }),
    });
  } catch { /* Cookie remains the local fallback. */ }
}
