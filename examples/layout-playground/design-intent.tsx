export function DesignIntent({
  onSelectCase
}: {
  onSelectCase: (id: string) => void;
}) {
  return (
    <section
      id="design-intent"
      className="panel design-intent"
      aria-labelledby="design-intent-title"
    >
      <p className="eyebrow">WHY / Layout 컴포넌트</p>
      <h2 id="design-intent-title">왜 Flexbox 위에 Layout API를 더했나요?</h2>
      <p className="intent-lead">
        화면을 만들 때 정한 의도가, 화면을 바꿀 때도 코드에 남도록.
      </p>
      <p className="intent-description">
        “버튼은 내용만큼, 제목은 남는 공간만큼, 취소 버튼 뒤는 넓게.” 레이아웃을
        설명할 때는 이렇게 말합니다. Layout 컴포넌트는 이 결정을 구조, 크기,
        형제 관계의 공통 어휘로 작성하게 합니다. 실제 배치는 브라우저의
        Flexbox를 사용하고, 반복해서 작성하던 CSS 조합과 예외 처리에 일관된
        규칙을 더합니다.
      </p>

      <div className="intent-example">
        <div>
          <h3>부모는 기본 배치를, Item은 특별한 관계를.</h3>
          <p>
            버튼 셋을 가로로 놓고 기본 간격은 8px로 유지합니다. 취소 버튼 뒤의
            경계만 남는 공간을 사용하게 합니다.
          </p>
          <dl>
            <div>
              <dt>구조</dt>
              <dd>HStack 안에 버튼 세 개</dd>
            </div>
            <div>
              <dt>기본 규칙</dt>
              <dd>가로 배치, 간격 8px, 세로 중앙 정렬</dd>
            </div>
            <div>
              <dt>예외</dt>
              <dd>취소 버튼 뒤만 stretch</dd>
            </div>
          </dl>
        </div>
        <pre aria-label="특정 경계의 공간을 선언하는 Layout 컴포넌트 코드">
          <code>{`<HStack width="stretch" gap={8} align="center">
  <Item as="button" gapAfter="stretch">Cancel</Item>
  <button>Previous</button>
  <button>Next</button>
</HStack>`}</code>
        </pre>
      </div>
      <p className="intent-description intent-dom-note">
        모든 자식을 Item으로 감쌀 필요는 없습니다. Item은 기본적으로 DOM 노드를
        하나 만들며, 위 예시는 as="button"으로 버튼 자체를 배치 항목으로
        렌더링합니다. 공동 배경이나 접근성 그룹처럼 실제 의미가 있는 중첩은
        그대로 유지합니다.
      </p>

      <div className="intent-comparison">
        <h3>직접 작성한 Flexbox와 무엇이 달라지나요?</h3>
        <p className="intent-description">
          차이는 화면을 변경할 때 드러납니다. CSS는 배치에 필요한 개별 규칙을
          제공하고, Layout 컴포넌트는 그 규칙을 조합하는 방식을 API의 계약으로
          정합니다. 같은 규칙을 직접 CSS 유틸리티로 만들 수도 있습니다. Layout
          컴포넌트를 사용하면 크기·간격의 의미와 검증을 화면마다 따로 정의하는
          일을 줄일 수 있습니다.
        </p>
        <p className="intent-scroll-hint" id="intent-scroll-hint">
          표를 좌우로 스크롤해 두 작성 방식을 비교하세요.
        </p>
        <div
          className="intent-table-scroll"
          role="region"
          aria-label="Flexbox와 Layout 컴포넌트의 작성 방식 비교"
          aria-describedby="intent-scroll-hint"
          tabIndex={0}
        >
          <table>
            <caption>
              같은 배치를 만들 때, 화면 작성자가 직접 관리할 규칙의 차이
            </caption>
            <thead>
              <tr>
                <th scope="col">결정할 것</th>
                <th scope="col">Flexbox를 직접 쓰면</th>
                <th scope="col">Layout 컴포넌트로 표현하면</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">구조와 축</th>
                <td>
                  display, flex-direction과 정렬 속성의 조합으로 각 컨테이너의
                  배치 역할을 정합니다.
                </td>
                <td>
                  HStack/VStack으로 배치 방향을 읽고, Box로 일반 콘텐츠 흐름을
                  유지합니다. align과 justify의 역할도 같은 어휘로 공유합니다.
                </td>
              </tr>
              <tr>
                <th scope="row">크기와 공간 부족</th>
                <td>
                  width/height, flex-basis, grow/shrink, min/max를 조합하고
                  공간이 줄었을 때의 동작을 맞춥니다.
                </td>
                <td>
                  hug-contents / 숫자 / stretch로 선호 크기를 정하고, min/max와
                  shrink로 허용 범위를 명시합니다. overflow는 넘친 콘텐츠의 표시
                  정책으로 구분합니다.
                </td>
              </tr>
              <tr>
                <th scope="row">특정 형제 사이의 간격</th>
                <td>
                  gap과 margin의 합, 논리적 방향, 첫·마지막 항목의 여백을 직접
                  맞춥니다. 조건부 렌더링에 따른 인접성도 고려합니다.
                </td>
                <td>
                  부모 gap을 기본값으로 두고 Item의 고정 간격으로 해당 경계를
                  대체합니다. React 경로는 실제 DOM의 이웃을 확인해 경계와 바깥
                  여백을 구분합니다.
                </td>
              </tr>
              <tr>
                <th scope="row">설정 충돌과 결과 확인</th>
                <td>
                  브라우저의 CSS 결과를 확인하고, 제품이 의도한 간격이나 크기
                  규칙에 맞는지는 별도로 검증합니다.
                </td>
                <td>
                  중복 경계 선언, min/max 충돌, 명시적 간격과 분산 정렬의 충돌을
                  오류로 알려줍니다. Inspector에서 선언된 관계와 브라우저가
                  계산한 크기·위치를 함께 확인합니다.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <details className="intent-code-comparison">
          <summary>
            01 · 구조와 축: 부모 안에서의 역할도 코드에 남깁니다
          </summary>
          <p>
            카드의 내용은 세로로, 버튼들은 가로로 배치한다고 가정해보세요. 아래
            두 코드의 구조는 같습니다. Layout 컴포넌트에서는 HStack/VStack의
            이름만으로 각 컨테이너의 방향을 읽습니다. Box는 자식의 일반 콘텐츠
            흐름을 유지하므로, 영역과 Stack의 역할도 구분됩니다.
          </p>
          <div className="intent-code-columns">
            <div>
              <h4>직접 작성한 Flexbox</h4>
              <pre>
                <code>{`<div className="card">
  <h3>Title</h3>
  <div className="actions">…</div>
</div>

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.actions {
  display: flex;
  flex-direction: row;
  gap: 8px;
  justify-content: flex-end;
  flex-shrink: 0;
}`}</code>
              </pre>
            </div>
            <div>
              <h4>Layout 컴포넌트로 표현하면</h4>
              <pre>
                <code>{`<VStack gap={12}>
  <h3>Title</h3>
  <HStack width="stretch" gap={8} justify="end">
    …
  </HStack>
</VStack>`}</code>
              </pre>
              <p>
                HStack의 justify는 자기 버튼들의 가로 정렬입니다. 같은 HStack의
                width=stretch는 부모 VStack 안에서 자기 너비를 정하는
                선언입니다. 컨테이너는 동시에 부모의 항목이라는 관계를
                유지합니다.
              </p>
            </div>
          </div>
          <p>
            API가 맡는 것은 이 명명과 역할 구분입니다. 버튼 그룹의 배경, 접근성,
            상호작용을 위한 중첩은 유지합니다. 간격 하나를 조절하려고 만든
            중첩은 Item 관계로 표현할 수 있습니다. 코드는 배치의 의미를
            설명하고, 실제 HTML 태그는 as로 선택합니다.
          </p>
        </details>
        <details className="intent-code-comparison">
          <summary>
            02 · 크기와 공간 부족: 크기 모드와 제약을 따로 정합니다
          </summary>
          <p>
            “뒤로 버튼은 80px을 유지하고 제목은 나머지를 쓰되 최대 320px.”
            CSS에서는 width와 함께 flex-basis, grow/shrink, 최소 크기를 맞춰야
            합니다. 예를 들어 flex item의 width만 80px로 지정하면, 공간이 부족할
            때 flex-shrink에 따라 줄어들 수 있습니다.
          </p>
          <div className="intent-code-columns">
            <div>
              <h4>직접 작성한 Flexbox</h4>
              <pre>
                <code>{`/* .toolbar > .back + .title */
.toolbar {
  display: flex;
  width: 400px;
  gap: 8px;
  align-items: flex-start;
}
.back {
  width: 80px;
  flex: 0 0 auto;
}
.title {
  flex: 1 0 0;
  min-width: 0;
  max-width: 320px;
}`}</code>
              </pre>
            </div>
            <div>
              <h4>Layout 컴포넌트로 표현하면</h4>
              <pre>
                <code>{`<HStack width={400} gap={8}>
  <Item width={80}>Back</Item>
  <Item width="stretch"
    minWidth={0} maxWidth={320}>
    Title
  </Item>
</HStack>`}</code>
              </pre>
              <p>
                숫자는 기본적으로 늘거나 줄지 않는 선호 크기입니다.
                hug-contents는 콘텐츠에 맞추고, stretch는 가용 공간 배분에
                참여합니다. min/max는 어느 모드에서도 별도의 크기 제약으로
                읽습니다. 숫자의 단위는 CSS px입니다.
              </p>
            </div>
          </div>
          <p>
            부모 폭을 바꿀 때도 어떤 항목이 고정되고 어떤 항목이 공간을 받을지
            같은 선언에서 확인합니다. 여유 공간은 stretch, 부족할 때의 양보는
            shrink, 최종적으로 넘친 콘텐츠의 표시는 overflow가 담당합니다. 글줄
            생략이나 줄바꿈은 텍스트의 CSS 정책으로 남습니다.
          </p>
          <p>
            이 API의 shrink weight는 양보할 픽셀량의 비율을 뜻합니다. Flexbox의
            크기를 반영한 축소 비율과 다르므로, 현재 구현은 여러 관리 대상
            Item이 동시에 shrink하는 조합을 거부합니다. 정밀 축소가 이미
            제공된다고 가정해서는 안 됩니다.
          </p>
        </details>
        <details className="intent-code-comparison" open>
          <summary>03 · 형제 간격: “기본 간격은 12px, B 앞만 20px”</summary>
          <p>
            A가 있으면 A–B는 20px, B–C는 12px입니다. A가 사라지면 B 앞의 20px은
            시작 여백으로 남습니다. 아래 두 코드는 이 같은 간격 규칙을
            표현합니다. 버튼의 장식과 공통 크기 스타일은 생략했습니다.
          </p>
          <div className="intent-code-columns">
            <div>
              <h4>직접 작성한 Flexbox</h4>
              <pre>
                <code>{`<div className="actions">
  {showA && <button>A</button>}
  <button className="before-20">B</button>
  <button>C</button>
</div>

.actions {
  display: flex;
  gap: 12px;
}
.before-20 {
  margin-inline-start: 8px; /* 20 - 12 */
}
.before-20:first-child {
  margin-inline-start: 20px;
}`}</code>
              </pre>
              <p>
                이 DOM 구조에서는 gap에 8px을 더하면 됩니다. B가 첫 항목이 되면
                앞에 gap이 없으므로 20px로 바꿉니다. 기본 gap을 바꿀 때는 이
                보정값도 함께 확인합니다. CSS 변수로 계산을 묶을 수도 있지만,
                경계와 시작 여백을 구분하는 규칙은 작성자가 관리합니다.
              </p>
            </div>
            <div>
              <h4>Layout 컴포넌트로 표현하면</h4>
              <pre>
                <code>{`<HStack gap={12}>
  {showA && <button>A</button>}
  <Item as="button" gapBefore={20}>B</Item>
  <button>C</button>
</HStack>`}</code>
              </pre>
              <p>
                B 앞의 최종 공간을 20px로 선언합니다. 부모 gap과의 차이, B가 첫
                항목인지에 따른 처리는 React 렌더러가 실제 DOM을 보고
                적용합니다. 기본 gap이나 A의 표시 여부가 바뀌어도 이 선언은
                그대로입니다. B는 shrink를 선언하지 않았으므로 공간이 부족해도
                콘텐츠 크기를 유지합니다.
              </p>
            </div>
          </div>
          <p>
            이 예시의 이점은 최종 간격을 한 곳에서 선언하는 것입니다.
            gapBefore와 gapAfter가 같은 경계를 중복 정의하면 오류가 납니다.
            여기서는 줄바꿈하지 않는 관계를 다루며, wrap과 명시적 Item 간격의
            조합은 현재 정밀 계산기가 필요해 지원하지 않습니다.
          </p>
        </details>
        <details className="intent-code-comparison">
          <summary>
            04 · 충돌 검증: 유효한 CSS와 의도한 배치는 다를 수 있습니다
          </summary>
          <p>
            100px 항목 두 개를 400px 안에 놓고, 사이를 정확히 20px로 지정하면서
            양끝으로 분산시키면 어떻게 될까요? CSS의 space-between은 남은 공간도
            사이에 더하므로 실제 간격은 200px입니다. 브라우저는 CSS 규칙대로
            동작합니다. “정확히 20px”과 “양끝 분산”이라는 요구의 충돌은 별도로
            알아내야 합니다.
          </p>
          <div className="intent-code-columns">
            <div>
              <h4>직접 작성한 Flexbox</h4>
              <pre>
                <code>{`/* .actions > .item + .item.before-20 */
.actions {
  display: flex;
  width: 400px;
  gap: 12px;
  justify-content: space-between;
}
.item {
  width: 100px;
  flex: 0 0 auto;
}
.before-20 {
  margin-inline-start: 8px;
}
/* 최종 항목 간격: 200px */`}</code>
              </pre>
            </div>
            <div>
              <h4>Layout 컴포넌트로 표현하면</h4>
              <pre>
                <code>{`<HStack width={400} gap={12} justify="between">
  <Item width={100}>A</Item>
  <Item width={100} gapBefore={20}>B</Item>
</HStack>
// E_MIXED_SPACE_DISTRIBUTION`}</code>
              </pre>
              <p>
                Layout 컴포넌트는 정확한 경계 간격과 분산 정렬을 함께 선언한
                것을 오류로 알려줍니다. 정확히 20px가 목적이면
                justify=start/center/end를 선택하고, 양끝 분산이 목적이면 명시적
                간격을 제거합니다.
              </p>
            </div>
          </div>
          <p>
            같은 방식으로 min보다 작은 max, 경계의 중복 선언, 지원하지 않는 배치
            조합을 진단합니다. Inspector는 실제 DOM 항목의 크기·위치와 computed
            CSS를 정규화된 관계 선언 옆에 보여줍니다. 브라우저 계산 결과를
            확인하는 도구이며, 아직 없는 정밀 solver의 계산 과정을 설명하는
            도구는 아닙니다.
          </p>
        </details>
        <nav className="intent-case-links" aria-label="설계 의도를 확인할 사례">
          <a href="#layout-cases" onClick={() => onSelectCase("sizing")}>
            크기 모드 비교 <span aria-hidden="true">→</span>
          </a>
          <a href="#layout-cases" onClick={() => onSelectCase("conditional")}>
            조건부 DOM과 간격 <span aria-hidden="true">→</span>
          </a>
          <a href="#layout-cases" onClick={() => onSelectCase("diagnostics")}>
            충돌 검증 <span aria-hidden="true">→</span>
          </a>
        </nav>
      </div>

      <div className="intent-tradeoffs">
        <div>
          <h3>특히 도움이 되는 경우</h3>
          <p>
            같은 배치 패턴을 여러 화면에서 반복하거나, 문구·방향·표시 항목이
            자주 바뀌는 UI에 유용합니다. 코드 리뷰에서도 “이 margin을 왜
            넣었지?”를 추적하는 대신 어떤 크기와 관계를 의도했는지 확인할 수
            있습니다. 팀이 합의할 배치 규칙을 API가 맡습니다.
          </p>
        </div>
        <div>
          <h3>직접 CSS를 쓰는 편이 간단한 경우</h3>
          <p>
            한두 줄의 고정된 배치이거나 이미 팀의 CSS 유틸리티가 같은 규칙을
            제공한다면 직접 Flexbox를 써도 충분합니다. Layout 컴포넌트에는 API
            학습과 React의 DOM 검증 비용이 있습니다. 현재의 이점은 표현과
            검증이며, 렌더링 속도나 번들 크기가 더 작다는 보장은 없습니다.
          </p>
        </div>
      </div>
      <aside className="intent-scope" aria-label="설계 목표와 현재 구현 범위">
        <strong>의미를 지킬 수 있는 범위를 명확히 합니다.</strong>
        <p>
          처음 설계안의 목표는 공간 부족과 줄바꿈까지 설명 가능한 배치입니다.
          현재 구현은 Native CSS로 보장하는 부분집합입니다. 가중 Item과 가중
          경계의 공동 배분, 여러 Item의 정확한 픽셀 축소 비율, never/force
          줄바꿈은 정밀 계산기가 필요하며, 지금은 E_LAYOUT_CAPABILITY 오류로
          거부합니다. Inspector도 현재 브라우저의 결과를 표시합니다.
        </p>
      </aside>
    </section>
  );
}
