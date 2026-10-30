import { useState } from "react";
import { Item, Stack } from "@mincho-js/react/layout";
import type {
  Axis,
  Justify,
  PositionAlignment
} from "@mincho-js/css/layout/core";

export function Playground({ onInspect }: { onInspect?: () => void }) {
  const [axis, setAxis] = useState<Axis>("horizontal");
  const [width, setWidth] = useState(600);
  const [gap, setGap] = useState(16);
  const [justify, setJustify] = useState<Justify>("start");
  const [align, setAlign] = useState<PositionAlignment>("center");
  const [wrap, setWrap] = useState(false);
  const [rtl, setRtl] = useState(false);

  return (
    <section
      id="playground-panel"
      className="panel playground-panel"
      aria-labelledby="playground-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">ADVANCED / AXIS EXPLORER</p>
          <h2 id="playground-title">Stack playground</h2>
        </div>
        {onInspect && (
          <button
            type="button"
            onClick={() => {
              onInspect();
              document.getElementById("layout-inspector")?.scrollIntoView({
                behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                  .matches
                  ? "auto"
                  : "smooth"
              });
            }}
          >
            Layout Inspector 보기
          </button>
        )}
      </div>
      <div className="controls">
        <label>
          방향
          <select
            aria-label="방향"
            value={axis}
            onChange={(event) => setAxis(event.target.value as Axis)}
          >
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>
        <label>
          Justify
          <select
            aria-label="Justify"
            value={justify}
            onChange={(event) => setJustify(event.target.value as Justify)}
          >
            {["start", "center", "end", "between", "around", "evenly"].map(
              (value) => (
                <option key={value}>{value}</option>
              )
            )}
          </select>
        </label>
        <label>
          Align
          <select
            aria-label="Align"
            value={align}
            onChange={(event) =>
              setAlign(event.target.value as PositionAlignment)
            }
          >
            {["start", "center", "end"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          폭 <output>{width}px</output>
          <input
            aria-label="컨테이너 폭"
            type="range"
            min={240}
            max={720}
            step={8}
            value={width}
            onChange={(event) => setWidth(event.target.valueAsNumber)}
          />
        </label>
        <label>
          간격 <output>{gap}px</output>
          <input
            aria-label="아이템 간격"
            type="range"
            min={0}
            max={40}
            step={4}
            value={gap}
            onChange={(event) => setGap(event.target.valueAsNumber)}
          />
        </label>
        <div className="toggles">
          <label>
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />{" "}
            Wrap
          </label>
          <label>
            <input
              type="checkbox"
              checked={rtl}
              onChange={(event) => setRtl(event.target.checked)}
            />{" "}
            RTL
          </label>
        </div>
      </div>
      <div className="canvas">
        <Stack
          id="playground"
          axis={axis}
          direction={rtl ? "rtl" : "ltr"}
          width={width}
          height={axis === "vertical" ? 320 : 200}
          gap={gap}
          padding={16}
          justify={justify}
          align={align}
          wrap={wrap}
          {...(wrap ? { lineGap: 12 } : {})}
          className="stage"
          debugLayout
        >
          {["A", "B", "C", "D"].map((label, index) => (
            <Item
              key={label}
              width={104}
              height={index % 2 === 0 ? 64 : 80}
              padding={16}
              className={`tile tile-${index}`}
            >
              <strong>{label}</strong>
              <span>104 × {index % 2 === 0 ? 64 : 80}</span>
            </Item>
          ))}
        </Stack>
      </div>
      <pre className="code">
        <code>{`<Stack axis="${axis}" width={${width}} height={${axis === "vertical" ? 320 : 200}}
  gap={${gap}} padding={16} justify="${justify}" align="${align}"${wrap ? " wrap lineGap={12}" : ""}${rtl ? ' direction="rtl"' : ""}>
  <Item width={104} height={64}>A</Item>
  …
</Stack>`}</code>
      </pre>
    </section>
  );
}
