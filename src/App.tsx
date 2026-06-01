import { useState, useEffect } from "react";
import { auth, db, provider, handleFirestoreError, OperationType } from "./firebase";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, onSnapshot } from "firebase/firestore";
import { UserState, ActiveWorkout, Routine, Exercise, CalendarEvent } from "./types";

// Import layout tabs
import HomeTab from "./components/HomeTab";
import FitnessTab from "./components/FitnessTab";
import HealthTab from "./components/HealthTab";
import CalendarTab from "./components/CalendarTab";
import AIFieldCoach from "./components/AIFieldCoach";

const defaultState = (): UserState => ({
  todayGoals: [],
  tomorrowGoals: [],
  lastDate: new Date().toDateString(),
  routines: [],
  exerciseHistory: {},
  supplements: [],
  suppChecks: {},
  waterGoal: 2000,
  waterUnit: "ml",
  waterLog: {},
  weightLog: [],
  useLb: false
});

export default function App() {
  const [activeTab, setActiveTab] = useState<"home" | "fitness" | "health" | "calendar">("home");
  
  // Auth Fast Startup caching
  const [user, setUser] = useState<any>(() => {
    const cachedUser = localStorage.getItem("life_dashboard_cached_user");
    if (cachedUser) {
      try {
        return JSON.parse(cachedUser);
      } catch (e) {
        return null;
      }
    }
    return null;
  });
  
  const [authLoading, setAuthLoading] = useState(!user);

  // User details state (optimistically load from cache or defaults)
  const [userState, setUserState] = useState<UserState>(() => {
    const cachedData = localStorage.getItem("life_dashboard_user_state");
    if (cachedData) {
      try {
        return JSON.parse(cachedData);
      } catch (e) {
        return defaultState();
      }
    }
    return defaultState();
  });

  // Google Calendar Integration states
  const [gcalAccessToken, setGcalAccessToken] = useState<string | null>(null);
  const [gcalEvents, setGcalEvents] = useState<CalendarEvent[]>([]);
  const [gcalLoading, setGcalLoading] = useState(false);
  const [gcalError, setGcalError] = useState<string | null>(null);
  const [gsiScriptLoaded, setGsiScriptLoaded] = useState(false);

  // Active training workout
  const [activeWorkout, setActiveWorkout] = useState<ActiveWorkout | null>(null);

  // Load GSI Script dynamically for Google Calendar API
  useEffect(() => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => {
      if ((window as any).google?.accounts?.oauth2) {
        setGsiScriptLoaded(true);
      }
    };
    document.head.appendChild(s);

    // Restore cached calendar Token & cookies on boot
    const cachedToken = localStorage.getItem("gcal_token");
    const cachedExpiry = localStorage.getItem("gcal_token_expiry");
    if (cachedToken && cachedExpiry && parseInt(cachedExpiry) > Date.now()) {
      setGcalAccessToken(cachedToken);
      fetchGCalEvents(cachedToken);
    }
  }, []);

  // Firebase auth sync listener
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, FirebaseUser => {
      if (FirebaseUser) {
        const profile = {
          uid: FirebaseUser.uid,
          displayName: FirebaseUser.displayName,
          email: FirebaseUser.email,
          photoURL: FirebaseUser.photoURL || ""
        };
        setUser(profile);
        setAuthLoading(false);

        // Save logon status in client caches for instant boot
        localStorage.setItem("life_dashboard_cached_user", JSON.stringify(profile));
        document.cookie = `is_authenticated=true; max-age=2592000; path=/`;
      } else {
        // Logged out
        setUser(null);
        setAuthLoading(false);
        localStorage.removeItem("life_dashboard_cached_user");
        document.cookie = "is_authenticated=; max-age=0; path=/";
      }
    });

    return () => unsubscribeAuth();
  }, []);

  // Sync state from Firestore using active listeners
  useEffect(() => {
    if (!user?.uid) return;

    const docRef = doc(db, "users", user.uid);
    const unsubscribeFirestore = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        const today = new Date().toDateString();
        let updatedGoals = d.todayGoals || [];
        let updatedTomorrow = d.tomorrowGoals || [];
        let updatedLastDate = d.lastDate || today;

        // Carry-over tasks checklist at midnight rollover
        if (d.lastDate && d.lastDate !== today && d.tomorrowGoals?.length) {
          updatedGoals = [
            ...(d.todayGoals || []).filter((g: any) => !g.done),
            ...(d.tomorrowGoals || []).map((g: any) => ({ ...g, done: false }))
          ];
          updatedTomorrow = [];
          updatedLastDate = today;

          // Push rolled-over items optimistically back
          setDoc(doc(db, "users", user.uid), {
            ...d,
            todayGoals: updatedGoals,
            tomorrowGoals: updatedTomorrow,
            lastDate: updatedLastDate
          }).catch(err => {
            handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
          });
        }

        const fetched: UserState = {
          todayGoals: updatedGoals,
          tomorrowGoals: updatedTomorrow,
          lastDate: updatedLastDate,
          routines: d.routines || [],
          exerciseHistory: d.exerciseHistory || {},
          supplements: d.supplements || [],
          suppChecks: d.suppChecks || {},
          waterGoal: d.waterGoal ?? 2000,
          waterUnit: d.waterUnit || "ml",
          waterLog: d.waterLog || {},
          weightLog: d.weightLog || [],
          useLb: d.useLb || false
        };

        setUserState(fetched);
        // Sync static cache
        localStorage.setItem("life_dashboard_user_state", JSON.stringify(fetched));
      } else {
        // Fresh profile registration
        const fresh = defaultState();
        setDoc(doc(db, "users", user.uid), fresh).catch(err => {
          handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}`);
        });
      }
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, `users/${user.uid}`);
    });

    return () => unsubscribeFirestore();
  }, [user?.uid]);

  // Google Calendar Connection launcher
  const connectGcal = () => {
    if (!(window as any).google?.accounts?.oauth2) {
      alert("Calendar libraries are still initializing, please try again in a moment!");
      return;
    }
    const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: "124339449156-61291qfr8vbktbsqj7rk5qq7qq5nsohg.apps.googleusercontent.com",
      scope: "https://www.googleapis.com/auth/calendar.readonly",
      callback: (resp: any) => {
        if (resp.error) {
          setGcalError("Interactive access was denied by user.");
          return;
        }
        const token = resp.access_token;
        const expiry = Date.now() + (resp.expires_in || 3600) * 1000;
        
        setGcalAccessToken(token);
        setGcalError(null);

        // Persist token in cookie and localStorage
        localStorage.setItem("gcal_token", token);
        localStorage.setItem("gcal_token_expiry", expiry.toString());
        document.cookie = `gcal_token=${token}; max-age=2592000; path=/`;

        fetchGCalEvents(token);
      }
    });

    tokenClient.requestAccessToken({ prompt: "" });
  };

  const disconnectGcal = () => {
    if (gcalAccessToken) {
      try {
        (window as any).google?.accounts?.oauth2?.revoke(gcalAccessToken);
      } catch (e) {}
    }
    setGcalAccessToken(null);
    setGcalEvents([]);
    setGcalError(null);

    // Clear caches
    localStorage.removeItem("gcal_token");
    localStorage.removeItem("gcal_token_expiry");
    document.cookie = "gcal_token=; max-age=0; path=/";
  };

  const fetchGCalEvents = async (token: string) => {
    setGcalLoading(true);
    setGcalError(null);
    try {
      const now = new Date();
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const e = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
      
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(s)}&timeMax=${encodeURIComponent(e)}&singleEvents=true&orderBy=startTime&maxResults=50`;
      
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        if (res.status === 401) {
          disconnectGcal();
          setGcalError("Connection session expired. Please reconnect.");
        } else {
          setGcalError(`Google Calendar error response (${res.status}).`);
        }
        return;
      }
      const data = await res.json();
      setGcalEvents(data.items || []);
    } catch (err) {
      setGcalError("Could not retrieve calendar items due to a connection issue.");
    } finally {
      setGcalLoading(false);
    }
  };

  // Google Login popup launcher
  const handleGoogleLogin = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error("Popup logon missed/denied:", e);
    }
  };

  // Standard user log out
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      disconnectGcal();
      setUser(null);
      setUserState(defaultState());
      localStorage.removeItem("life_dashboard_user_state");
    } catch (e) {}
  };

  // Push state improvements back to Firestore
  const updateFirestore = (updated: UserState) => {
    if (!user?.uid) return;
    setDoc(doc(db, "users", user.uid), updated).catch(err => {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`);
    });
  };

  // Global triggers inside tabs
  const handleToggleGoal = (id: string) => {
    const copy = { ...userState };
    copy.todayGoals = copy.todayGoals.map(g => (g.id === id ? { ...g, done: !g.done } : g));
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleAddTodayGoal = (text: string) => {
    const copy = { ...userState };
    copy.todayGoals = [
      ...copy.todayGoals,
      { id: Math.random().toString(36).slice(2, 9), text, done: false }
    ];
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleRemoveTodayGoal = (id: string) => {
    const copy = { ...userState };
    copy.todayGoals = copy.todayGoals.filter(g => g.id !== id);
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleAddTomorrowGoal = (text: string) => {
    const copy = { ...userState };
    copy.tomorrowGoals = [
      ...copy.tomorrowGoals,
      { id: Math.random().toString(36).slice(2, 9), text, done: false }
    ];
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleRemoveTomorrowGoal = (id: string) => {
    const copy = { ...userState };
    copy.tomorrowGoals = copy.tomorrowGoals.filter(tg => tg.id !== id);
    setUserState(copy);
    updateFirestore(copy);
  };

  // Supplements checking
  const handleToggleSuppCheck = (suppId: string, slotKey: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const copy = { ...userState };
    if (!copy.suppChecks[today]) {
      copy.suppChecks[today] = {};
    }
    const key = `${suppId}_${slotKey}`;
    copy.suppChecks[today][key] = !copy.suppChecks[today][key];
    setUserState(copy);
    updateFirestore(copy);
  };

  // Adding supplements
  const handleAddSupplement = (name: string, dosage: string, times: string[]) => {
    const copy = { ...userState };
    copy.supplements = [
      ...copy.supplements,
      { id: Math.random().toString(36).slice(2, 9), name, dosage, times }
    ];
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleRemoveSupplement = (id: string) => {
    const copy = { ...userState };
    copy.supplements = copy.supplements.filter(s => s.id !== id);
    setUserState(copy);
    updateFirestore(copy);
  };

  // Hydration triggers
  const handleUpdateWaterGoal = (val: number) => {
    const copy = { ...userState, waterGoal: val };
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleUpdateWaterUnit = (unit: string) => {
    const copy = { ...userState, waterUnit: unit };
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleLogWater = (idx: number) => {
    const today = new Date().toISOString().slice(0, 10);
    const copy = { ...userState };
    const current = copy.waterLog[today] || 0;
    // Toggle log idx
    copy.waterLog[today] = idx < current ? idx : idx + 1;
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleResetWater = () => {
    const today = new Date().toISOString().slice(0, 10);
    const copy = { ...userState };
    copy.waterLog[today] = 0;
    setUserState(copy);
    updateFirestore(copy);
  };

  // Gym training triggers
  const handleStartWorkout = (routineId: string) => {
    const r = userState.routines.find(x => x.id === routineId);
    if (!r) return;
    setActiveWorkout({
      routine: r,
      sets: r.exercises.map(() => [{ weight: "", reps: "" }]),
      startTime: Date.now(),
      currentEx: 0
    });
  };

  const handleCancelWorkout = () => {
    setActiveWorkout(null);
  };

  const handleFinishWorkout = (exercisesLogged: Record<string, { weight: number; reps: number; date: string }>) => {
    const copy = { ...userState };
    Object.entries(exercisesLogged).forEach(([exName, stats]) => {
      if (!copy.exerciseHistory[exName]) {
        copy.exerciseHistory[exName] = [];
      }
      copy.exerciseHistory[exName].push(stats);
    });
    setActiveWorkout(null);
    setUserState(copy);
    updateFirestore(copy);
    setActiveTab("fitness");
  };

  const handleSaveRoutine = (id: string | null, name: string, exercises: Exercise[]) => {
    const copy = { ...userState };
    if (id) {
      copy.routines = copy.routines.map(r => (r.id === id ? { ...r, name, exercises } : r));
    } else {
      copy.routines = [
        ...copy.routines,
        { id: Math.random().toString(36).slice(2, 9), name, exercises }
      ];
    }
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleDeleteRoutine = (id: string) => {
    const copy = { ...userState };
    copy.routines = copy.routines.filter(r => r.id !== id);
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleToggleLb = () => {
    const copy = { ...userState, useLb: !userState.useLb };
    setUserState(copy);
    updateFirestore(copy);
  };

  // Weight entry triggers
  const handleLogWeight = (weightKg: number) => {
    const today = new Date().toISOString().slice(0, 10);
    const copy = { ...userState };
    const idx = copy.weightLog.findIndex(e => e.date === today);
    if (idx >= 0) {
      copy.weightLog[idx].weight = weightKg;
    } else {
      copy.weightLog.push({ date: today, weight: weightKg });
    }
    setUserState(copy);
    updateFirestore(copy);
  };

  const handleRemoveWeight = (date: string) => {
    const copy = { ...userState };
    copy.weightLog = copy.weightLog.filter(e => e.date !== date);
    setUserState(copy);
    updateFirestore(copy);
  };

  // Spinner on startupauth resolving
  if (authLoading) {
    return (
      <div className="fixed inset-0 bg-[#0d0b14] flex flex-col justify-center items-center gap-4 text-[#f0c972]">
        <div className="w-10 h-10 border-4 border-[#f0c972] border-t-transparent rounded-full animate-spin" />
        <span className="font-mono text-xs tracking-widest text-[#6b6485]">INITIALIZING PORTAL...</span>
      </div>
    );
  }

  // LOGIN SCREEN
  if (!user) {
    return (
      <div className="fixed inset-0 bg-[#0d0b14] p-6 flex flex-col items-center justify-center gap-6 text-center select-none">
        <div>
          <div className="font-bebas text-5xl text-gradient bg-clip-text text-transparent bg-gradient-to-r from-[#f0c972] to-[#e07b3f] tracking-widest mb-1 animate-pulse">
            LIFE DASHBOARD
          </div>
          <p className="font-mono text-[10px] text-[#6b6485] tracking-widest uppercase">
            Unified Wellness & Performance Hub
          </p>
        </div>

        <p className="font-mono text-xs text-[#9991b8] max-w-[280px] leading-relaxed">
          Securely sign in using your Google Account to synchronize training routines, calendars, and nutrition goals instantly.
        </p>

        <button
          onClick={handleGoogleLogin}
          className="flex items-center gap-3 bg-[#13111f] border border-[#2a2440] hover:border-[#f0c972] rounded-2xl px-6 py-3.5 text-xs text-white font-mono shadow-xl cursor-pointer active:scale-95 transition-all"
        >
          <svg className="w-5 h-5" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Sign in with Google
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d0b14] text-[#e8e3f8] flex flex-col relative select-none">
      {/* Upper Account Bar details */}
      <header className="flex justify-between items-center px-4 py-3 border-b border-[#221d35] shrink-0 sticky top-0 bg-[#0d0b14dd] backdrop-blur z-40 max-w-md w-full mx-auto">
        <div className="flex items-center gap-2">
          {user.photoURL ? (
            <img src={user.photoURL} alt="User avatar" referrerPolicy="no-referrer" className="w-7 h-7 rounded-full border border-[#f0c972]" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-gradient-to-r from-[#f0c972] to-[#e07b3f] flex items-center justify-center font-bebas text-xs text-[#0d0b14] font-bold">
              {(user.displayName || "User").charAt(0).toUpperCase()}
            </div>
          )}
          <span className="font-mono text-[10px] text-[#9991b8] truncate max-w-[120px]">
            {user.displayName || "User"}
          </span>
        </div>

        <button
          onClick={handleSignOut}
          className="bg-transparent border border-[#221d35] rounded-lg px-2.5 py-1 text-[9px] font-mono text-[#3d3657] hover:text-[#9991b8] active:scale-95 transition-all cursor-pointer"
        >
          Sign out
        </button>
      </header>

      {/* Main tab elements content wrapper */}
      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        {activeTab === "home" && (
          <HomeTab
            userState={userState}
            gcalAccessToken={gcalAccessToken}
            gcalEvents={gcalEvents}
            gcalLoading={gcalLoading}
            gcalError={gcalError}
            onConnectGcal={connectGcal}
            onDisconnectGcal={disconnectGcal}
            onRefreshGcal={() => gcalAccessToken && fetchGCalEvents(gcalAccessToken)}
            onToggleGoal={handleToggleGoal}
            onAddTodayGoal={handleAddTodayGoal}
            onRemoveTodayGoal={handleRemoveTodayGoal}
            onAddTomorrowGoal={handleAddTomorrowGoal}
            onRemoveTomorrowGoal={handleRemoveTomorrowGoal}
            onToggleSuppCheck={handleToggleSuppCheck}
          />
        )}

        {activeTab === "fitness" && (
          <FitnessTab
            userState={userState}
            activeWorkout={activeWorkout}
            onStartWorkout={handleStartWorkout}
            onFinishWorkout={handleFinishWorkout}
            onCancelWorkout={handleCancelWorkout}
            onSaveRoutine={handleSaveRoutine}
            onDeleteRoutine={handleDeleteRoutine}
            onToggleLb={handleToggleLb}
          />
        )}

        {activeTab === "health" && (
          <HealthTab
            userState={userState}
            onUpdateWaterGoal={handleUpdateWaterGoal}
            onUpdateWaterUnit={handleUpdateWaterUnit}
            onLogWater={handleLogWater}
            onResetWater={handleResetWater}
            onAddSupplement={handleAddSupplement}
            onRemoveSupplement={handleRemoveSupplement}
            onToggleSuppCheck={handleToggleSuppCheck}
            onLogWeight={handleLogWeight}
            onRemoveWeight={handleRemoveWeight}
          />
        )}

        {activeTab === "calendar" && (
          <CalendarTab
            userState={userState}
            gcalAccessToken={gcalAccessToken}
            onConnectGcal={connectGcal}
            onToggleGoal={handleToggleGoal}
            onToggleSuppCheck={handleToggleSuppCheck}
          />
        )}
      </main>

      {/* Persistent floating Coach overlay */}
      <AIFieldCoach userState={userState} />

      {/* Global Tabbar footer */}
      <nav className="fixed bottom-0 left-0 right-0 h-16 bg-[#0d0b14ee] border-t border-[#221d35] flex items-center justify-around backdrop-blur-xl z-40 max-w-md w-full mx-auto">
        {[
          { key: "home", label: "Home", icon: "🏠" },
          { key: "fitness", label: "Fitness", icon: "🏋️" },
          { key: "health", label: "Health", icon: "💊" },
          { key: "calendar", label: "Calendar", icon: "📅" }
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => {
              // Lock tab change if user is in middle of a training workout session
              if (activeWorkout) {
                if (confirm("Are you sure you want to pause your active workout views? You can return to resume it under Training tab later.")) {
                  setActiveTab(tab.key as any);
                }
              } else {
                setActiveTab(tab.key as any);
              }
            }}
            className={`flex flex-col items-center gap-1 font-mono text-[9px] uppercase tracking-wider h-full justify-center flex-1 cursor-pointer transition-colors ${
              activeTab === tab.key ? "text-[#f0c972]" : "text-[#3d3657] hover:text-[#9991b8]"
            }`}
            style={{
              borderTop: activeTab === tab.key ? "2px solid #f0c972" : "2px solid transparent"
            }}
          >
            <span className="text-lg leading-none">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
