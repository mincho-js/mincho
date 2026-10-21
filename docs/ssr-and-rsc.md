# SSR CSS와 React Server Components

KU-R05·KU-R01의 적용 경로와 TA-R02의 선택적 memo 사용법이다. 기존 CSS 추출과 runtime의 기본 동작은 유지한다. SSR 지원은 명시적으로 활성화한다.

## Client build에서 CSS manifest 생성

```ts
minchoVitePlugin({
  appCss: {
    mode: "dist-chunk", // native와 single도 지원
    ssrManifest: true,
    routes: [
      {
        id: "dashboard",
        entry: "./src/pages/dashboard.tsx",
        layouts: ["./src/layout.tsx"],
      },
    ],
  },
});
```

Client build는 `.vite/mincho-css-manifest.json`을 출력한다. `ssrManifest: "server-assets/css.json"`처럼 출력 경로를 지정할 수도 있다. 서버 build에는 manifest를 생성하지 않는다. library build에서는 사용할 수 없다.

Manifest는 `version`, `base`, `entries`, `modules`, `routes`를 포함한다. Entry/module ID는 Vite root에 상대적인 경로이고 route ID는 지정한 문자열이다. Entry는 HTML/JS 원본 경로와 최종 chunk 파일명으로 선택할 수 있다. CSS 목록은 최종 static import graph의 dependency 순서와 chunk의 CSS 순서를 보존한다. 이미 route의 static graph에 들어 있는 layout은 다시 앞에 삽입하지 않는다. JS가 지워진 CSS-only layout도 entry의 graph를 통해 처리한다. 독립적으로 렌더하는 layout은 목록의 바깥쪽→안쪽 순서로 선택된다.

MPA의 다른 entry와 선택하지 않은 dynamic import는 자동으로 포함하지 않는다. `single` 모드는 하나의 CSS에 포함된 다른 route의 rule까지 제거할 수 없다. 명시한 route/layout이 client 출력에서 확인되지 않으면 누락된 CSS를 조용히 반환하지 않고 build를 실패시킨다.

`experimental.renderBuiltUrl`은 지원하지 않는다. 임의의 runtime URL 변환을 서버에서 추측하지 않는다. Unsplit CSS에 여러 별도 CSS asset을 추가하는 plugin 구성 역시 단일 asset을 식별할 수 없으면 실패한다.

## Framework에 종속되지 않는 서버 수집

`@mincho-js/vite/ssr`는 Vite/Node build runtime을 가져오지 않는 ESM/CJS subpath이다. 파싱한 manifest를 다음 함수에 전달한다.

```ts
import {
  createSsrCssCollector,
  resolveSsrStylesheets,
  type MinchoSsrCssManifest,
} from "@mincho-js/vite/ssr";

const links = resolveSsrStylesheets(manifest, {
  entries: ["index.html"],
  routes: ["dashboard"],
  modules: [], // 렌더 중 발견한 추가 lazy module
});
// [{ rel: "stylesheet", href: "/app/assets/layout-….css", crossOrigin: "" }, …]
```

문서에 해당하는 초기 entry를 명시한다. 같은 파일의 중복은 제거하지만 반환 순서는 유지한다. 전체 배열을 파일명으로 정렬하지 않는다. 알 수 없는 ID는 오류다. 이 함수는 상태를 소비하지 않으므로 React render가 재시도되거나 중단되는 경우에도 사용할 수 있다.

반환된 href는 Vite helper와 같은 base 표기를 사용한다. 고정 base는 `/app/assets/…`, CDN base는 해당 URL이다. `base: "./"` 또는 빈 base에서는 세 번째 인자로 `{ assetBaseUrl: "https://example.com/app/" }`를 전달한다. 이는 client 출력 디렉터리의 공개 HTTP(S) URL이며 마지막에 `/`를 포함해야 한다. Nested MPA의 HTML 경로나 현재 SSR route URL 대신 출력 root를 지정하므로, 페이지 깊이가 달라도 같은 asset을 가리킨다.

서버가 직접 응답을 출력하는 경우 요청별 collector를 사용할 수 있다.

