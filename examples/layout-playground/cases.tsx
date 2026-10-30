import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Box, HStack, Item, VStack } from "@mincho-js/react/layout";
import {
  LayoutError,
  nativeItems,
  normalizeBox,
  normalizeStack
} from "@mincho-js/css/layout/core";
import type { Size } from "@mincho-js/css/layout/core";

export const references = {
  launch: {
    title: "Figma · Auto Layout의 시작",
    url: "https://www.figma.com/blog/announcing-auto-layout/"
  },
  sizing: {
    title: "Figma · 새 Auto Layout의 설계",
    url: "https://www.figma.com/blog/behind-the-feature-the-making-of-the-new-auto-layout/"
  },
  space: {
    title: "Subform · Why Not Flexbox?",
    url: "https://subformapp.com/articles/why-not-flexbox/"
  },
  subformLearn: {
    title: "Subform · 부모·자식, Stack과 HUD",
    url: "https://subformapp.com/learn/"
  },
  elm: {
    title: "elm-ui · row, column, fill, shrink",
    url: "https://package.elm-lang.org/packages/mdgriffith/elm-ui/latest/Element"
  },
  reshaped: {
    title: "Reshaped · View / View.Item",
    url: "https://www.reshaped.so/docs/utilities/view"
  }
};

// An independent CSS implementation for comparison; never call the layout mapper here.
const row: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  width: "fit-content",
  height: "fit-content"
};
const column: CSSProperties = { ...row, flexDirection: "column" };
const fixed: CSSProperties = { flex: "0 0 auto" };

function Range({
  label,
  value,
  set,
  min,
  max,
  step = 8
}: {
  label: string;
  value: number;
  set: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className="range-control">
      {label} <output>{value}px</output>
      <input
        aria-label={label}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => set(event.target.valueAsNumber)}
      />
    </label>
  );
}

function Compare({
  id,
  controls,
  layout,
  flex,
  layoutCode,
  flexCode,
  note
}: {
  id: string;
  controls: ReactNode;
  layout: ReactNode;
  flex: ReactNode;
  layoutCode: string;
  flexCode: string;
  note?: string;
}) {
  return (
    <>
      <div className="case-controls">{controls}</div>
      <div className="comparison" data-comparison={id}>
        <section
          className="comparison-side"
          aria-label="Layout 컴포넌트 미리보기"
        >
          <h3>
            <span className="implementation-dot" />
            Layout 컴포넌트
          </h3>
          <div className="canvas">{layout}</div>
          <details className="source-code" open>
            <summary>Layout 컴포넌트 코드</summary>
            <pre>
              <code>{layoutCode}</code>
            </pre>
          </details>
        </section>
        <section className="comparison-side" aria-label="Flexbox 미리보기">
          <h3>
            <span className="implementation-dot css-dot" />
            직접 작성한 Flexbox
          </h3>
          <div className="canvas">{flex}</div>
          <details className="source-code" open>
            <summary>대응하는 CSS</summary>
            <pre>
              <code>{flexCode}</code>
            </pre>
          </details>
        </section>
      </div>
      <p className="comparison-note">
        같은 입력과 콘텐츠를 사용합니다. 아래 CSS는 공통 박스 초기화와 장식 CSS
        위에 적용하는 배치 규칙입니다.{note && ` ${note}`}
      </p>
    </>
  );
}

