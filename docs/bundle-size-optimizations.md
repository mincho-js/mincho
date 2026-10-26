# 번들 크기 최적화

이 문서는 컴파일러, 런타임, 앱 CSS의 번들 크기 최적화 옵션을 설명합니다. 기존 production 최적화 기본값은 유지합니다. 아래에 추가된 구조 변경 옵션은 모두 opt-in입니다. 크기 판단의 기본 지표는 Brotli이며, 동률이면 기존 출력을 유지합니다.

```ts
minchoVitePlugin({
  bundleSize: { metric: "brotli" }, // "gzip" | "raw"도 지원
  optimize: {
    compactRuntime: true,
    compactMetadata: true,
    sizeAware: true,
  },
  appCss: {
    mode: "dist-chunk",
    optimize: {
      scopedResourceAnalysis: true,
      crossFileRules: true,
      dedupeResources: true,
    },
    routes: [
      { id: "settings", entry: "src/settings.ts", layouts: ["src/layout.ts"] },
    ],
    usage: {
      mode: "closed",
      preserve: [{ module: "src/public.ts", exports: ["button", "tokens"] }],
    },
  },
  diagnostics: { json: "mincho-diagnostics.json" },
});
```

## 컴파일러와 런타임

| 항목           | 동작                                                                                                                                                                            | 적용 범위                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 클래스 이름            | private `ma_`/`mc_` 이름의 동일한 128비트를 hex32에서 base64url22로 표현합니다. 전체 이름은 35자에서 25자가 됩니다.                                                             | 기존 private atomic/composite 기능 |
| `compactRuntime`            | 기존 캐시 활성화 기준보다 작은 immutable recipe에 별도 compact factory를 사용합니다. 캐시 구현은 별도 모듈에 남습니다.                                                          | Vite/esbuild, app/library          |
| `compactMetadata` / `sizeAware`            | 생성 코드와 실제 helper 의존성의 압축 크기를 비교합니다. 큰 반복 metadata는 문자열 테이블과 버전이 있는 private payload를 후보로 삼습니다. decoder와 wrapper 비용도 계산합니다. | Vite/esbuild                       |
| `sizeAware` class 전략 | 기존 atomic/composite 옵션을 모두 켰을 때만 두 후보의 추가 CSS와 클래스 문자열 비용을 비교합니다. 기존 cascade 증명과 허용 속성 제한을 유지합니다.                              | 지원되는 빌드 평가 경로            |

`sizeAware`는 다른 최적화를 자동으로 켜지 않습니다. 기존 literal/finite/table 변환이 만든 결과도 helper를 포함한 비용 검사 대상입니다. 판단 값은 모듈/후보의 **추정 비용**입니다. 최종 JS·CSS asset 크기와 구분해 기록합니다. 전체 앱의 전역 최적해나 모든 요청 순서의 최소 크기를 보장하지는 않습니다.

직접 호출하는 mutable recipe API는 그대로 유지됩니다. getter 읽기, default/null/boolean 선택, compound 순서, props 매핑, metadata API의 반환 의미도 유지합니다. 큰 recipe는 기존 캐시 런타임을 사용합니다. 이 기능 때문에 runtime entry가 authoring 코드를 가져오지 않도록 분리했습니다.

## Vite 앱의 CSS와 사용 분석

| 항목                         | 동작                                                                                                   | 보존하는 경우                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `scopedResourceAnalysis` | AST에서 literal custom property 접근을 찾아 해당 변수만 보존합니다.                                    | stylesheet/rule 열거, 동적 속성 이름, CSSOM alias/escape, 알 수 없는 소스                                   |
| `crossFileRules`         | 최종 chunk에서 서로 인접한 파일의 동일 선언을 selector list로 합칩니다. 기존 클래스 이름은 유지합니다. | 순서/조건이 다르거나 중간 CSS barrier, URL/복잡한 selector가 있는 경우                                      |
| `dedupeResources`        | CSS 안에서만 참조되는 동일 private keyframes/font-face 정의와 참조를 정리합니다.                       | 공개 이름, 다른 chunk의 참조, 외부 stylesheet, 불명확한 참조 문법                                           |
| `usage.mode: "closed"`   | 실제 import graph 전체에서 내부 export/alias와 recipe 호출, 상수화된 클래스, token 접근을 분석합니다.  | public entry/dynamic entry export, preserve 목록, namespace/star export, 비정적 import/require/eval, escape |

