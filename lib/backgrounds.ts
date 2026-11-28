// Server background gradients. The API accepts only these names ("preset:<name>"), and the app
// draws them with this CSS, so both always agree.
export const backgroundGradients = {
  aurora: "linear-gradient(135deg,#1d4350,#2b5876 45%,#4e4376)",
  sunset: "linear-gradient(135deg,#ff7e5f,#c0465b 55%,#4a2545)",
  ocean: "linear-gradient(160deg,#0f2b46,#1565c0 55%,#26a6b8)",
  forest: "linear-gradient(160deg,#0b3d2e,#1e5631 50%,#4c7a2a)",
  dusk: "linear-gradient(160deg,#2c3e50,#4a2c5e 55%,#b0565a)",
  ember: "linear-gradient(160deg,#200122,#6f0000)",
} as const;
export type BackgroundGradient = keyof typeof backgroundGradients;
export const backgroundPresets = Object.keys(backgroundGradients) as BackgroundGradient[];
