/**
 * AirLytics NCR — application shell.
 *
 * Folds the Next.js `app/layout.tsx` + `app/providers.tsx` + the route tree
 * into a single Vite entry. The provider stack is carried over unchanged; only
 * the framework seams differ:
 *   - `next/font/google` → a stylesheet link in index.html, with the
 *     --font-sans / --font-mono / --font-display / --font-body variables
 *     declared in index.css
 *   - `next/dynamic`     → the React.lazy shim in @/lib/dynamic
 *   - `export const metadata` → static <head> tags in index.html
 *   - the app-router file tree → the react-router routes below
 *
 * Routes:
 *   /                  the intro scroll track; Scan NCR hands off to /terminal
 *   /terminal          public terminal, Live Monitoring
 *   /terminal/geo-map  public terminal, geospatial plume map
 *
 * /console — the engineering console, and the Next route tree's third surface
 * — was removed. Anything still pointing at it falls through to the catch-all
 * and lands on the intro rather than a blank screen.
 */
import * as React from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster } from 'sonner';
import dynamic from '@/lib/dynamic';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppStore } from '@/store/useAppStore';
import { IntroScreen } from '@/components/intro/IntroScreen';
import { ForecastStatus } from '@/components/ui/forecast-status';

// Each of these pulls a heavy chunk — Leaflet, Recharts, Three — so they stay
// out of the landing bundle. The fallback covers the chunk fetch so the scan
// hand-off never lands on a blank frame.
const TerminalLayout = dynamic(() => import('@/components/terminal/TerminalLayout').then((m) => m.default), {
  ssr: false,
  loading: () => <BootSplash />,
});

const TerminalOverview = dynamic(() => import('@/components/terminal/TerminalOverview').then((m) => m.default), {
  ssr: false,
});

const TerminalGeoMap = dynamic(() => import('@/components/terminal/TerminalGeoMap').then((m) => m.default), {
  ssr: false,
});
const TerminalForecast = dynamic(
  () => import('@/components/terminal/TerminalForecast').then((m) => m.default),
  { ssr: false },
);
const TerminalMatrices = dynamic(
  () => import('@/components/terminal/TerminalMatrices').then((m) => m.default),
  { ssr: false },
);
const TerminalWarnings = dynamic(
  () => import('@/components/terminal/TerminalWarnings').then((m) => m.default),
  { ssr: false },
);

function BootSplash() {
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-base">
      <div className="grid-bg pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative flex flex-col items-center gap-3">
        <div className="size-10 animate-spin rounded-full border-2 border-hairline border-t-accent" />
        <span className="font-mono text-2xs uppercase tracking-[0.28em] text-accent">
          Initialising d03 domain
        </span>
      </div>
    </div>
  );
}

/**
 * Landing track: the aerosol particle field and its scroll choreography.
 *
 * "Scan NCR" plays the disperse animation behind the hand-off curtain, then
 * opens the public terminal.
 */
/** True once the landing page has been mounted in this page load. */
let cameThroughLanding = false;

/**
 * How long a reader stays "already here" across a reload.
 *
 * Thirty minutes is a guess at the gap between refreshing and returning, and
 * nothing depends on the exact figure: too short only means an extra trip
 * through the landing page, which is the fallback anyway.
 */
const RETURN_WINDOW_MS = 30 * 60 * 1000;
const LAST_SEEN_KEY = 'airlytics:terminal-last-seen';

/**
 * When this browser was last on the terminal.
 *
 * `localStorage` rather than `sessionStorage`: a tab left open overnight keeps
 * its session, so sessionStorage would call that reader "still here" the next
 * morning - which is precisely the case that should get the landing page back.
 * A timestamp answers both questions with one value.
 *
 * Every read and write is guarded. Private windows and blocked site data throw
 * on access, and the failure has to fall to "not recently here" - sending a
 * reader through the landing page is the harmless mistake; letting a cold
 * visitor into the terminal is the one this guard exists to prevent.
 */
function wasRecentlyHere(): boolean {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    if (!raw) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < RETURN_WINDOW_MS;
  } catch {
    return false;
  }
}

function markHere() {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
  } catch {
    /* nothing to do: the reader takes the landing page next reload */
  }
}

/**
 * Sends a cold visitor to the landing page, and lets a returning one straight
 * back in.
 *
 * The terminal is the second half of a single piece: the landing page says
 * which city this is, where the numbers come from and how current they are,
 * and the terminal assumes a reader who has been told. Someone handed
 * /terminal/geo-map arrives at a map of unexplained colours instead.
 *
 * But a refresh is not a cold visit, and the first version of this treated it
 * as one - the module flag resets on any page load, so reloading the map threw
 * the reader back to the globe and made them scan in again to return to where
 * they already were. Three cases, one rule:
 *
 *   walked in from the landing page   the flag, true for this page load
 *   refreshed, or back within 30 min  the stamp, written while on the terminal
 *   new, or back after a long gap     neither, so the landing page
 *
 * `replace` so the redirect leaves no history entry - otherwise Back from the
 * landing page would return to the deep link and bounce again.
 */
