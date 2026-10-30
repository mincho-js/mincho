import { references } from "./cases.js";

export function DesignNotes() {
  return (
    <section
      id="references"
      className="panel references"
      aria-labelledby="references-title"
    >
      <p className="eyebrow">DESIGN NOTES</p>
      <h2 id="references-title">어떤 관점을 가져왔나요?</h2>
      <p className="description reference-intro">
        네 가지 도구에서 참고한 생각과 Layout 컴포넌트에서의 표현을 함께
        정리했습니다.
      </p>
      <div className="reference-grid">
        <article className="reference-card">
          <header>
            <h3>Figma</h3>
            <p>콘텐츠에 반응하는 크기</p>
          </header>
          <dl>
            <div>
              <dt>참고한 관점</dt>
              <dd>
                Hug / Fixed / Fill로 가로·세로 크기를 정하고, 중첩된 프레임이
                콘텐츠 변화에 맞춰 재배치됩니다.
              </dd>
            </div>
            <div>
              <dt>Layout 컴포넌트 적용</dt>
              <dd>
                <code>hug-contents</code>, 숫자, <code>stretch</code>로 크기를
                선언하고 <code>HStack</code>과 <code>VStack</code>을 중첩합니다.
              </dd>
            </div>
          </dl>
          <ul className="reference-links" aria-label="Figma 참고 자료">
            <li>
              <a href={references.launch.url} target="_blank" rel="noreferrer">
                Auto Layout의 시작 <span aria-hidden="true">↗</span>
              </a>
            </li>
            <li>
              <a href={references.sizing.url} target="_blank" rel="noreferrer">
                새 Auto Layout의 설계 <span aria-hidden="true">↗</span>
              </a>
            </li>
          </ul>
        </article>
        <article className="reference-card">
          <header>
            <h3>Subform</h3>
            <p>부모의 규칙과 항목 사이의 관계</p>
          </header>
          <dl>
            <div>
              <dt>참고한 관점</dt>
              <dd>
                부모와 자식의 배치 책임을 구분하고, 항목 앞뒤의 공간과
                main/cross axis를 명시적으로 다룹니다.
              </dd>
            </div>
            <div>
              <dt>Layout 컴포넌트 적용</dt>
              <dd>
                <code>Stack</code>의 기본 간격과 <code>Item</code>의 개별 관계를
                선언하고, Inspector에서 실제 배치 결과를 확인합니다.
              </dd>
            </div>
          </dl>
          <ul className="reference-links" aria-label="Subform 참고 자료">
            <li>
              <a href={references.space.url} target="_blank" rel="noreferrer">
                Why Not Flexbox? <span aria-hidden="true">↗</span>
              </a>
            </li>
            <li>
              <a
                href={references.subformLearn.url}
                target="_blank"
                rel="noreferrer"
              >
                Learn · 관계, Stack, HUD <span aria-hidden="true">↗</span>
              </a>
            </li>
          </ul>
        </article>
        <article className="reference-card">
          <header>
            <h3>elm-ui</h3>
            <p>배치 의도를 조합하는 어휘</p>
          </header>
          <dl>
            <div>
              <dt>참고한 관점</dt>
              <dd>
                row/column, spacing/padding, fillPortion과 min/max를 조합해
                배치와 공간 배분의 의도를 표현합니다.
              </dd>
            </div>
            <div>
              <dt>Layout 컴포넌트 적용</dt>
              <dd>
                <code>gap</code>, <code>padding</code>, <code>stretch</code>의
                weight와 크기 제약을 조합합니다.
              </dd>
            </div>
          </dl>
          <ul className="reference-links" aria-label="elm-ui 참고 자료">
            <li>
              <a href={references.elm.url} target="_blank" rel="noreferrer">
                Element API <span aria-hidden="true">↗</span>
              </a>
            </li>
          </ul>
        </article>
        <article className="reference-card">
          <header>
            <h3>Reshaped</h3>
            <p>필요한 항목에만 개별 설정</p>
          </header>
          <dl>
            <div>
              <dt>참고한 관점</dt>
              <dd>
                View의 공통 배치에 View.Item을 선택적으로 더해, 특정 항목의
                간격이나 공간 배분을 조절합니다.
              </dd>
            </div>
            <div>
              <dt>Layout 컴포넌트 적용</dt>
              <dd>
                예외적인 관계에만 <code>Item</code>을 사용합니다.{" "}
                <code>gapBefore</code>로 간격을, <code>as</code>로 의미에 맞는
                HTML 태그를 선택합니다.
              </dd>
            </div>
          </dl>
          <ul className="reference-links" aria-label="Reshaped 참고 자료">
            <li>
              <a
                href={references.reshaped.url}
                target="_blank"
                rel="noreferrer"
              >
                View / View.Item <span aria-hidden="true">↗</span>
              </a>
            </li>
          </ul>
        </article>
      </div>
      <div className="reference-notes">
        <details className="reference-detail">
          <summary>용어와 구현 범위의 차이</summary>
          <dl>
            <div>
              <dt>크기와 단위</dt>
              <dd>
                elm-ui의 shrink는 Layout 컴포넌트의 hug-contents에 대응합니다.
                Layout 컴포넌트의 shrink는 공간이 부족할 때의 양보 정책입니다.
                Reshaped의 숫자 간격은 unit 토큰의 배수이며, Layout 컴포넌트는
                CSS px을 사용합니다.
              </dd>
            </div>
            <div>
              <dt>배치 방식</dt>
              <dd>
                Reshaped View는 flex 관련 속성으로 flex 배치를 활성화합니다.
                Layout 컴포넌트는 Box의 일반 흐름과 Stack의 flex 배치를
                구분합니다. Subform의 2018년 글을 참고하되, 이 데모의 CSS
                비교에는 현재의 gap을 사용합니다.
              </dd>
            </div>
            <div>
              <dt>현재 지원 범위</dt>
              <dd>
                현재는 Native CSS 경로입니다. 가중 경계와 가중 Item의 공동 배분,
                여러 Item의 정확한 픽셀 축소 비율, never/force 줄 제약은 정밀
                solver가 필요하여 오류로 거부합니다.
              </dd>
            </div>
          </dl>
        </details>
        <details className="source-code reference-detail">
          <summary>Flexbox 비교의 공통 CSS 초기화</summary>
          <pre>
            <code>{`.css-box {
  box-sizing: border-box;
  width: fit-content; height: fit-content;
  min-width: 0; min-height: 0;
  max-width: none; max-height: none;
  margin: 0; padding: 0;
  position: static; overflow: visible;
}
/* 색, 폰트, border, radius는 두 구현이 공유합니다.
   각 사례의 CSS는 위 초기화에 추가됩니다. */`}</code>
          </pre>
        </details>
      </div>
    </section>
  );
}