`usage`는 라이브러리 공개 API를 닫힌 것으로 간주하지 않습니다. Vite 앱의 `dist-chunk`에서 사용합니다. entry 모듈과 dynamic import의 대상 모듈에서 내보내는 export는 자동으로 보존합니다. 그 외 내부 모듈의 export를 외부에서 사용한다면 `preserve`에 포함해야 합니다. `preserve` 항목에서 `exports`를 생략하면 해당 모듈의 export 전체를 보존합니다. 파일 경로는 Vite root 기준입니다. route/layout은 실제 빌드 그래프의 모듈을 지정합니다.

이 분석은 selector purge를 임의로 수행하지 않습니다. compiler provenance가 있는 자원만 기존 IR pruning에 연결합니다. CSSOM 관찰과 opaque CSS/PostCSS는 보수적인 보존 조건으로 남습니다. ReactDOM 등 특정 패키지 이름을 신뢰하는 allowlist는 없습니다.

## 공유 CSS 비용 검사

```ts
appCss: {
  mode: "dist-chunk",
  sharing: {
    minBytes: 4096,
    minBoundaries: 2,
    cost: {
      maxInitialIncreaseBytes: 0,
      scenarios: [{ entry: "index.html", routes: ["settings", "reports"] }]
    }
  }
}
```

공유 비용 검사는 기존 전체 CSS module prefix 공유 후보를 대상으로 합니다. `minBytes`는 기존 raw prefix 크기 기준입니다. 그 다음 asset별 압축 비용을 계산하고, 추가 import/metadata 비용을 보수적으로 포함합니다. 서로 다른 CSS asset을 합쳐 압축한 값을 전송량으로 사용하지 않습니다.

`cost` 생략/`false`는 기존 선택 방식입니다. 활성화하면 초기 증가 허용값은 기본 0입니다. `scenarios`를 생략하면 entry별 cold load, 도달 가능한 boundary 방문, 누적 방문을 검사합니다. 명시한 route가 entry에서 도달할 수 없으면 오류를 냅니다. 누적 방문에서는 이미 받은 공유 CSS를 다시 계산하지 않습니다. 개선이 없거나 초기/방문 비용 제한을 넘으면 공유를 하지 않습니다.

비용 검사는 Vite 앱에서 우선 지원합니다. esbuild에 이 옵션을 전달하면 지원 범위를 설명하는 오류를 냅니다. native CSS minifier와 target, hash, CSS 순서 처리는 계속 번들러가 담당합니다. Lightning CSS의 변환·압축 설정에서는 정확한 preview를 지원하지 않아 비용 기반 공유 후보를 보존합니다.

## 명시적인 lazy theme

```ts
appCss: {
  mode: "dist-chunk",
  themes: {
    default: "light",
    system: { light: "light", dark: "dark" },
    entries: [
      { id: "light", entry: "src/themes/light.ts" },
      { id: "dark", entry: "src/themes/dark.ts" }
    ]
  }
}
```

각 entry는 기본적으로 `themeClass`라는 정적 클래스 문자열을 export합니다. `classNameExport`로 export 이름을 변경할 수 있습니다. 컨트롤러는 이 entry에서 추출한 CSS asset과 selector를 사용하므로, 테마 전환에 필요한 런타임 로직은 앱에서 관리합니다.

```ts
// src/themes/light.ts
import { css } from "@mincho-js/css";
export const themeClass = css({
  vars: { "--app-fg": "#111", "--app-bg": "#fff" },
});
```

전역 attribute selector를 작성한 테마는 `{ id, entry, attribute: "data-theme", value: "dark" }`로 등록합니다. selector와 실제 CSS를 일치시켜야 합니다. 공통 token contract와 base CSS 의존성은 실제 import graph대로 포함됩니다. 자동으로 모든 테마를 초기 HTML에 연결하지 않습니다.

Lazy theme 설정은 `.vite/mincho-css-manifest.json`에 v2 theme registry를 추가합니다. `ssrManifest` 문자열로 파일명을 변경할 수 있습니다. 테마가 없으면 기존 v1을 생성합니다. `resolveSsrStylesheets`는 v1/v2 manifest를 모두 지원하지만, `resolveSsrTheme`과 `createThemeController`는 `themes`가 있는 v2 manifest가 필요하며 v1은 지원하지 않습니다.

```ts
import { resolveSsrTheme } from "@mincho-js/vite/ssr";
const initial = resolveSsrTheme(manifest, {
  preference: "system",
  systemScheme: "dark",
  selection: { entries: ["index.html"], routes: ["settings"] },
});
// initial.stylesheets를 head에, attributes를 root에 반영하고 snapshot을 전달합니다.

import { createThemeController } from "@mincho-js/vite/themes";
const themes = createThemeController(manifest, { initial: initial.snapshot });
await themes.ready;
await themes.preloadTheme("dark");
await themes.setTheme("dark");
```