```ts
// 요청마다 생성한다. 하나의 HTML 문서 안의 여러 root만 공유할 수 있다.
const css = createSsrCssCollector(manifest);
css.collect({ entries: ["index.html"], routes: ["dashboard"] });
const firstLinks = css.flush();

// Stream 후반에 새로 렌더된 module을 발견했을 때
css.collect({ modules: ["src/widgets/chart.tsx"] });
const additionalLinks = css.flush();
```

`collect()`는 발견한 resource를 기록하고 전체 목록을 반환한다. `flush()`는 아직 응답 writer에 전달하지 않은 목록만 반환하고 전달된 것으로 기록한다. 이는 브라우저의 load 완료 표시가 아니다. React component의 render 중에 `flush()`를 호출하지 않는다. DOM 준비 상태와 stream reveal은 사용하는 framework의 resource mechanism과 연결한다. 전체 요청에 공유되는 전역 collector는 두지 않는다.

## 이미 삽입된 CSS와 route 전환

이미 DOM에 있는 stylesheet는 Vite나 React가 삽입 주체의 load 상태를 알 수 없는 경우가 있다. Framework가 이 상태를 관리하지 않는 route handoff에서는 선택적인 browser helper로 완료를 기다린다.

```ts
import { loadStylesheets } from "@mincho-js/vite/css-loading";

const links = resolveSsrStylesheets(manifest, { routes: [routeId] });
const [, page] = await Promise.all([
  loadStylesheets(links, { signal: navigationSignal }),
  loadRoute(),
]);
// 여기서 page를 commit한다.
```

이 helper는 canonical URL로 이미 로드된 stylesheet와 진행 중인 요청을 재사용한다. 기존 href attribute도 Vite와 같은 표기로 맞춘다. Preload만 있는 경우 실제 stylesheet를 별도로 적용한다. CSS를 생성하거나 unmount 시 제거하지 않는다.

실패는 Promise rejection으로 전달한다. 다음 호출은 helper가 실패를 관찰한 링크를 교체해 재시도할 수 있다. 이미 실패 이벤트가 지나간 외부 링크도 무한히 기다리지 않도록, 새로 관찰하는 resource에는 기본 30초 timeout이 있다. `timeoutMs`로 바꿀 수 있으며 같은 링크를 기다리는 호출은 최초 관찰 시 만든 Promise와 timeout을 공유한다. 빈 시트나 opaque 시트의 완료 이력을 확인할 수 없으면 성공으로 추측하지 않고 이벤트 또는 timeout을 기다린다. `signal` 취소는 해당 호출의 대기만 중단하고 다른 root의 resource는 제거하지 않는다.

Manifest 전체를 client에 전달할 필요는 없다. 서버에서 선택한 descriptor만 전달하거나 client에 필요한 route 목록만 제공하면 build module 경로와 불필요한 metadata 전송을 줄일 수 있다.

## React 19: stylesheet readiness와 Suspense

React 19 이상에서는 별도 stylesheet resource adapter를 사용한다.

```tsx
import { Stylesheets } from "@mincho-js/react/stylesheets";
import { resolveSsrStylesheets } from "@mincho-js/vite/ssr";

function Route({ manifest, routeId, children }) {
  const links = resolveSsrStylesheets(manifest, {
    entries: ["index.html"],
    routes: [routeId],
  });
  return (
    <>
      <Stylesheets stylesheets={links} precedence="mincho" />
      {children}
    </>
  );
}
```

SSR과 hydration에 같은 manifest·선택·precedence를 사용한다. React가 stylesheet를 head에 배치하고 중복을 제거하며, 로드 완료를 Suspense의 commit과 연결한다. `onLoad`/`onError`는 React의 resource 처리를 비활성화하므로 이 adapter에서 공개하지 않는다. 로드 실패 UI는 앱의 error boundary와 framework가 처리한다. Mincho가 자동 retry·cache busting·CSS 제거를 추가하지는 않는다.

`precedence` 그룹 순서는 최초 출현 순서이며 이름의 사전순이 아니다. Framework가 이미 stylesheet resource를 관리한다면 반환된 descriptor를 그 경로에 전달한다. SSR HTML template에서 CSS를 별도로 출력하면서 React에도 같은 CSS를 다시 출력하게 하는 중복 관리는 피한다.

Adapter를 사용하지 않는 기존 React peer 범위는 바뀌지 않는다. `Stylesheets` 자체를 React 18 이하에서 실행하면 명시적으로 오류를 발생시킨다.