function SizingCase() {
  const [mode, setMode] = useState("hug-contents");
  const [heightMode, setHeightMode] = useState("hug-contents");
  const [label, setLabel] = useState("변경 사항 저장");
  const [available, setAvailable] = useState(360);
  const width: Size = mode === "fixed" ? 240 : (mode as Size);
  const height: Size = heightMode === "fixed" ? 96 : (heightMode as Size);
  const style: CSSProperties = {
    ...row,
    gap: 8,
    padding: 12,
    alignItems: "center",
    justifyContent: "flex-start",
    width: mode === "fixed" ? 240 : mode === "stretch" ? "100%" : "fit-content",
    height:
      heightMode === "fixed"
        ? 96
        : heightMode === "stretch"
          ? "100%"
          : "fit-content"
  };
  return (
    <Compare
      id="sizing"
      controls={
        <>
          <label>
            Width
            <select
              aria-label="크기 Width 모드"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="hug-contents">Hug contents</option>
              <option value="stretch">Stretch</option>
              <option value="fixed">Fixed · 240px</option>
            </select>
          </label>
          <label>
            Height
            <select
              aria-label="크기 Height 모드"
              value={heightMode}
              onChange={(event) => setHeightMode(event.target.value)}
            >
              <option value="hug-contents">Hug contents</option>
              <option value="stretch">Stretch</option>
              <option value="fixed">Fixed · 96px</option>
            </select>
          </label>
          <label>
            버튼 문구
            <input
              aria-label="버튼 문구"
              value={label}
              maxLength={32}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <Range
            label="부모 영역 폭"
            value={available}
            set={setAvailable}
            min={256}
            max={440}
          />
        </>
      }
      layout={
        <Box width={available} height={144} className="available-area">
          <HStack
            id="case-sizing"
            width={width}
            height={height}
            gap={8}
            padding={12}
            align="center"
            className="stage"
          >
            <Item
              as="button"
              type="button"
              className="primary"
              padding={{ horizontal: 12, vertical: 8 }}
            >
              {label || "저장"}
            </Item>
            <span className="shortcut">⌘ S</span>
          </HStack>
        </Box>
      }
      flex={
        <div
          className="available-area css-box"
          style={{ width: available, height: 144 }}
        >
          <div id="flex-sizing" className="css-box stage" style={style}>
            <button
              type="button"
              className="css-box primary"
              style={{ ...fixed, width: "max-content", padding: "8px 12px" }}
            >
              {label || "저장"}
            </button>
            <span className="shortcut">⌘ S</span>
          </div>
        </div>
      }
      layoutCode={`<Box width={${available}} height={144}>\n  <HStack width=${typeof width === "number" ? `{${width}}` : JSON.stringify(width)}\n    height=${typeof height === "number" ? `{${height}}` : JSON.stringify(height)}\n    gap={8} padding={12} align="center">\n    <Item as="button"\n      padding={{ horizontal: 12, vertical: 8 }}>\n      ${label || "저장"}\n    </Item>\n    <span>⌘ S</span>\n  </HStack>\n</Box>`}
      flexCode={`.parent { width: ${available}px; height: 144px; }\n.row {\n  display: flex; flex-direction: row;\n  width: ${typeof style.width === "number" ? `${style.width}px` : style.width};\n  height: ${typeof style.height === "number" ? `${style.height}px` : style.height};\n  gap: 8px; padding: 12px;\n  align-items: center; justify-content: flex-start;\n}\n.row > button {\n  width: max-content; flex: 0 0 auto;\n  padding: 8px 12px;\n}`}
      note="Box는 일반 block flow를 유지합니다. 바깥 영역의 폭과 높이를 확정해 stretch의 기준을 제공합니다."
    />
  );
}

