import { useState } from "react";
import { SquircleMask } from "@mincho-js/react/squircle";
import {
  getSquircleGeometry,
  getSquirclePath
} from "@mincho-js/css/squircle/core";

export function SquircleDemo() {
  const [width, setWidth] = useState(280);
  const [height, setHeight] = useState(180);
  const [radius, setRadius] = useState(48);
  const [smoothing, setSmoothing] = useState(0.8);
  const [fixed, setFixed] = useState(false);
  const [count, setCount] = useState(0);
  const options = { width, height, radius, smoothing };
  const effective = getSquircleGeometry(options);
  const controls = [
    {
      label: "너비",
      value: width,
      min: 48,
      max: 420,
      step: 1,
      set: setWidth,
      unit: "px"
    },
    {
      label: "높이",
      value: height,
      min: 48,
      max: 300,
      step: 1,
      set: setHeight,
      unit: "px"
    },
    {
      label: "반지름",
      value: radius,
      min: 0,
      max: 100,
      step: 1,
      set: setRadius,
      unit: "px"
    },
    {
      label: "Smoothing",
      value: smoothing,
      min: 0,
      max: 1,
      step: 0.05,
      set: setSmoothing,
      unit: ""
    }
  ];
  return (
    <section className="panel squircle-demo" aria-labelledby="squircle-title">
      <p className="eyebrow">SQUIRCLE / SMOOTH CORNERS</p>
      <h2 id="squircle-title">둥근 모서리의 연결을 부드럽게.</h2>
      <p className="description">
        같은 크기와 반지름에서 원호와 스쿼클을 비교하세요. Smoothing을 높이면
        직선과 모서리가 만나는 곡선이 길어집니다. 공간이 부족해지면
        smoothing부터 줄이고, 그 다음 반지름을 줄입니다.
      </p>
      <div className="case-controls squircle-controls">
        {controls.map((control) => (
          <label key={control.label}>
            <span>
              {control.label}{" "}
              <output>
                {control.value}
                {control.unit}
              </output>
            </span>
            <input
              type="range"
              aria-label={control.label}
              value={control.value}
              min={control.min}
              max={control.max}
              step={control.step}
              onChange={(event) => control.set(Number(event.target.value))}
            />
          </label>
        ))}
        <label className="inline-toggle">
          <input
            type="checkbox"
            checked={fixed}
            onChange={(event) => setFixed(event.target.checked)}
          />
          고정 크기 props 사용
        </label>
      </div>
      <div className="comparison">
        <div className="comparison-side">
          <h3>border-radius</h3>
          <div className="squircle-stage">
            <div
              className="squircle-surface"
              style={{ width, height, borderRadius: radius }}
            >
              <span className="squircle-orb" />
              <span className="squircle-label">Circular</span>
            </div>
          </div>
        </div>
        <div className="comparison-side">
          <h3>SquircleMask</h3>
          <div className="squircle-stage">
            <SquircleMask
              className="squircle-surface"
              radius={radius}
              smoothing={smoothing}
              width={fixed ? width : undefined}
              height={fixed ? height : undefined}
              style={fixed ? undefined : { width, height }}
            >
              <span className="squircle-orb" />
              <span className="squircle-label">Smoothed</span>
            </SquircleMask>
          </div>
        </div>
      </div>
      <div className="squircle-detail">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="원호와 스쿼클 윤곽 비교"
        >
          <path
            d={getSquirclePath({ ...options, smoothing: 0 })}
            className="squircle-outline-circle"
          />
          <path
            d={getSquirclePath(options)}
            className="squircle-outline-smooth"
          />
        </svg>
        <div>
          <strong>윤곽을 겹쳐 보면</strong>
          <p>
            점선은 원호, 초록 선은 스쿼클입니다. 실제 반지름 {effective.radius}
            px, smoothing {Number(effective.smoothing.toFixed(3))}로 그려집니다.
          </p>
          <p>
            {fixed
              ? "고정 크기는 서버에서도 완성된 마스크를 만들며, 브라우저 크기 관찰이 필요 없습니다."
              : "CSS로 크기를 지정하면 브라우저의 border box에 맞춰 마스크가 갱신됩니다. 크기를 바꿔도 자식을 다시 렌더링하지 않습니다."}
          </p>
        </div>
      </div>
      <pre className="code">
        <code>
          {fixed
            ? `<SquircleMask width={${width}} height={${height}}\n  radius={${radius}} smoothing={${smoothing}}>\n  <Content />\n</SquircleMask>`
            : `<SquircleMask radius={${radius}} smoothing={${smoothing}}\n  style={{ width: ${width}, height: ${height} }}>\n  <Content />\n</SquircleMask>`}
        </code>
      </pre>
      <div className="squircle-action-row">
        <SquircleMask
          as="button"
          className="squircle-action"
          radius={18}
          type="button"
          onClick={() => setCount((value) => value + 1)}
        >
          {count ? `${count}번 저장했어요` : "내용에 맞춰 늘어나는 버튼"}
        </SquircleMask>
        <p>
          문구가 바뀌어도 같은 버튼을 유지합니다. Tab으로 이동하면 안쪽 포커스
          표시를 볼 수 있습니다.
        </p>
      </div>
      <p className="comparison-note">
        마스크는 자식과 그림자도 함께 자릅니다. 바깥 그림자는 별도 요소에 두고,
        클릭 영역은 원래 HTML 박스라는 점을 고려하세요. 반응형 크기의 SSR 초기
        화면은 둥근 모서리로 시작한 뒤 측정한 모양으로 바뀝니다.
      </p>
    </section>
  );
}
