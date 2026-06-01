import { useState, useEffect, useRef } from "react";
import { UserState } from "../types";

interface AIFieldCoachProps {
  userState: UserState;
}

interface Message {
  role: "user" | "model";
  text: string;
  loading?: boolean;
}

export default function AIFieldCoach({ userState }: AIFieldCoachProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const hour = new Date().getHours();
      const greeting = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
      const hasHistory = Object.keys(userState.exerciseHistory || {}).length > 0;
      const initialMsg = hasHistory
        ? `${greeting}! I've reviewed your training data. Ask me about progressive overload, nutrition, recovery, or personalized wellness goals.`
        : `${greeting}! I'm your AI wellness coach. Once you log some routines or hydration data, I'll be able to provide tailored suggestions! For now, ask me anything.`;
      setMessages([{ role: "model", text: initialMsg }]);
    }
  }, [isOpen]);

  // Scroll to bottom on updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Build the rich context prompt to provide to the server side
  function buildSystemPrompt() {
    const weightUnit = userState.useLb ? "lb" : "kg";
    const routinesSummary = userState.routines?.length
      ? userState.routines.map(r => `${r.name}: ${r.exercises.map(e => e.name).join(", ")}`).join("\n")
      : "No routines configured yet.";
    
    const histSummary = userState.exerciseHistory
      ? Object.entries(userState.exerciseHistory)
          .slice(0, 8)
          .map(([name, sessions]) => {
            const last = sessions[sessions.length - 1];
            return last ? `${name}: last lifted ${last.weight}${weightUnit} x ${last.reps} reps (${sessions.length} sessions total)` : "";
          })
          .filter(Boolean)
          .join("\n")
      : "No workout history logged.";

    const suppSummary = userState.supplements?.length
      ? userState.supplements.map(s => `${s.name} ${s.dosage ? `(${s.dosage})` : ""} scheduled: ${s.times.join(", ")}`).join(", ")
      : "None";

    const weightHistory = userState.weightLog?.length
      ? [...userState.weightLog]
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-8)
          .map(e => `${e.date}: ${userState.useLb ? (e.weight * 2.20462).toFixed(1) : e.weight}${weightUnit}`)
          .join(", ")
      : "No weight log entries yet.";

    const goalsStr = userState.todayGoals?.length
      ? userState.todayGoals.map(g => `${g.done ? "✓" : "-"} ${g.text}`).join(", ")
      : "None listed for today.";

    const waterDone = Object.values(userState.waterLog).reduce((acc, curr) => acc + curr, 0);

    return `You are a professional wellness, fitness and nutrition coach. Be highly concise, practical, and direct. Keep your replies under 130 words. Use bullet points where appropriate for legibility. Connect responses directly to the user's logged metrics where possible. Do not lecture on general concepts; give precise and direct advice.

USER PERFORMANCE FILE:
- Weight Metric Unit: ${weightUnit}
- Configured routines:\n${routinesSummary}
- Recent exercise logs:\n${histSummary}
- Supplements checklists:\n${suppSummary}
- Weight progress logs:\n${weightHistory}
- Daily goal tasks checklist:\n${goalsStr}
- Hydration goal: ${userState.waterGoal} ml (unit: ${userState.waterUnit})`;
  }

  async function handleSend() {
    const query = input.trim();
    if (!query) return;

    setInput("");
    const userMsg: Message = { role: "user", text: query };
    const loadingMsg: Message = { role: "model", text: "Thinking...", loading: true };

    setMessages(prev => [...prev, userMsg, loadingMsg]);
    setIsLoading(true);

    try {
      const messagesHistory = [...messages, userMsg].map(m => ({
        role: m.role,
        content: m.text
      }));

      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: messagesHistory,
          systemPrompt: buildSystemPrompt()
        })
      });

      if (!res.ok) {
        throw new Error("Could not contact coach backend.");
      }

      const data = await res.json();
      setMessages(prev => {
        const filtered = prev.filter(m => !m.loading);
        return [...filtered, { role: "model", text: data.reply }];
      });
    } catch (err: any) {
      console.error(err);
      setMessages(prev => {
        const filtered = prev.filter(m => !m.loading);
        return [...filtered, { role: "model", text: `Sorry, I hit a snag: ${err.message || "Endpoint unavailable."}` }];
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      {/* FAB Button */}
      <button
        id="coach-fab"
        onClick={() => setIsOpen(!isOpen)}
        className="fixed bottom-20 left-4 w-14 h-14 rounded-full flex items-center justify-center text-2xl cursor-pointer shadow-lg z-50 transition-all duration-300 hover:scale-110 active:scale-95"
        style={{
          background: isOpen
            ? "linear-gradient(135deg, #9180c4, #5a4a8a)"
            : "linear-gradient(135deg, #f0c972, #e07b3f)",
          boxShadow: isOpen ? "0 4px 20px rgba(145, 128, 196, 0.4)" : "0 4px 20px rgba(240, 201, 114, 0.4)"
        }}
        title="AI Wellness Coach"
      >
        <span>🤖</span>
      </button>

      {/* Expandable modal */}
      {isOpen && (
        <div
          id="coach-modal"
          className="fixed bottom-36 left-4 right-4 md:left-6 max-w-[440px] h-[65vh] md:h-[500px] bg-[#13111f] rounded-2xl border border-[#2a2440] shadow-2xl flex flex-col z-50 overflow-hidden animate-in fade-in slide-in-from-bottom duration-200"
        >
          {/* Header */}
          <div className="flex items-center gap-3 p-4 border-b border-[#221d35] bg-[#13111f]">
            <div className="text-2xl">🤖</div>
            <div className="flex-1">
              <div className="font-bebas text-lg tracking-wider text-[#f0c972]">
                AI Wellness Coach
              </div>
              <div className="text-[10px] text-[#9991b8] font-mono">
                Powered by Gemini • Realtime wellness strategist
              </div>
            </div>
            <button
              onClick={() => setMessages([])}
              className="px-2 py-1 text-[10px] uppercase font-mono text-[#6b6485] rounded hover:text-white transition-colors cursor-pointer"
            >
              Clear
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 p-4 overflow-y-auto space-y-3 flex flex-col scrollbar-none">
            {messages.map((m, idx) => (
              <div
                key={idx}
                className={`max-w-[85%] p-3 rounded-2xl font-mono text-xs leading-relaxed ${
                  m.role === "user"
                    ? "align-self-end self-end bg-[#f0c97210] border border-[#f0c972] text-[#e8e3f8] rounded-br-sm"
                    : "align-self-start self-start bg-[#17142a] border border-[#2a2440] text-[#e8e3f8] rounded-bl-sm"
                } ${m.loading ? "animate-pulse italic opacity-75" : ""}`}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start"
                }}
              >
                {m.text.split("\n").map((line, lIdx) => (
                  <p key={lIdx} className={line.startsWith("•") || line.startsWith("-") ? "pl-2" : ""}>
                    {line}
                  </p>
                ))}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Preset Chips */}
          {messages.length <= 1 && (
            <div className="px-4 py-2 flex gap-1.5 overflow-x-auto whitespace-nowrap scrollbar-none border-t border-[#1a172c]">
              {[
                { label: "Analyse progress", text: "Please look at my logged history and stats. Give me feedback and progress summary!" },
                { label: "Hydration feedback", text: "Am I drinking enough water based on my log today? Provide a tip!" },
                { label: "Recommend routine", text: "Can you recommend a simple weekly goal structure based on my active exercises?" }
              ].map((chip, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setInput(chip.text);
                  }}
                  className="px-2.5 py-1 text-[10px] font-mono bg-[#17142a] border border-[#2a2440] rounded-full text-[#9991b8] hover:border-[#f0c972] hover:text-[#f0c972] transition-all cursor-pointer"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}

          {/* Input strip */}
          <div className="p-3 border-t border-[#221d35] flex gap-2 bg-[#13111f] items-center">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask your coach anything..."
              rows={1}
              className="flex-1 bg-[#17142a] border border-[#2a2440] rounded-lg p-2 text-xs font-mono text-[#e8e3f8] placeholder-[#3d3657] focus:outline-none focus:border-[#f0c972] max-h-16 resize-none"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="px-3.5 py-2 rounded-lg bg-gradient-to-r from-[#f0c972] to-[#e07b3f] text-[#0d0b14] font-mono text-xs font-bold shadow-md cursor-pointer transition-all hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