function CardCase() {
  const [long, setLong] = useState(false);
  const [width, setWidth] = useState(320);
  const description = long
    ? "콘텐츠가 길어지면 설명의 줄 수가 늘고 카드의 높이도 함께 늘어납니다. 제목, 설명, 액션 그룹은 의미 있는 구조로 유지합니다."
    : "작은 규칙을 조합해 읽기 쉬운 인터페이스를 만듭니다.";
  const actions = (
    <>
      <button type="button">미리보기</button>
      <button type="button" className="primary">
        게시
      </button>
    </>
  );
  return (
    <Compare
      id="card"
      controls={
        <>
          <Range
            label="카드 폭"
            value={width}
            set={setWidth}
            min={256}
            max={440}
          />
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={long}
              onChange={(event) => setLong(event.target.checked)}
            />
            설명 늘리기
          </label>
        </>
      }
      layout={
        <VStack
          as="article"
          id="case-card"
          width={width}
          gap={12}
          padding={20}
          className="demo-card"
        >
          <Box width="stretch" height={72} className="card-art">
            M / Layout study
          </Box>
          <h3 className="card-title">콘텐츠를 따라 자라는 카드</h3>
          <Box width="stretch" className="card-copy">
            {description}
          </Box>
          <HStack width="stretch" gap={8} justify="end">
            {actions}
          </HStack>
        </VStack>
      }
      flex={
        <article
          id="flex-card"
          className="css-box demo-card"
          style={{ ...column, width, gap: 12, padding: 20 }}
        >
          <div
            className="css-box card-art"
            style={{
              ...fixed,
              alignSelf: "stretch",
              width: "auto",
              height: 72
            }}
          >
            M / Layout study
          </div>
          <h3 className="card-title">콘텐츠를 따라 자라는 카드</h3>
          <div
            className="css-box card-copy"
            style={{
              ...fixed,
              alignSelf: "stretch",
              width: "auto",
              height: "max-content"
            }}
          >
            {description}
          </div>
          <div
            className="css-box"
            style={{
              ...row,
              ...fixed,
              alignSelf: "stretch",
              width: "auto",
              height: "max-content",
              gap: 8,
              justifyContent: "safe flex-end"
            }}
          >
            {actions}
          </div>
        </article>
      }
      layoutCode={`<VStack as="article" width={${width}}\n  gap={12} padding={20}>\n  <Box width="stretch" height={72} />\n  <h3>콘텐츠를 따라 자라는 카드</h3>\n  <Box width="stretch">\n    {description}\n  </Box>\n  <HStack width="stretch" gap={8}\n    justify="end">\n    <button>미리보기</button><button>게시</button>\n  </HStack>\n</VStack>`}
      flexCode={`.card {\n  display: flex; flex-direction: column;\n  width: ${width}px; height: fit-content;\n  align-items: flex-start; gap: 12px; padding: 20px;\n}\n.art, .copy, .actions {\n  width: auto; align-self: stretch; flex: 0 0 auto;\n}\n.art { height: 72px; }\n.copy, .actions { height: max-content; }\n.actions {\n  display: flex; flex-direction: row;\n  gap: 8px; justify-content: safe flex-end;\n}`}
      note="자식 HStack은 shrink를 선언하지 않았으므로 부모 VStack의 세로축에서 높이를 양보하지 않습니다."
    />
  );
}

function RelationsCase() {
  const [width, setWidth] = useState(420);
  const [rtl, setRtl] = useState(false);
  return (
    <Compare
      id="relations"
      controls={
        <>
          <Range
            label="관계 컨테이너 폭"
            value={width}
            set={setWidth}
            min={280}
            max={600}
          />
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={rtl}
              onChange={(event) => setRtl(event.target.checked)}
            />
            관계 RTL
          </label>
        </>
      }
      layout={
        <HStack
          id="case-relations"
          width={width}
          direction={rtl ? "rtl" : "ltr"}
          className="stage"
        >
          {["A", "B", "C", "D"].map((label, index) => (
            <Item
              key={label}
              width={64}
              height={56}
              padding={12}
              gapAfter={
                index === 0 || index === 2
                  ? "stretch"
                  : index === 1
                    ? 20
                    : undefined
              }
              className={`tile tile-${index}`}
            >
              <strong>{label}</strong>
            </Item>
          ))}
        </HStack>
      }
      flex={
        <div
          id="flex-relations"
          className="css-box stage"
          style={{ ...row, width, direction: rtl ? "rtl" : "ltr" }}
        >
          {["A", "B", "C", "D"].map((label, index) => (
            <div
              key={label}
              className={`css-box tile tile-${index}`}
              style={{
                ...fixed,
                width: 64,
                height: 56,
                padding: 12,
                marginInlineEnd:
                  index === 0 || index === 2 ? "auto" : index === 1 ? 20 : 0
              }}
            >
              <strong>{label}</strong>
            </div>
          ))}
        </div>
      }
      layoutCode={`<HStack width={${width}} direction="${rtl ? "rtl" : "ltr"}">\n  <Item width={64} gapAfter="stretch">A</Item>\n  <Item width={64} gapAfter={20}>B</Item>\n  <Item width={64} gapAfter="stretch">C</Item>\n  <Item width={64}>D</Item>\n</HStack>\n// 각 Item: height={56}, padding={12}`}
      flexCode={`.row { display: flex; width: ${width}px; direction: ${rtl ? "rtl" : "ltr"}; }\n.row > div {\n  width: 64px; height: 56px; padding: 12px;\n  flex: 0 0 auto;\n}\n.row > :nth-child(1), .row > :nth-child(3) {\n  margin-inline-end: auto;\n}\n.row > :nth-child(2) { margin-inline-end: 20px; }`}
      note="이 조합은 CSS auto margin으로도 동일하게 구현됩니다. 명시적 간격과 justify=between을 섞으면 Layout 컴포넌트가 충돌을 진단합니다."
    />
  );
}

