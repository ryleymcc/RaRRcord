import type { Metrics } from "./rtc";

export const diagnosticMetrics = [
  { key: "bitrate", label: "Bitrate", unit: "kbps" },
  { key: "rtt", label: "Round trip", unit: "ms" },
  { key: "loss", label: "Packet loss", unit: "%" },
  { key: "fps", label: "Frame rate", unit: "fps" },
] as const;

export type MetricKey = (typeof diagnosticMetrics)[number]["key"];
type Reading = { value: number; source: string; label: string };
export type DiagnosticSample = { at: number; values: Partial<Record<MetricKey, Reading>> };

export function diagnosticSample(at: number, records: Metrics[]): DiagnosticSample {
  const media = records.find(record => record.fps !== undefined) ?? records[0];
  const values: DiagnosticSample["values"] = {};
  for (const { key } of diagnosticMetrics) {
    const record = Number.isFinite(media?.[key]) ? media : records.find(row => Number.isFinite(row[key]));
    const value = record?.[key];
    if (!record || value === undefined) continue;
    values[key] = {
      value,
      source: JSON.stringify([record.peer, key === "rtt" ? null : record.stream]),
      label: key === "rtt" ? record.name : record.name + " · " + record.direction,
    };
  }
  return { at, values };
}

export function webrtcInternalsUrl(userAgent: string): string | undefined {
  if (/iPhone|iPad|iPod|Macintosh.*Mobile\//i.test(userAgent)) return;
  if (/\bEdg(?:A)?\//i.test(userAgent)) return "edge://webrtc-internals/";
  if (/\bFirefox\//i.test(userAgent)) return "about:webrtc";
  if (/\b(?:Chrome|Chromium)\//i.test(userAgent)) return "chrome://webrtc-internals/";
}
