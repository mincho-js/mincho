import { useEffect, useState } from "react";
import { inspectLayout } from "@mincho-js/react/layout";
import type { NormalizedSpace } from "@mincho-js/css/layout/core";

type NativeSnapshot = ReturnType<typeof inspectLayout>;
type Snapshot = Omit<NativeSnapshot, "items"> & {
  items: Array<
    Omit<NativeSnapshot["items"][number], "element"> & {
      label: string;
      tag: string;
    }
  >;
};

const round = (value: number) => Math.round(value * 100) / 100;
const colors = ["#cbe2ad", "#d9e7c9", "#d6e3e0", "#ece3c7"];
function describeSpace(space: NormalizedSpace) {
  return space.kind === "fixed"
    ? `${space.value}px`
    : `stretch · weight ${space.weight} · min ${space.min}px · max ${Number.isFinite(space.max) ? `${space.max}px` : "제한 없음"}`;
}

export function LayoutInspector({
  active = true,
  target,
  targets,
  onTargetChange
}: {
  active?: boolean;
  target: string;
  targets: readonly { id: string; label: string }[];
  onTargetChange: (target: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    const root = document.getElementById(target);
    if (!root) return;
    let frame = 0;
    function read() {
      frame = 0;
      if (root!.dataset.minchoLayoutState !== "valid") {
        setSnapshot(null);
        setError("아직 검증된 배치가 없습니다.");
        return;
      }
      try {
        const result = inspectLayout(root!);
        setSnapshot({
          ...result,
          items: result.items.map(({ element, ...item }) => ({
            ...item,
            label: (
              element.querySelector("strong")?.textContent ??
              element.textContent ??
              "Item"
            ).trim(),
            tag: element.tagName.toLowerCase()
          }))
        });
        setError("");
      } catch (failure) {
        setSnapshot(null);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(read);
    }
    const mutations = new MutationObserver(schedule);
    mutations.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "style",
        "class",
        "hidden",
        "dir",
        "data-mincho-layout-state"
      ]
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [active, target]);

  const items =
    snapshot?.items.map((item) => ({
      ...item,
      x: item.rect.x - snapshot.container.x,
      y: item.rect.y - snapshot.container.y
    })) ?? [];
  const left = Math.min(0, ...items.map((item) => item.x));
  const top = Math.min(0, ...items.map((item) => item.y));
  const right = Math.max(
    snapshot?.container.width ?? 1,
    ...items.map((item) => item.x + item.rect.width)
  );
  const bottom = Math.max(
    snapshot?.container.height ?? 1,
    ...items.map((item) => item.y + item.rect.height)
  );

  return (
    <section
      id="layout-inspector"
      className="panel layout-inspector"
      aria-labelledby="inspector-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">INSPECT / BROWSER GEOMETRY</p>
          <h2 id="inspector-title">Layout Inspector</h2>
        </div>
        <label className="inspector-target">
          검사 대상
          <select
            aria-label="검사 대상"
            value={target}
            onChange={(event) => {
              onTargetChange(event.target.value);
              setSnapshot(null);
            }}
          >
            {targets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="description">
        설정과 DOM 변경 시 자동 갱신됩니다. 좌표는 컨테이너 border box의 왼쪽 위
        기준 CSS px입니다.
      </p>
      {error && (
        <p role="alert" className="inspector-error">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          <dl className="inspector-stats">
            <div>
              <dt>계산 출처</dt>
              <dd>Native CSS / Browser</dd>
            </div>
            <div>
              <dt>컨테이너 크기</dt>
              <dd>
                {round(snapshot.container.width)} ×{" "}
                {round(snapshot.container.height)} px
              </dd>
            </div>
            <div>
              <dt>축 / 방향</dt>
              <dd>
                {snapshot.computedStyle["flex-direction"]} /{" "}
                {snapshot.computedStyle.direction}
              </dd>
            </div>
            <div>
              <dt>간격 / 줄바꿈</dt>
              <dd>
                {snapshot.computedStyle.gap} /{" "}
                {snapshot.computedStyle["flex-wrap"]}
              </dd>
            </div>
          </dl>
          <div className="geometry-map">
            <svg
              role="img"
              aria-label="컨테이너와 Item의 실제 배치 도식"
              viewBox={`${left - 8} ${top - 8} ${right - left + 16} ${bottom - top + 16}`}
            >
              <rect
                x={0}
                y={0}
                width={snapshot.container.width}
                height={snapshot.container.height}
                fill="#f8faf6"
                stroke="#91a787"
                strokeDasharray="4 4"
              />
              {items.map((item, index) => (
                <g key={index}>
                  <rect
                    x={item.x}
                    y={item.y}
                    width={item.rect.width}
                    height={item.rect.height}
                    rx={4}
                    fill={colors[index % colors.length]}
                    stroke="#62805b"
                  />
                  <text
                    x={item.x + item.rect.width / 2}
                    y={item.y + item.rect.height / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={12}
                    fill="#274b33"
                  >
                    {item.label.slice(0, 16)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="inspector-table">
            <table>
              <caption>실제 DOM Item</caption>
              <thead>
                <tr>
                  <th scope="col">Item / DOM</th>
                  <th scope="col">x / y</th>
                  <th scope="col">width / height</th>
                  <th scope="col">grow / shrink</th>
                  <th scope="col">min / max</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={index}>
                    <th scope="row">
                      {index}: {item.label} <small>〈{item.tag}〉</small>
                    </th>
                    <td>
                      {round(item.x)} / {round(item.y)}
                    </td>
                    <td>
                      {round(item.rect.width)} / {round(item.rect.height)}
                    </td>
                    <td>
                      {item.computedStyle["flex-grow"]} /{" "}
                      {item.computedStyle["flex-shrink"]}
                    </td>
                    <td>
                      <span>
                        w: {item.computedStyle["min-width"]} /{" "}
                        {item.computedStyle["max-width"]}
                      </span>
                      <br />
                      h: {item.computedStyle["min-height"]} /{" "}
                      {item.computedStyle["max-height"]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inspector-table">
            <table>
              <caption>
                정규화된 경계 선언 · 실제 사용 크기는 위 도식과 Item 좌표에서
                확인
              </caption>
              <thead>
                <tr>
                  <th scope="col">경계</th>
                  <th scope="col">작성 위치</th>
                  <th scope="col">공간 제약</th>
                  <th scope="col">Break</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.boundaries.map((boundary) => (
                  <tr key={`${boundary.previousId}-${boundary.nextId}`}>
                    <th scope="row">
                      {boundary.previousId} → {boundary.nextId}
                    </th>
                    <td>{boundary.declaredBy}</td>
                    <td>{describeSpace(boundary.space)}</td>
                    <td>{boundary.breakPolicy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {snapshot.edges.length > 0 && (
              <p>
                Edge space:{" "}
                {JSON.stringify(snapshot.edges, (_, value) =>
                  value === Infinity ? "unbounded" : value
                )}
              </p>
            )}
          </div>
          <details className="inspector">
            <summary>전체 스냅샷과 computed CSS 보기</summary>
            <pre>
              {JSON.stringify(
                snapshot,
                (_, value) => (value === Infinity ? "unbounded" : value),
                2
              )}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