function ConditionalCase() {
  const [first, setFirst] = useState(true);
  const [rtl, setRtl] = useState(false);
  const names = first ? ["A", "B", "C"] : ["B", "C"];
  return (
    <Compare
      id="conditional"
      controls={
        <>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={first}
              onChange={(event) => setFirst(event.target.checked)}
            />
            첫 Item 표시
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={rtl}
              onChange={(event) => setRtl(event.target.checked)}
            />
            조건부 RTL
          </label>
        </>
      }
      layout={
        <HStack
          id="case-conditional"
          width={360}
          gap={12}
          direction={rtl ? "rtl" : "ltr"}
          className="stage"
        >
          {names.map((label) => (
            <Item
              key={label}
              width={64}
              height={56}
              padding={12}
              gapBefore={label === "B" ? 20 : undefined}
              className={`tile tile-${label.charCodeAt(0) - 65}`}
            >
              <strong>{label}</strong>
            </Item>
          ))}
        </HStack>
      }
      flex={
        <div
          id="flex-conditional"
          className="css-box stage"
          style={{
            ...row,
            width: 360,
            gap: 12,
            direction: rtl ? "rtl" : "ltr"
          }}
        >
          {names.map((label) => (
            <div
              key={label}
              className={`css-box tile tile-${label.charCodeAt(0) - 65}`}
              style={{
                ...fixed,
                width: 64,
                height: 56,
                padding: 12,
                marginInlineStart: label === "B" ? (first ? 8 : 20) : 0
              }}
            >
              <strong>{label}</strong>
            </div>
          ))}
        </div>
      }
      layoutCode={`<HStack width={360} gap={12}\n  direction="${rtl ? "rtl" : "ltr"}">\n  {showFirst && <Item width={64}>A</Item>}\n  <Item width={64} gapBefore={20}>B</Item>\n  <Item width={64}>C</Item>\n</HStack>\n// 각 Item: height={56}, padding={12}`}
      flexCode={`.row {\n  display: flex; width: 360px; gap: 12px;\n  direction: ${rtl ? "rtl" : "ltr"};\n}\n.item { width: 64px; height: 56px; padding: 12px; flex: 0 0 auto; }\n.b { margin-inline-start: calc(20px - 12px); }\n.b:first-child { margin-inline-start: 20px; }\n// JSX에서는 showFirst에 따라 같은 값을 선택합니다.`}
      note="A가 사라지면 B의 gapBefore는 컨테이너 시작 edge 공간이 됩니다. React renderer는 실제 DOM 인접성을 다시 확인합니다."
    />
  );
}

