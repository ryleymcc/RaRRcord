import { useRef, useState, type PointerEvent } from "react";
import { diagnosticMetrics, webrtcInternalsUrl, type DiagnosticSample } from "./diagnostic-data";

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const smallNumber = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 });
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const format = (value: number, unit: string) =>
  (value > 0 && value < 0.01 ? smallNumber : number).format(value) + (unit === "%" ? "" : " ") + unit;

export function WebRtcInternals() {
  const [showHelp, setShowHelp] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const address = useRef<HTMLInputElement>(null);
  const url = webrtcInternalsUrl(navigator.userAgent);

  function openInternals() {
    setShowHelp(true);
    // Browsers can silently block this navigation, so keep the manual address available.
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  async function copyAddress() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("Address copied.");
    } catch {
      address.current?.focus();
      address.current?.select();
      setCopyStatus("Copy the selected address manually.");
    }
  }

  return <div className="rtc-internals">
    <button type="button" aria-controls="rtc-internals-help" onClick={openInternals}>
      Open WebRTC Internals
    </button>
    <div id="rtc-internals-help" hidden={!showHelp}>
      {url ? <>
        <p>If the page doesn’t open, paste this address into a new browser tab.</p>
        <div className="rtc-address">
          <input ref={address} aria-label="WebRTC Internals address" readOnly value={url} onFocus={event => event.currentTarget.select()} />
          <button type="button" onClick={copyAddress}>Copy address</button>
        </div>
        <span role="status">{copyStatus}</span>
      </> : <p>{/Safari\//.test(navigator.userAgent) && /Macintosh/.test(navigator.userAgent) && !/Mobile\//.test(navigator.userAgent)
        ? "In Safari, open Web Inspector and enable WebRTC Logging in its Console settings."
        : "Use the connection graphs below or your browser’s developer tools to inspect WebRTC."}</p>}
    </div>
  </div>;
}

function DiagnosticChart({ metric, samples }: { metric: (typeof diagnosticMetrics)[number]; samples: DiagnosticSample[] }) {
  const { key, label, unit } = metric;
  const [selectedAt, setSelectedAt] = useState<number>();
  const last = samples.at(-1);
  const current = last?.values[key];
  const end = last?.at ?? 0;
  const span = Math.max(1000, end - (samples[0]?.at ?? end));
  const start = end - span;
  const x = (at: number) => 2 + (at - start) / span * 236;
  const max = Math.max(1, ...samples.map(sample => sample.values[key]?.value ?? 0));
  const scale = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / scale) * scale;
  const y = (value: number) => 70 - value / top * 66;
  const selected = samples.findIndex(sample => sample.at === selectedAt);
  const picked = samples[selected];
  const reading = picked?.values[key];
  const points = samples.map((sample, i) => {
    const value = sample.values[key];
    if (!value) return "";
    const previous = samples[i - 1]?.values[key];
    return (previous?.source === value.source ? "L" : "M") + x(sample.at) + " " + y(value.value);
  }).join(" ");

  function pickSample(event: PointerEvent<SVGSVGElement>) {
    if (!samples.length) return;
    const plot = event.currentTarget.getBoundingClientRect();
    const pointer = (event.clientX - plot.left) / plot.width * 240;
    const nearest = samples.reduce((closest, sample) =>
      Math.abs(x(sample.at) - pointer) < Math.abs(x(closest.at) - pointer) ? sample : closest);
    setSelectedAt(nearest.at);
  }

  return <div className="diagnostic-chart">
    <div className="chart-heading">
      <span id={key + "-chart-title"}>{label}</span>
      <strong>{current ? format(current.value, unit) : "Unavailable"}</strong>
    </div>
    {points.trim() && <div className="chart-axes" role="group" aria-labelledby={key + "-chart-title"} aria-describedby={key + "-chart-sample"}
      tabIndex={0}
      onBlur={() => setSelectedAt(undefined)}
      onKeyDown={event => {
        if (event.key === "Escape") {
          setSelectedAt(undefined);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const index = selected === -1 ? samples.length - 1 : selected + (event.key === "ArrowLeft" ? -1 : 1);
          setSelectedAt(samples[Math.max(0, Math.min(samples.length - 1, index))]?.at);
        }
      }}>
      <span className="chart-unit">{unit}</span>
      <div className="chart-ticks" aria-hidden="true">
        <span>{number.format(top)}</span>
        <span>{number.format(top / 2)}</span>
        <span>0</span>
      </div>
      <svg viewBox="0 0 240 74" preserveAspectRatio="none" aria-hidden="true" className="chart-plot"
        onPointerMove={event => { if (event.pointerType === "mouse") pickSample(event); }}
        onPointerUp={pickSample}
        onPointerLeave={event => { if (event.pointerType === "mouse") setSelectedAt(undefined); }}>
        <path className="chart-grid" d="M2 4H238 M2 37H238 M2 4V70H238" />
        <path className="chart-line" d={points} />
        {samples.map((sample, i) => {
          const value = sample.values[key];
          if (!value || (samples[i - 1]?.values[key]?.source === value.source && i !== selected)) return null;
          return <circle className="chart-point" key={sample.at} cx={x(sample.at)} cy={y(value.value)} r="2" />;
        })}
        {picked && <path className="chart-cursor" d={`M${x(picked.at)} 4V70`} />}
      </svg>
      <div className="chart-time" aria-hidden="true">
        <span>−{number.format(span / 1000)} s</span>
        <span>Time</span>
        <span>0 s</span>
      </div>
    </div>}
    <p className="chart-sample" id={key + "-chart-sample"} aria-live="polite">
      {picked ? `${time.format(picked.at)} · ${reading ? format(reading.value, unit) : "Unavailable"}` : current?.label ?? "Waiting for data"}
      {reading && <small>{reading.label}</small>}
    </p>
  </div>;
}

export function DiagnosticCharts({ samples }: { samples: DiagnosticSample[] }) {
  return <div className="graphs">
    {diagnosticMetrics.map(metric => <DiagnosticChart key={metric.key} metric={metric} samples={samples} />)}
  </div>;
}