컨트롤러는 framework에 의존하지 않는 별도 entry입니다. 기본 target은 `documentElement`이며 다른 Element를 지정할 수 있습니다. `getSnapshot()`, `subscribe(listener)`, `dispose()`도 제공합니다. CSS 로딩 완료 후 관리하는 클래스/attribute만 변경합니다. 연속 요청에서는 마지막 요청만 commit하며 실패하면 기존 테마를 유지합니다. OS 변경은 preference가 `system`인 경우만 반영합니다. SSR에 OS 힌트가 없으면 default를 사용하고 클라이언트가 필요한 CSS를 받은 후 전환합니다.

저장은 기본적으로 하지 않습니다. 동기 `persistence: { read(), write(preference) }` adapter를 명시할 때만 저장소를 사용합니다. 저장 실패 때문에 적용된 테마를 되돌리지 않습니다. `dispose()`는 listener를 정리하고 진행 중 commit을 무효화하며, 현재 테마나 다른 컨트롤러와 공유하는 CSS는 제거하지 않습니다.

테마 asset 분할만 사용할 때는 컨트롤러 JS를 포함하지 않습니다. 컨트롤러가 필요한 앱은 추가 JS와 첫 테마 전환 비용도 함께 비교해야 합니다. 작은 테마에서는 컨트롤러 비용이 초기 CSS 절감량보다 클 수 있습니다.

조건부 `appCss.optimize.compactColorThemes`는 `themes.colorScheme: { light, dark, inheritance: "uniform" }` 계약이 있을 때 검토합니다. 같은 asset의 인접한 두 클래스가 이미 각각 `colorScheme: "light"/"dark"`를 선언하고, 동일한 변수 집합의 정적 색상 값만 가지며, 관찰되지 않고 비용도 감소해야 `light-dark()`로 공유합니다. `inheritance: "uniform"`은 테마가 적용된 영역의 자손이 다른 `color-scheme`을 지정하지 않는다는 앱의 명시적 계약입니다. `light-dark()`의 값은 사용 위치의 scheme에 의존하므로 이 계약 없이는 변환하지 않습니다. 지원 최소 target은 [MDN 호환성 데이터](https://github.com/mdn/browser-compat-data/blob/main/css/types/color.json)의 Chrome/Edge 123, Firefox 120, Safari/iOS 17.5로 고정했습니다. 모르는 target, 혼합 단위, URL, 색상 외 값은 변환하지 않습니다.

이 최적화는 기본적으로 비활성화되어 있습니다. `appCss.optimize.compactColorThemes: true`로 명시적으로 활성화합니다.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";

export default defineConfig({
  plugins: [
    minchoVitePlugin({
      appCss: {
        mode: "dist-chunk",
        optimize: { compactColorThemes: true },
        themes: {
          default: "light",
          colorScheme: { light: "light", dark: "dark", inheritance: "uniform" },
          entries: [
            { id: "light", entry: "src/themes/light.ts" },
            { id: "dark", entry: "src/themes/dark.ts" }
          ]
        }
      }
    })
  ],
  build: { target: ["chrome123", "firefox120", "safari17.5"] }
});
```

Vite는 `build.cssTarget`이 설정되어 있으면 그 값을 사용하고, 생략하면 `build.target`에서 CSS target을 결정합니다. 최종 CSS target 모두가 위의 최소 버전을 만족해야 합니다. 호환되는 `build.target`을 지정했다면 `build.cssTarget`을 별도로 설정할 필요는 없습니다.

## 측정과 배포

진단의 `bundle-size-*`, `css-observability`, `closed-app-usage`, `css-chunk-optimize`, `css-sharing`에서 적용/보존 이유를 확인합니다. `bundle-size-final`은 최종 asset별 raw/gzip/Brotli, entry의 초기 JS/CSS, HTML, CSS asset 수와 route 누적 추가 전송량을 기록합니다. 중복률은 동일 선언 텍스트의 비율이며 의미상 중복의 완전한 판정은 아닙니다.

라이브러리의 subpath CSS 연결과 CSS side-effect 선언은 유지합니다. native esbuild의 루트 named import가 불필요 CSS를 제거하지 못하는 제한도 유지되므로, 부분 소비에는 subpath import를 사용합니다. 별도 consumer import 재작성은 하지 않습니다.

재현 측정은 `scripts/benchmark-bundle-size.mjs`를 사용합니다. 동일 설치와 toolchain에서 off/on을 최소 5회 교대로 실행하며, 압축은 각 최종 asset에 독립적으로 적용합니다. 결과의 추정 비용과 실제 출력, CPU/벽시계 시간은 서로 다른 지표입니다.

결과는 기본적으로 `.cache/benchmarks/bundle-size-results.json`에 저장합니다.