## UI library의 client 경계

Mincho의 class 선택 runtime은 추가 `react-server` entry 없이 React 19.2.6 Flight renderer를 통과한다. 동적인 variant 값만으로 styled component 전체를 Client Component로 만들 필요는 없다. Event·ref·hook에는 React/RSC 본래 제약이 적용된다.

Vite library build에서 작성자가 선언한 `"use client"`를 보존하려면 client module을 명확한 entry로 분리한다.

```ts
export default {
  plugins: [minchoVitePlugin({ libraryRsc: true })],
  build: {
    cssCodeSplit: true,
    lib: {
      entry: {
        server: "src/server.ts",
        button: "src/button.tsx", // 파일 첫머리에 "use client"
      },
      formats: ["es", "cjs"],
    },
  },
};
```

`libraryRsc` 기본값은 false다. 활성화하면 client entry의 directive를 CSS import보다 앞에 복원한다. Minification 이후와 ESM/CJS에서 검증한다. `preserveModules`로 경계를 남기는 구성도 지원한다.

Client module이 선언되지 않은 server chunk에 합쳐지면 오류를 발생시킨다. Chunk 전체에 임의로 `"use client"`를 붙이지 않는다. `"use server"`의 server action 변환은 framework의 역할이므로, 이 option의 대상에 포함되면 지원하는 pipeline을 사용하도록 오류를 발생시킨다.

이 option은 Next.js 등의 framework adapter나 server action compiler가 아니다. 검증 대상은 실제 Flight wire 출력, Vite SSR/streaming/hydration, package 경계다. 사용하는 RSC framework의 client bundle 크기는 해당 consumer에서도 확인한다. Native esbuild의 root named import CSS 제거 제한은 그대로이며 library consumer에는 subpath import를 권장한다.

## TA-R02: 명시적인 memo

`$$styled`의 기본 동작과 ref forwarding은 변경하지 않는다. 공개 mutable recipe를 자동으로 memo 처리하지 않는다. Stable props가 많은 component에서 사용자가 선택할 수 있다.

```tsx
import { memo } from "react";
import { styled } from "@mincho-js/react";

const Button = styled.button({
  base: { padding: 8 },
  variants: { size: { small: { padding: 4 }, large: { padding: 12 } } },
});

export const MemoButton = memo(Button);
```

같은 props에 같은 출력을 만드는 component에 적용한다. Recipe config를 외부에서 변경한 뒤 같은 props로 다시 렌더링하는 설계에는 적용하지 않는다. 매번 새로운 style 객체·callback·JSX child를 전달하면 bailout이 되지 않아 비교 비용이 추가될 수 있다. React Compiler가 이미 최적화하는 consumer에서는 추가 효과를 측정한다.

선택적 memo에서 ref·`as`·variant 변경이 유지되는 것과 기본 runtime이 mutable config의 변경을 반영하는 것을 소비자 테스트로 확인한다. React 19 전용 ref 생략이나 자동 compiler memo option은 추가하지 않았다.

## 검증

- Vite native build: native/dist-chunk/single, 여러 page entry, CSS-only layout, client entry, ESM/CJS minification, preserveModules, 혼합 경계 거부.
- Request collector: 독립적인 여러 요청, 공유 resource, stream 추가 출력, 알 수 없는 ID, 상대 base/CDN, 순서.
- Installed consumer: 새 subpath의 ESM/CJS와 타입, React Flight styled/variant/CSS prop/client reference, ref/event 제약.
- Chromium을 지정한 consumer: SSR/hydration, 지연된 CSS와 commit, a→b→a, 실제 streaming response, 명시적 memo와 ref/`as`.

2026-09-25에 Node 24.21.0에서 release build, Vite·React 테스트, 타입·lint 검사를 통과했다. 실제 tarball을 설치한 npm과 strict Yarn PnP 소비자에서 전체 package contract를 실행했으며, 두 환경 모두 Chromium의 native/dist-chunk SSR·streaming 검사와 React 19.2.6 Flight 검사를 통과했다.

```sh
TMPDIR=/var/tmp MINCHO_BROWSER_BINARY=/usr/bin/chromium yarn check:package-contract
```