function WeightedCase() {
  const [width, setWidth] = useState(400);
  const [weight, setWeight] = useState(2);
  const [bounded, setBounded] = useState(false);
  const content = (index: number) => (
    <div className="tile-content">
      <strong>{index ? "Aside" : "Main"}</strong>
      <span>weight {index ? 1 : weight}</span>
    </div>
  );
  return (
    <Compare
      id="weighted"
      controls={
        <>
          <Range
            label="배분 컨테이너 폭"
            value={width}
            set={setWidth}
            min={280}
            max={600}
          />
          <label>
            Main weight
            <select
              aria-label="Main weight"
              value={weight}
              onChange={(event) => setWeight(Number(event.target.value))}
            >
              {[1, 2, 3].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="inline-toggle">
            <input
              type="checkbox"
              checked={bounded}
              onChange={(event) => setBounded(event.target.checked)}
            />
            Min / Max 적용
          </label>
        </>
      }
      layout={
        <HStack
          id="case-weighted"
          width={width}
          gap={12}
          justify="center"
          className="stage"
        >
          <Item
            width={{ mode: "stretch", weight }}
            minWidth={bounded ? 120 : 0}
            maxWidth={bounded ? 300 : undefined}
            height={88}
            className="tile tile-0"
          >
            {content(0)}
          </Item>
          <Item
            width="stretch"
            minWidth={bounded ? 80 : 0}
            maxWidth={bounded ? 180 : undefined}
            height={88}
            className="tile tile-1"
          >
            {content(1)}
          </Item>
        </HStack>
      }
      flex={
        <div
          id="flex-weighted"
          className="css-box stage"
          style={{ ...row, width, gap: 12, justifyContent: "safe center" }}
        >
          {[0, 1].map((index) => (
            <div
              key={index}
              className={`css-box tile tile-${index}`}
              style={{
                width: 0,
                height: 88,
                flexBasis: 0,
                flexGrow: index ? 1 : weight,
                flexShrink: 0,
                minWidth: bounded ? (index ? 80 : 120) : 0,
                maxWidth: bounded ? (index ? 180 : 300) : "none"
              }}
            >
              {content(index)}
            </div>
          ))}
        </div>
      }
      layoutCode={`<HStack width={${width}} gap={12} justify="center">\n  <Item width={{ mode: "stretch", weight: ${weight} }}\n    ${bounded ? "minWidth={120} maxWidth={300}" : "minWidth={0}"} height={88}>Main</Item>\n  <Item width="stretch"\n    ${bounded ? "minWidth={80} maxWidth={180}" : "minWidth={0}"} height={88}>Aside</Item>\n</HStack>\n// padding은 내부 .tile-content에서 적용합니다.`}
      flexCode={`.row { display: flex; width: ${width}px; gap: 12px; justify-content: safe center; }\n.item { width: 0; height: 88px; flex-basis: 0; flex-shrink: 0; }\n.main { flex-grow: ${weight}; min-width: ${bounded ? 120 : 0}px; max-width: ${bounded ? "300px" : "none"}; }\n.aside { flex-grow: 1; min-width: ${bounded ? 80 : 0}px; max-width: ${bounded ? "180px" : "none"}; }\n// min/max에 닿으면 브라우저가 공간을 재분배합니다.`}
      note="Max 합보다 넓으면 남은 공간을 center가 처리합니다. 가변 Item과 가변 경계의 동시 경쟁은 아직 지원하지 않습니다."
    />
  );
}

const tags = [
  "Design",
  "React DOM",
  "Hug contents",
  "Stretch",
  "Spacing",
  "TypeScript",
  "RTL",
  "Inspector"
];
function WrapCase() {
  const [width, setWidth] = useState(320);
  const [count, setCount] = useState(6);
  return (
    <Compare
      id="wrap"
      controls={
        <>
          <Range
            label="태그 영역 폭"
            value={width}
            set={setWidth}
            min={200}
            max={440}
          />
          <label>
            태그 수
            <select
              aria-label="태그 수"
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
            >
              {[3, 6, 8].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </>
      }
      layout={
        <HStack
          id="case-wrap"
          width={width}
          wrap
          gap={8}
          lineGap={12}
          className="stage"
        >
          {tags.slice(0, count).map((tag) => (
            <Item
              key={tag}
              as="button"
              type="button"
              height={36}
              padding={{ horizontal: 12 }}
            >
              {tag}
            </Item>
          ))}
        </HStack>
      }
      flex={
        <div
          id="flex-wrap"
          className="css-box stage"
          style={{
            ...row,
            width,
            flexWrap: "wrap",
            columnGap: 8,
            rowGap: 12,
            alignContent: "flex-start"
          }}
        >
          {tags.slice(0, count).map((tag) => (
            <button
              key={tag}
              type="button"
              className="css-box"
              style={{
                ...fixed,
                width: "max-content",
                height: 36,
                paddingInline: 12
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      }
      layoutCode={`<HStack width={${width}} wrap gap={8} lineGap={12}>\n  {tags.map(tag =>\n    <Item key={tag} as="button"\n      height={36} padding={{ horizontal: 12 }}>\n      {tag}\n    </Item>\n  )}\n</HStack>`}
      flexCode={`.tags {\n  display: flex; flex-direction: row; flex-wrap: wrap;\n  width: ${width}px; height: fit-content;\n  column-gap: 8px; row-gap: 12px;\n  align-items: flex-start; align-content: flex-start;\n}\n.tags > button {\n  width: max-content; height: 36px;\n  flex: 0 0 auto; padding-inline: 12px;\n}`}
      note="자연스러운 wrap는 Flexbox가 수행합니다. break=never/force 및 wrap과 명시적 Item 간격의 조합은 정밀 경로가 필요합니다."
    />
  );
}

function ShrinkCase() {
  const [width, setWidth] = useState(360);
  const [overflow, setOverflow] = useState<"auto" | "clip">("auto");
  const title = "이번 주 디자인 시스템 변경 사항";
  return (
    <Compare
      id="shrink"
      controls={
        <>
          <Range
            label="툴바 영역 폭"
            value={width}
            set={setWidth}
            min={184}
            max={440}
          />
          <label>
            Overflow
            <select
              aria-label="Overflow 정책"
              value={overflow}
              onChange={(event) =>
                setOverflow(event.target.value as "auto" | "clip")
              }
            >
              <option>auto</option>
              <option>clip</option>
            </select>
          </label>
        </>
      }
      layout={
        <HStack
          id="case-shrink"
          width={width}
          gap={12}
          padding={12}
          overflow={overflow}
          align="center"
          className="stage"
        >
          <Item width={40} height={32} className="toolbar-icon">
            M
          </Item>
          <Item
            width="hug-contents"
            minWidth={80}
            height={32}
            shrink
            className="toolbar-title"
          >
            <span className="ellipsis">{title}</span>
          </Item>
          <Item as="button" type="button" width={64} height={32}>
            저장
          </Item>
        </HStack>
      }
      flex={
        <div
          id="flex-shrink"
          className="css-box stage"
          style={{
            ...row,
            width,
            gap: 12,
            padding: 12,
            overflow,
            alignItems: "center"
          }}
        >
          <div
            className="css-box toolbar-icon"
            style={{ ...fixed, width: 40, height: 32 }}
          >
            M
          </div>
          <div
            className="css-box toolbar-title"
            style={{
              flex: "0 1 auto",
              width: "max-content",
              minWidth: 80,
              height: 32
            }}
          >
            <span className="ellipsis">{title}</span>
          </div>
          <button
            type="button"
            className="css-box"
            style={{ ...fixed, width: 64, height: 32 }}
          >
            저장
          </button>
        </div>
      }
      layoutCode={`<HStack width={${width}} gap={12} padding={12}\n  align="center" overflow="${overflow}">\n  <Item width={40} height={32}>M</Item>\n  <Item width="hug-contents" minWidth={80}\n    height={32} shrink>\n    <span className="ellipsis">{title}</span>\n  </Item>\n  <Item as="button" width={64} height={32}>\n    저장\n  </Item>\n</HStack>`}
      flexCode={`.bar { display: flex; width: ${width}px; gap: 12px; padding: 12px; overflow: ${overflow}; align-items: center; }\n.icon { width: 40px; height: 32px; flex: 0 0 auto; }\n.title {\n  width: max-content; min-width: 80px; height: 32px;\n  flex: 0 1 auto;\n}\n.save { width: 64px; height: 32px; flex: 0 0 auto; }\n.ellipsis { display: block; overflow: hidden;\n  white-space: nowrap; text-overflow: ellipsis; }`}
      note="축소 참여자는 제목 하나입니다. 여러 Item의 정확한 픽셀 축소량 비율은 현재 Native 경로가 거부합니다. 232px 미만에서는 min을 유지하며 overflow합니다."
    />
  );
}

const diagnosticCases = [
  {
    name: "Min > Max",
    expected: "E_INVALID_BOUNDS",
    code: "<Box minWidth={180} maxWidth={100} />",
    reason: "서로 모순된 크기 계약을 즉시 발견합니다.",
    run: () => normalizeBox({ minWidth: 180, maxWidth: 100 })
  },
  {
    name: "경계 중복",
    expected: "E_DUPLICATE_BOUNDARY_SPACE",
    code: "<HStack>\n  <Item gapAfter={20} />\n  <Item gapBefore={8} />\n</HStack>",
    reason: "같은 경계의 두 소유자를 합산하거나 임의로 선택하지 않습니다.",
    run: () =>
      nativeItems(normalizeStack({ axis: "horizontal", width: 360 }), [
        { id: "A", props: { width: 64, gapAfter: 20 } },
        { id: "B", props: { width: 64, gapBefore: 8 } }
      ])
  },
  {
    name: "간격 + 분산 정렬",
    expected: "E_MIXED_SPACE_DISTRIBUTION",
    code: '<HStack justify="between">\n  <Item width={64} />\n  <Item width={64} gapBefore={20} />\n</HStack>',
    reason: "정확한 20px 요청과 추가 공간 분산의 충돌을 드러냅니다.",
    run: () =>
      nativeItems(
        normalizeStack({ axis: "horizontal", width: 360, justify: "between" }),
        [
          { id: "A", props: { width: 64 } },
          { id: "B", props: { width: 64, gapBefore: 20 } }
        ]
      )
  },
  {
    name: "부모 Hug + 자식 %",
    expected: "E_PERCENT_DEPENDENCY",
    code: '<HStack width="hug-contents">\n  <Item width="50%" />\n</HStack>',
    reason:
      "자기 자식에 의존하는 부모 크기를 percentage 기준으로 사용할 수 없습니다.",
    run: () =>
      nativeItems(normalizeStack({ axis: "horizontal" }), [
        { id: "A", props: { width: "50%" } }
      ])
  },
  {
    name: "지원 범위: never",
    expected: "E_LAYOUT_CAPABILITY",
    code: '<HStack width={360} wrap>\n  <Item width={64} />\n  <Item width={64} breakBefore="never" />\n</HStack>',
    reason:
      "강한 줄바꿈 그룹은 정밀 solver가 필요합니다. 비슷한 CSS 결과로 대신하지 않습니다.",
    run: () =>
      nativeItems(
        normalizeStack({ axis: "horizontal", width: 360, wrap: true }),
        [
          { id: "A", props: { width: 64 } },
          { id: "B", props: { width: 64, breakBefore: "never" } }
        ]
      )
  }
];

function DiagnosticsCase() {
  const [selected, setSelected] = useState(0);
  const example = diagnosticCases[selected];
  let diagnostic = "";
  let message = "";
  try {
    example.run();
  } catch (error) {
    diagnostic =
      error instanceof LayoutError ? error.diagnostic.code : "UNEXPECTED_ERROR";
    message = error instanceof Error ? error.message : String(error);
  }
  return (
    <>
      <div className="case-controls">
        <label>
          검증 사례
          <select
            aria-label="검증 사례"
            value={selected}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {diagnosticCases.map((entry, index) => (
              <option key={entry.name} value={index}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="diagnostic-grid">
        <pre className="code">
          <code>{example.code}</code>
        </pre>
        <div
          className="diagnostic-result"
          role="status"
          data-expected={example.expected}
        >
          <span className="eyebrow">실제 정규화 함수의 실행 결과</span>
          <strong>{diagnostic || "진단 없음"}</strong>
          <p>{example.reason}</p>
          <code>{message}</code>
        </div>
      </div>
      <p className="comparison-note">
        CSS는 해당 속성들의 cascade와 sizing 규칙을 적용합니다. Layout
        컴포넌트는 그 위에서 선언한 레이아웃 의도가 충돌하는지 검증합니다. 이
        패널은 정상 geometry가 없는 입력이므로 Inspector 대신 오류를 표시합니다.
      </p>
    </>
  );
}

export const layoutCases = [
  {
    id: "sizing",
    label: "01 · Hug / Fixed / Stretch",
    title: "문구가 바뀌어도 크기 의도는 그대로",
    summary: "버튼 문구를 편집하고 가로·세로 크기 모드를 바꿔보세요.",
    benefit:
      "폭과 높이에 같은 크기 언어를 쓰고, 자연스러운 콘텐츠 크기를 기본값으로 둡니다.",
    source: references.sizing,
    Component: SizingCase
  },
  {
    id: "card",
    label: "02 · VStack 안의 HStack",
    title: "자식의 콘텐츠가 카드의 높이를 결정",
    summary:
      "설명을 늘리거나 카드 폭을 줄이면 액션 그룹까지 자연스럽게 이동합니다.",
    benefit:
      "세로 구조와 가로 액션 그룹을 컴포넌트 이름으로 읽을 수 있습니다. 중첩은 의미 있는 영역을 표현합니다.",
    source: references.launch,
    Component: CardCase
  },
  {
    id: "relations",
    label: "03 · 경계별 공간 배분",
    title: "가운데는 20px, 양옆에는 남는 공간",
    summary: "너비와 RTL을 바꿔도 B–C 사이는 정확히 20px입니다.",
    benefit:
      "간격을 원하는 Item에 선언합니다. 여백만을 위한 추가 그룹 없이 각 경계의 책임자를 알 수 있습니다.",
    source: references.space,
    Component: RelationsCase
  },
  {
    id: "conditional",
    label: "04 · 조건부 DOM / RTL",
    title: "형제가 사라지면 경계도 다시 해석",
    summary:
      "A를 숨기면 B의 앞 간격은 형제 사이 20px에서 시작 edge 20px로 바뀝니다.",
    benefit:
      "부모 gap을 빼는 보정과 edge 예외를 renderer가 실제 DOM 기준으로 관리합니다.",
    source: references.space,
    additionalSource: references.reshaped,
    Component: ConditionalCase
  },
  {
    id: "weighted",
    label: "05 · 비율 + Min / Max",
    title: "비중을 선언하고 한계를 함께 지정",
    summary:
      "Weight와 너비를 바꾸고 제약을 켜서 재분배와 남는 공간을 관찰하세요.",
    benefit:
      "stretch의 비중과 min/max를 함께 읽을 수 있습니다. flex basis와 grow 설정은 Native 경로가 담당합니다.",
    source: references.elm,
    Component: WeightedCase
  },
  {
    id: "wrap",
    label: "06 · 자연스러운 Wrap",
    title: "Item 간격과 줄 간격을 따로 표현",
    summary: "태그 수와 너비를 바꾸면 DOM 순서를 유지하며 줄이 구성됩니다.",
    benefit:
      "gap과 lineGap의 역할이 드러납니다. 기본 flex wrap에 비해 표현력이 늘어나는 사례라기보다 API의 일관성을 보여줍니다.",
    source: references.elm,
    Component: WrapCase
  },
  {
    id: "shrink",
    label: "07 · 양보와 Overflow",
    title: "부족할 때 무엇이 줄어드는가",
    summary:
      "툴바를 줄여 제목만 축소되고 최소 크기 이후 overflow하는 것을 확인하세요.",
    benefit:
      "선언한 크기와 hug 크기는 기본적으로 유지하고, 양보하는 Item에만 shrink를 명시해 정책을 드러냅니다.",
    source: references.space,
    Component: ShrinkCase
  },
  {
    id: "diagnostics",
    label: "08 · 계약 검증",
    title: "우연한 배치 대신 설명 가능한 진단",
    summary:
      "잘못된 조합과 현재 지원하지 않는 조합을 실제 정규화 함수로 검사합니다.",
    benefit:
      "동일 경계 중복, 크기 의존성, 정밀 경로의 한계를 오류 코드로 확인할 수 있습니다.",
    source: references.elm,
    Component: DiagnosticsCase
  }
];
