import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { layoutCases } from "./cases.js";
import { DesignIntent } from "./design-intent.js";
import { DesignNotes } from "./design-notes.js";
import { LayoutInspector } from "./inspector.js";
import { Playground } from "./playground.js";
import "./styles.css";

const tabs = [
  {
    id: "design",
    label: "설계와 배경",
    description: "설계 의도 · 참고한 관점"
  },
  {
    id: "examples",
    label: "예시와 실험",
    description: import.meta.env.DEV
      ? "사례 비교 · Inspector · Axis Explorer"
      : "사례 비교 · Axis Explorer"
  }
] as const;
type DemoTab = (typeof tabs)[number]["id"];

function tabForHash(hash: string): DemoTab | undefined {
  if (
    [
      "#layout-cases",
      "#layout-inspector",
      "#playground-panel",
      "#playground",
      "#examples-panel"
    ].includes(hash)
  )
    return "examples";
  if (["", "#design-intent", "#references", "#design-panel"].includes(hash))
    return "design";
  return undefined;
}

function App() {
  const [activeTab, setActiveTab] = useState<DemoTab>(
    () => tabForHash(window.location.hash) ?? "design"
  );
  const [selected, setSelected] = useState("sizing");
  const [inspectionTarget, setInspectionTarget] = useState("case-sizing");
  const example = layoutCases.find((entry) => entry.id === selected)!;
  const Example = example.Component;
  const targets = [
    ...(selected === "diagnostics"
      ? []
      : [{ id: `case-${selected}`, label: example.label }]),
    { id: "playground", label: "Axis explorer · 자유 실험" }
  ];
  useEffect(() => {
    let frame = 0;
    function followHash() {
      const tab = tabForHash(window.location.hash);
      if (tab) setActiveTab(tab);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        document
          .getElementById(window.location.hash.slice(1))
          ?.scrollIntoView();
      });
    }
    followHash();
    window.addEventListener("hashchange", followHash);
    window.addEventListener("popstate", followHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", followHash);
      window.removeEventListener("popstate", followHash);
    };
  }, []);

  function activateTab(tab: DemoTab) {
    setActiveTab(tab);
    const hash = `#${tab}-panel`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  }

  function selectCase(id: string) {
    setActiveTab("examples");
    setSelected(id);
    setInspectionTarget(id === "diagnostics" ? "playground" : `case-${id}`);
  }
  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Layout 컴포넌트 / INTENT-FIRST LAYOUT</p>
          <h1>배치의 의도를 코드로.</h1>
          <p className="intro">
            설계의 배경을 읽고, 8가지 사례에서 직접 확인하세요.
            <br />
            문구·공간·방향을 바꾸며 선언과 실제 배치를 비교합니다.
          </p>
        </div>
        <span className="badge">Native CSS · React DOM</span>
      </header>
      <div className="demo-tabs" role="tablist" aria-label="데모 탐색">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-controls={`${tab.id}-panel`}
            aria-selected={activeTab === tab.id}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => activateTab(tab.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              activateTab(tabs[next].id);
              document.getElementById(`tab-${tabs[next].id}`)?.focus();
            }}
          >
            <strong>{tab.label}</strong>
            <span aria-hidden="true">{tab.description}</span>
          </button>
        ))}
      </div>
      <div
        id="design-panel"
        className="demo-tab-panel"
        role="tabpanel"
        aria-labelledby="tab-design"
        hidden={activeTab !== "design"}
      >
        <nav className="page-nav" aria-label="설계와 배경 탐색">
          <a href="#design-intent">설계 의도</a>
          <a href="#references">설계 참고 자료</a>
        </nav>
        <DesignIntent onSelectCase={selectCase} />
        <DesignNotes />
      </div>
      <div
        id="examples-panel"
        className="demo-tab-panel"
        role="tabpanel"
        aria-labelledby="tab-examples"
        hidden={activeTab !== "examples"}
      >
        <nav className="page-nav" aria-label="예시와 실험 탐색">
          <a href="#layout-cases">레이아웃 사례</a>
          {import.meta.env.DEV && (
            <a href="#layout-inspector">Layout Inspector</a>
          )}
          <a href="#playground-panel">Axis Explorer</a>
        </nav>
        <section
          id="layout-cases"
          className="panel case-gallery"
          aria-labelledby="case-title"
        >
          <nav className="case-nav" aria-label="레이아웃 사례 선택">
            {layoutCases.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={entry.id === selected}
                onClick={() => selectCase(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="case-heading">
            <p className="eyebrow">COMPARE THE SAME INTENT</p>
            <h2 id="case-title">{example.title}</h2>
            <p className="description">{example.summary}</p>
          </div>
          <div className="case-benefit">
            <strong>이 사례에서 줄어드는 판단</strong>
            <p>{example.benefit}</p>
          </div>
          <Example key={example.id} />
          <p className="case-source">
            설계에서 참고한 관점:{" "}
            <a href={example.source.url} target="_blank" rel="noreferrer">
              {example.source.title} ↗
            </a>
            {example.additionalSource && (
              <>
                {" · "}
                <a
                  href={example.additionalSource.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {example.additionalSource.title} ↗
                </a>
              </>
            )}
          </p>
        </section>
        {import.meta.env.DEV && (
          <LayoutInspector
            active={activeTab === "examples"}
            target={inspectionTarget}
            targets={targets}
            onTargetChange={setInspectionTarget}
          />
        )}
        <Playground
          onInspect={
            import.meta.env.DEV
              ? () => setInspectionTarget("playground")
              : undefined
          }
        />
      </div>
      <footer>
        모든 숫자는 CSS px입니다. Inspector는 개발 모드에서 브라우저 geometry와
        정규화된 경계 선언을 보여줍니다.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