function RequireLanding({ children }: { children: React.ReactNode }) {
  // Read once on mount. Re-reading per render would let the stamp this very
  // component writes decide whether it should have rendered.
  const [allowed] = React.useState(() => cameThroughLanding || wasRecentlyHere());

  // Stamped while the terminal is open, so the window is measured from when
  // the reader left rather than from when they arrived. The interval covers a
  // tab left open and reloaded hours later; `visibilitychange` covers the more
  // common close, because there is no reliable unload on mobile.
  React.useEffect(() => {
    if (!allowed) return;
    markHere();
    const id = window.setInterval(markHere, 60_000);
    const onHide = () => {
      if (document.visibilityState === 'hidden') markHere();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [allowed]);

  if (!allowed) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function IntroRoute() {
  const navigate = useNavigate();
  const screen = useAppStore((s) => s.screen);
  const returnToIntro = useAppStore((s) => s.returnToIntro);
  const loadLiveForecast = useAppStore((s) => s.loadLiveForecast);
  const navigated = React.useRef(false);

  // Seen the landing page; the terminal routes may now be entered. In an
  // effect, not in the render body: React may render a component without
  // committing it, and a flag set on a render that never mounted would open
  // the terminal to a reader who was never shown the landing page. The effect
  // runs before the one below that navigates, so the ordering holds.
  React.useEffect(() => {
    cameThroughLanding = true;
  }, []);

  // Pull the backend forecast once on mount. It replaces the synthetic frames
  // if it arrives; if the backend is down the UI carries on with them, so there
  // is no loading gate in front of the intro.
  React.useEffect(() => {
    void loadLiveForecast();
  }, [loadLiveForecast]);

  React.useEffect(() => {
    if (screen !== 'dashboard' || navigated.current) return;
    navigated.current = true;
    // The scan's destination, when it was started with one - a station picked
    // from the palette hands off to the map with that station selected. Read
    // from the store rather than passed down, because the palette that sets it
    // is mounted beside this route, not inside it.
    navigate(useAppStore.getState().scanTarget ?? '/terminal');
  }, [screen, navigate]);

  // Reset the screen machine on the way out, not during the navigation.
  // Resetting immediately re-rendered the intro mid-transition — the button
  // snapped back to "Scan NCR" and the particle field stopped dispersing.
  React.useEffect(() => () => returnToIntro(), [returnToIntro]);

  // The intro is a scroll track, so the page must scroll while it is up.
  return (
    <main className="relative w-full bg-base">
      <IntroScreen />
    </main>
  );
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme === 'light' ? 'light' : 'dark'}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{ className: 'font-mono text-xs' }}
    />
  );
}

export default function App() {
  // Dark by default, and not the OS's dark - ours.
  //
  // `enableSystem` is off rather than left on with a dark default: with it on,
  // a visitor whose machine is set to light gets a light site on first load,
  // which is the opposite of the intent. Off, the OS is never consulted and
  // `defaultTheme` decides.
  //
  // It only decides for a reader who has not chosen. next-themes writes an
  // explicit choice to localStorage, and the toggle and the command palette
  // both set 'light' or 'dark' literally - never 'system' - so a switch to
  // light stays switched on the next visit.
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {/* reducedMotion="user" makes every framer animation honour the OS setting */}
      <MotionConfig reducedMotion="user">
        {/* gate 17: hover waits ~800ms, keyboard focus opens instantly (Radix default) */}
        <TooltipProvider delayDuration={800} skipDelayDuration={300}>
          {/* Mounted here, at the root, and never inside a route or a motion.*
              subtree. Sonner's toaster is position: fixed, and a transformed
              ancestor becomes its containing block and traps its z-index — the
              same thing that put the command palette under the telemetry
              panels. framer writes a transform on the intro's header.

              Sonner's `theme` defaults to 'light' and does not follow the OS,
              so it has to be handed the resolved theme or toasts render
              white-on-white on the dark surfaces. */}
          <ThemedToaster />
          <ForecastStatus />

          <BrowserRouter>
            <Routes>
              <Route path="/" element={<IntroRoute />} />
              <Route
                path="/terminal"
                element={
                  <RequireLanding>
                    <TerminalLayout />
                  </RequireLanding>
                }
              >
                <Route index element={<TerminalOverview />} />
                <Route path="geo-map" element={<TerminalGeoMap />} />
                <Route path="forecast" element={<TerminalForecast />} />
                <Route path="matrices" element={<TerminalMatrices />} />
                <Route path="warnings" element={<TerminalWarnings />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
