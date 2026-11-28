// Original synthesized cues for voice rooms: a soft two-note rise when someone
// joins and the same notes falling when someone leaves. Generated with Web Audio,
// so there are no sound files to ship.
export type VoiceCue = "join" | "leave";

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

let context: SinkContext | null = null;

function audio(output: string) {
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext() as SinkContext;
  if (context.state === "suspended") void context.resume().catch(() => {});
  if (context.setSinkId && (context.sinkId ?? "") !== output) void context.setSinkId(output).catch(() => {});
  return context;
}

// Each note glides slightly upward into its pitch, which gives the rounded "bloop" feel.
function note(ctx: AudioContext, destination: AudioNode, frequency: number, start: number, length: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(1, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  gain.connect(destination);
  for (const [type, multiple, level] of [["sine", 1, 1], ["triangle", 2, 0.12]] as const) {
    const osc = ctx.createOscillator();
    const voice = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency * multiple * 0.94, start);
    osc.frequency.exponentialRampToValueAtTime(frequency * multiple, start + 0.035);
    voice.gain.value = level;
    osc.connect(voice).connect(gain);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }
}

// A line you choose to hear out loud when a particular person joins your voice room.
export type JoinAnnouncement = { user: string; text: string };

// Trims each row, drops blank ones and keeps at most 20 lines of up to 100 characters.
export function cleanAnnouncements(list: JoinAnnouncement[] | undefined): JoinAnnouncement[] {
  return (Array.isArray(list) ? list : [])
    .map(row => ({ user: String(row?.user ?? "").trim().replace(/^@+/, "").slice(0, 40), text: String(row?.text ?? "").trim().slice(0, 100) }))
    .filter(row => row.user && row.text)
    .slice(0, 20);
}

// The line for this username, ignoring case and a leading @, or "" when there isn't one.
export function joinAnnouncement(list: JoinAnnouncement[] | undefined, username: string): string {
  const wanted = String(username ?? "").trim().replace(/^@+/, "").toLowerCase();
  if (!wanted) return "";
  return cleanAnnouncements(list).find(row => row.user.toLowerCase() === wanted)?.text ?? "";
}

// Uses the browser's built-in speech, so there are no sound files. Only this device hears it.
export function speakAnnouncement(text: string) {
  if (typeof speechSynthesis === "undefined" || typeof SpeechSynthesisUtterance === "undefined") return;
  const line = text.trim().slice(0, 100);
  if (!line) return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(line));
}

export function playVoiceCue(cue: VoiceCue, output = "", volume = 0.22) {
  const ctx = audio(output);
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  const notes = cue === "join" ? [587.33, 880] : [880, 587.33];
  const start = ctx.currentTime + 0.01;
  notes.forEach((frequency, i) => note(ctx, master, frequency, start + i * 0.085, 0.2));
  setTimeout(() => master.disconnect(), 600);
}
