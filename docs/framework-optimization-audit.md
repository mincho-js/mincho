# 9개 프레임워크 빌드타임·런타임 최적화 조사

> 보관된 조사 기록입니다. Mincho 비교 기준은 2026-09-23의 전체 개발 스택
> `33911861`이며, 이 문서가 추가되는 PR이나 현재 `main`의 지원 기능 목록이
> 아닙니다. 외부 소스 링크는 조사 당시 커밋으로 고정했습니다.
> 이 PR에 없는 Mincho 소스는 당시 저장소 상대 경로와 라인을 코드로 표시합니다.

조사일: 2026-09-23. 비교 대상 Mincho: `33911861`.

Mincho는 이미 정적 CSS 추출, dependency/AST/evaluation cache, recipe/cx
최적화, styled flatten, 실제 `dist-chunk`, route/layout CSS 공유를 제공한다.
추가 검토의 중심은 **남아 있는 초기화 작업을 빌드로 이동하는 것**, **동일 IR의
반복 작업을 줄이는 것**, **사용이 증명된 범위에서 더 세밀하게 CSS를 줄이는 것**이다.

## 조사 범위와 읽는 방법

3개 subagent가 각각 3개 저장소의 compiler, adapter, runtime, helper와 관련
테스트를 추적했다. 부모 agent는 Mincho의 현재 구현을 직접 확인하고 신규 후보와
기존 구현의 차이를 검토했다. 아래 상세 목록은 독립 메커니즘별 ID, 적용 옵션,
소스 경로·라인, 기대 효과와 제약을 기록한다.

- [StyleX · Griffel · css-hooks 상세 목록](./framework-optimization-audit/atomic-runtime.md)
- [Kuma UI · Panda · Tamagui 상세 목록](./framework-optimization-audit/component-systems.md)
- [WyW-in-JS · UnoCSS · devup-ui 상세 목록](./framework-optimization-audit/compilers.md)
- [Mincho의 기존 구현 27개 비교 항목](./framework-optimization-audit/mincho-baseline.md)

대상은 지정된 로컬 checkout이다. 최신 npm 배포판 전체나 다른 branch의 기능을
의미하지 않는다. 9개 checkout의 tracked 파일이 변경되지 않은 상태를 확인했다.
애플리케이션/라이브러리의 스타일 빌드·배포·실행 비용과 직접 관련된 구현을
목록화했고, 일반 UI 위젯의 개별 알고리즘과 의존 번들러가 자동 제공하는 기능은
프레임워크 고유 최적화로 중복 집계하지 않았다. 문서에만 있는 계획, 연결되지 않은
코드, default와 opt-in은 구분한다.

이번 조사는 소스와 기존 테스트의 정적 검토다. 새 cross-framework benchmark나
각 프로젝트 테스트 실행 결과를 보고하는 것이 아니다. 아래 우선순위는 Mincho에
대한 기술적 판단이며, 실측 속도 순위나 예상 절감률이 아니다.

| 저장소           | 조사 HEAD  | 커밋 날짜  | 빌드 항목 | 런타임 항목 |
| ---------------- | ---------- | ---------- | --------: | ----------: |
| `/tmp/stylex`    | `20f2a50a` | 2026-09-16 |        19 |           8 |
| `/tmp/kuma-ui`   | `05cbbb0b` | 2026-05-29 |        11 |           9 |
| `/tmp/wyw-in-js` | `2ee2b736` | 2026-09-03 |        25 |           2 |
| `/tmp/panda`     | `3464d94f` | 2026-09-18 |        21 |          10 |
| `/tmp/tamagui`   | `3bb99dfb` | 2026-09-17 |        19 |          22 |
| `/tmp/devup-ui`  | `1020168c` | 2026-09-16 |        28 |           7 |
| `/tmp/css-hooks` | `efd4247`  | 2026-09-16 |         2 |           7 |
| `/tmp/griffel`   | `6fe0c78`  | 2026-08-04 |        17 |          12 |
| `/tmp/unocss`    | `93b64209` | 2026-09-17 |        24 |           6 |

검토 항목은 총 **249개(빌드 166, 런타임·산출물 경계 83)**다. 독립 메커니즘과
적용 조건/한계를 추적한 표 항목 수이며, 프레임워크 사이에 중복되는 목적도 있다.
249개의 서로 다른 신규 최적화나 성능 순위를 뜻하지 않는다. Mincho의 기존 구현
27개 비교 항목은 이 합계에 포함하지 않았다.

## 프레임워크별 핵심 차이

개별 최적화의 전체 목록과 근거는 위 3개 상세 보고서에 있다. 이 표는 서로 다른
실행 모델을 구분하기 위한 요약이며, 속도 비교표가 아니다.

| 프레임워크 | 빌드타임                                                                                                                          | 런타임                                                                                                     | Mincho 적용 관점                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| StyleX     | atomic CSS, 정적 props/attrs 병합, 사용하지 않는 JS namespace 정리, static 객체/표현식 hoist                                      | dynamic CSS vars, 제한된 class/prop 병합, CSS 조건 활용                                                    | C01의 compile-time 결과 계산과 C07의 원자 공유 참고. namespace 제거는 CSS purge와 구분 |
| Kuma UI    | literal prop/variant 추출, intrinsic HTML flatten, content hash/dedupe, 선택형 WASM                                               | StaticBox/DynamicBox 분리, dynamic style cache, stylesheet refcount·SSR 재사용                             | flatten/캐시는 기존 구현과 겹침. runtime injection 엔진은 도입 대상 아님               |
| WyW-in-JS  | Oxc·hybrid static eval, 필요한 export만 shake/eval, AST/facts 재사용, VM broker·전송 생략                                         | processor가 정의한 작은 결과물만 남기며 core CSS 생성은 build에서 끝남                                     | C05/C08/C09/C11. 원자화는 core 자체의 보장으로 간주하지 않음                           |
| Panda      | 현재 checkout의 Rust/Oxc extractor, 증분 project/refcount, atomic CSS, 선택형 token/keyframe/compound pruning, build-info hydrate | CSS 생성 없이 class 계산, recipe/css/cx cache, 선택형 transform의 작은 runtime                             | C06/C07/C10. 기본 옵션과 opt-in을 구별                                                 |
| Tamagui    | 정적 추출·flatten·조건 class hoist, worker pool·중복 compilation 공유, theme 생성 축소                                            | 사용한 media/theme 값만 구독, CSS로 처리 가능한 pseudo/group은 JS 생략, 일부 animation은 React commit 우회 | C13. native/theme subscription/animation은 현재 Mincho 기능 범위 밖                    |
| devup-ui   | Rust/Oxc extraction, atomic CSS, route/import graph, 선택형 atomHoist, prewarm/reuse, 저할당 writer                               | 정적 스타일은 제거하고 필요한 class 분기·CSS var·theme 처리만 남김                                         | C03/C07. router 이름보다 실제 import graph와 명시 route/layout에 연결                  |
| css-hooks  | 별도 AST compiler 없이 hook별 조건 CSS와 변수 표현식 구성                                                                         | CSS fallback-variable로 selector 조건 표현, 긴 값의 중복 참조 축소                                         | C12는 의미가 다른 실험. 빌드타임 추출 프레임워크로 분류하지 않음                       |
| Griffel    | legacy Babel AOT와 새 Oxc transform, AST 우선 평가·남은 호출 batch VM, dependency shake·atomic extraction                         | lazy style 해석, merge cache, bucket별 insertion dedupe, RTL·SSR 재사용                                    | C05/C08/C09 참고. 모든 chunk CSS를 entry로 모으는 Vite 정책은 그대로 적용하지 않음     |
| UnoCSS     | token 추출, static rule lookup/negative cache, bounded batch, selector merge, 필요한 theme vars, dist-chunk                       | static integration은 generation runtime 없음. 별도 runtime은 MutationObserver·debounce·style 재사용        | C02/C06/C07. dist-chunk 자체는 Mincho에 이미 있음                                      |

## Mincho에서 이미 제공하는 방향

다음 항목은 새 기능 목록에 다시 넣지 않는다. 정확한 범위와 소스는
[Mincho 비교 기준](./framework-optimization-audit/mincho-baseline.md)을 따른다.

| 영역          | 이미 구현된 것                                                                                        | 아직 같은 것으로 볼 수 없는 것                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 빌드 캐시     | AST/summary, transform, file/hash, disk, 평가 결과, pending 공유와 selective invalidation             | 캐시가 항상 cold build도 빠르게 한다는 보장                                    |
| 평가          | lexical binding 기반 static helper 평가, 순수 함수 memo, guarded VM reuse                             | 모든 authoring API의 VM 없는 정적 해석                                         |
| 병렬화        | CPU budget, bounded worker pool, optional I/O cap                                                     | compiler worker의 자동 기본 활성화                                             |
| 원자 CSS      | `defineRules`의 요청된 write 생성, fragment cache, preset DAG hydration                               | 일반 `css()`까지 전역 원자화하거나 서로 다른 owner의 rule을 자유롭게 합치는 것 |
| class 계산    | recipe constant folding, bounded branch/table, literal cx, adaptive recipe/cx cache, numeric write ID | scoped cx 조건 table의 모든 initializer를 빌드 중 문자열로 고정하는 것         |
| React 비용    | styled flatten/chain collapse, prop partition, JSX guard 특수화                                       | 모든 exported component/ref/as/unknown spread의 wrapper 제거                   |
| runtime bytes | 순수 runtime subpath, helper/recipe metadata liveness, props mapper 분리                              | CSS selector·theme token·variant rule 전체의 사용 여부 분석                    |
| dynamic 값    | CSS vars, primitive writer 축소, opt-in non-inheriting private vars                                   | css-hooks 방식의 모든 boolean 조건을 CSS 변수로 평가하는 것                    |
| CSS 로딩      | native/single/dist-chunk, generic route/layout, library sidecar+subpath                               | rule 단위 route hoist 또는 unused CSS purge                                    |

## 추가 적용 후보

`우선 실험`은 현재 구조에서 비교적 작은 단위로 차이를 측정할 수 있다는 뜻이다.
새 API나 의미 변경을 바로 기본값으로 넣자는 뜻은 아니다. 모든 후보는 현재
HEAD와 비교하고, 같은 의미의 기존 최적화에 대한 추가 이득만 측정한다.

| ID  | 후보와 참고 구현                                                                      | Mincho에 추가할 정확한 범위                                                                                                                  | 기대 지표                                       | 우선순위 / 비용                                            |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| C01 | scoped cx 조건 table의 빌드타임 결과 계산 — StyleX의 props/attrs 정적 병합            | 이미 생성하는 table의 `cx(...)` initializer를 증명된 immutable artifact로 미리 계산. 이후 불필요한 cx factory와 metadata도 제거              | 초기 JS 실행, JS bytes, 첫 호출 비용            | **우선 실험**, 중간                                        |
| C02 | 순수 CSS IR 직렬화 결과의 bounded memo — UnoCSS generator cache의 원칙                | `generateVanillaCss(artifact)` 결과만 artifact/config/version key로 재사용. sharing preview·multi-output·watch 반복 직렬화를 줄임            | CSS 생성 시간, 할당, cache RSS                  | **우선 실험**, 작음~중간                                   |
| C03 | IR 경로의 반복 순회·문자열/배열 할당 축소 — devup-ui의 writer/정렬 준비               | collection/isolation/hash/serialization에서 같은 selector 정보나 canonical data를 반복 만드는지 측정 후 제거. 출력 bytes/order는 그대로 유지 | 빌드 CPU·peak RSS                               | **우선 실험**, 작음~중간                                   |
| C04 | 동작별 eligibility·bailout·cache 비용 진단 — WyW/Griffel/UnoCSS                       | 기존 phase trace에 새 후보의 적중 수, 우회 사유, 입력 크기, 절감한 작업을 기록                                                               | 다른 최적화의 검증 가능성                       | **C01~C03과 함께**, 작음. 자체 속도 개선으로 집계하지 않음 |
| C05 | 사용 export 중심 evaluation graph·안전한 barrel 경로 단축 — WyW/Griffel               | 기존 export/member fingerprint를 보완해 fresh evaluation에서도 필요한 dependency slice만 준비. side-effect import와 CJS 모호성은 보존        | 대형 token/barrel cold build·dependency edit    | **다음 단계**, 큼                                          |
| C06 | token/keyframe/recipe CSS의 사용 여부 추적 — Panda/UnoCSS                             | compiler 소유의 닫힌 사용 그래프에 한해 theme variable reference closure, keyframe 참조, 선택된 variant/compound CSS 제거                    | initial/total CSS, CSS parse                    | **다음 단계**, 큼. JS DCE와 별도                           |
| C07 | 조건·출처·사용 route를 포함하는 atomic IR 공유 — devup-ui/StyleX/Griffel/UnoCSS/Panda | 이미 atomic인 `defineRules`부터 cross-owner reuse, 안전한 인접 rule 합치기, 공통 route의 atom 승격을 각각 실험                               | 중복 CSS, 초기/세션 전송량, 요청 수             | **다음 단계**, 큼. 한 번에 전역 원자화하지 않음            |
| C08 | 알려진 token/processor의 symbolic static semantics — WyW/Griffel/StyleX               | package identity·version·binding이 증명된 참조를 직접 CSS var/static data로 바꿔 dependency 실행을 생략                                      | VM fallback 횟수, token-heavy build             | **조건부 실험**, 큼                                        |
| C09 | read-only 분석의 Oxc/native front-end — WyW/Griffel/Panda/devup-ui                    | import/export/candidate facts 등 좁은 경로를 교체하고 Babel transform은 fallback으로 유지                                                    | cold parse/analysis 시간, RSS                   | **중장기**, 큼. 이중 파싱 비용 확인                        |
| C10 | consumer용 versioned style/build IR 배포 — Panda                                      | 사내/동일 toolchain에서 recipe/atom/token metadata hydrate 및 사용 subpath 기준 좁히기. 현행 sidecar를 범용 fallback으로 유지                | consumer build 시간·CSS                         | **중장기**, 큼. 별도 배포 계약                             |
| C11 | worker/VM broker의 batching·전송·수명 관리 — WyW/Tamagui                              | 명시적 worker의 source digest handshake·batching·장기 메모리 수명 검토. generation·registry·provider 순서 계약 유지                          | worker overhead·IPC bytes                       | **병목 확인 후**, 중간~큼                                  |
| C12 | CSS 변수 기반 조건 평가 — css-hooks                                                   | 제한된 boolean/pseudo 조건의 class branch와 CSS fallback-variable 표현을 비교하는 별도 실험                                                  | JS branch/HTML class bytes와 browser style 비용 | **낮음**, 의미·상속·브라우저 비용 검증 필요                |
| C13 | theme 값 interning·동일 theme 선언의 selector 공유 — Tamagui                          | compiler 소유의 닫힌 theme에 한해 동일 값 저장 및 동일 선언 출력의 중복 축소. public variable 이름과 개별 override는 보존                    | theme 생성·CSS/JS bytes                         | **낮음**, 중간~큼. 값이 같아도 변수의 의미는 다를 수 있음  |

### C01: 기존 조건 table을 한 단계 더 정적으로 만들기

현재 [createTableExpression](../packages/babel/src/defineRulesCxConditionsCodegen.ts)은
최대 4개 조건의 각 조합을 `cx(...)` 호출로 담는다. 따라서 반복 render에서는
table lookup만 하더라도 모듈 로드 때 병합을 수행한다. 이 점은 이미 구현된
generic literal `cx` folding과 구분한다.

추가 pass는 알려진 compiled cx artifact와 원시 class string만 받아 결과를
계산해야 한다. getter, mutable public factory, user class의 평가, 조건의 실행
순서와 short-circuit은 보존한다. 결과를 굳힌 뒤 helper liveness를 다시 계산해야
초기화 코드와 metadata의 실제 전송량까지 줄일 수 있다. 표가 커져 gzip/Brotli가
오히려 증가할 수 있으므로 조건 수뿐 아니라 직렬화 bytes 예산도 유지한다.

### C02~C03: CSS 결과를 바꾸지 않는 빌드 비용 축소

현재 distChunkCss.ts (`packages/vite/src/distChunkCss.ts:140`)는
선택적 sharing preview와 output 생성에서 같은 순수 serializer를 호출한다.
IR cache는 이미 있지만 serializer 결과 cache와는 다르다.

Memo의 첫 범위는 **PostCSS 이전 CSS 문자열**이다. Vite transform이나 최종
asset 결과까지 캐시하면 PostCSS의 외부 입력, watch dependency, URL 기준 경로,
output별 asset emission을 놓칠 수 있다. cache key는 collection에서 만든 content ID를 재사용하고 origin/fileScope/composition과
serializer version이 포함되는지 확인한다. key 계산을 위한 재직렬화 비용도 측정한다.
원본 IR을 clone하는 이유가 upstream serializer의 mutation이므로, copy 제거 역시
소유권 증명 없이 수행하면 안 된다.

C03은 이런 경계를 지키면서 selector facts의 중복 수집, composition의 반복
reverse/RegExp 생성, sort/hash/stringify, 불필요한 중간 배열을 profile로 찾는
작업이다. composition replacement 순서는 보존한다. Rust writer 구현을 JS에
그대로 옮기면 빨라진다는 가정은 하지 않는다.

집계가 이후에도 병목이면 Panda의 owner/refcount 기반 dirty artifact graph를
참고해 재집계 범위를 좁힌다. Mincho가 이미 보유한 dependency invalidation과
unchanged IR retention에 더해 무엇을 생략하는지 먼저 구분해야 한다.

### C05~C08: 더 큰 CSS·dependency graph 변경

- **CSS liveness:** 실제 JS 사용만으로 외부 CSS의 `var(--token)`, public class,
  animation shorthand, `globalCss`, dynamic selection의 부재를 증명할 수 없다.
  closed local consumer 또는 명시적 consumer build 계약에서 시작하고,
  unknown/escape/safelist는 보존한다. UnoCSS wind4의 private custom property
  initializer/helper CSS 수요 추적도 별도 하위 사례다.
- **원자 공유:** `defineRules`의 canonical atom/condition/property 정보를
  활용한다. layer/selector/specificity/fallback 선언/URL 출처/순서가 같은지
  검증하고, 파일·cascade barrier를 넘는 병합은 별도 증명이 필요하다.
  최종 bundler minifier가 이미 하는 병합인지 확인해 추가 이득만 측정한다.
  extraction 이전에 정해지는 global identity 정책과 transform 순서에 무관한
  이름 안정성도 확인한다.
- **route 비용:** shared 파일을 늘리면 초기 bytes·request·preload metadata가
  늘 수 있다. 공통 방문 route에서 얻는 전송 이득과 함께 판단한다.
  기존 generic route/layout 목록을 유지하고 특정 router 파일명을 기본 가정하지 않는다.
- **barrel/evaluation:** 사용하지 않는 export 변경 때 cache를 보존하는 기존
  기능과, 첫 빌드에서 사용하지 않는 dependency의 분석·실행을 생략하는 기능은
  다르다. ESM/CJS 부작용과 registry 순서를 같이 검증한다.
  export demand가 합쳐지거나 넓어져 재분석되는 횟수도 진단한다.
- **symbolic 평가:** `tokens`라는 변수명이나 import 문자열만 보고 특별 취급하지
  않는다. 실제 binding, package 구현/프로토콜과 파일 scope를 증명한다.
  WyW의 사용자 선언 `staticBindings` opt-in은 순수성을 신뢰하는 계약이므로
  자동 증명과 구별한다.

C11의 참고 구현에서 WyW microtask batching은 단일 VM runner의 **순차 batch**다.
그 자체가 parallel worker pool은 아니다. source 전송 생략도 hash 일치 외에
module ID, 요청 export 집합, session generation, ACK/reset/eviction까지 맞춰야 한다.
Tamagui의 장기 worker 교체 정책도 참고할 수 있으나, Mincho의 실제 장기 세션 RSS와
재초기화 비용을 측정한 뒤 적용한다. 진행 중인 provider/registry 작업을 끊어서는 안 된다.

## 그대로 적용하지 않을 접근

| 접근                                                              | 이유 / 유지할 대안                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| runtime 스타일 삽입 엔진·DOM 전체 스캐너 도입                     | Kuma/Griffel/UnoCSS runtime에는 필요한 비용 절감이지만 Mincho 기본 경로는 CSS asset 추출이다. 동일 목적의 새 runtime을 추가하지 않음 |
| 모든 chunk CSS를 entry에 합치기                                   | 순서 관리에는 도움이 되지만 route lazy CSS의 초기 다운로드 이점을 잃음. 현재 native/single/dist-chunk 선택을 유지                    |
| `css()` 전체의 강제 원자화·전역 equal-rule dedupe                 | scoped class·일반 cascade·keyframe/global rule·debug identity 계약과 다름. C07은 증명된 atomic 범위부터                              |
| 사용자 style 객체의 identity만으로 cache hit                      | mutable input/getter/`.with()` 호출 관측을 바꾸므로 current normalized cache보다 무조건 낫지 않음                                    |
| 무제한 runtime/build cache                                        | 반복 작업은 줄어도 긴 dev/SPA 세션과 SSR 메모리가 누적됨. bounded·환경별·generation별 정책 유지                                      |
| TypeScript annotation이나 이름만으로 정적 값 판정                 | 실제 JS binding/값/효과의 증명이 아님. 현재 conservative bailout 유지                                                                |
| 모든 recipe 조합 선생성                                           | variant×compound 조합 폭증과 CSS/JS table 증가. 관측되거나 작은 닫힌 branch만 계산                                                   |
| Rust/WASM·worker를 무조건 기본값으로 적용                         | 초기화·IPC·이중 parsing·배포 비용이 있음. 실제 Mincho fixture에서 통과한 경로만 확대                                                 |
| native esbuild root named import를 소비자 전용 변환으로 강제 보정 | 이번 비교가 기존 배포 범위를 변경하지 않음. 앞서 결정한 subpath 최적화 보장과 native 제약 문서화를 유지                              |

## 후보를 채택하기 위한 측정

비교 기준은 현재 Mincho HEAD이며, cache가 없던 과거 구현으로 바꿔 잡지 않는다.
첫 실험은 C01, C02, C03을 각각 분리한 candidate로 하고 C04 진단을 같이 기록한다.

1. 빌드: fresh process/cold, unchanged rebuild, 사용 token edit, 미사용 token edit,
   warm disk restart, client+SSR을 분리. wall time·peak RSS·parse/eval/serialize 횟수 확인.
2. 런타임: module initialization, 첫 호출, 반복 hit, 낮은 reuse, 큰 recipe,
   긴 cx, mutable/getter/callback 입력. latency와 allocation/retention을 함께 확인.
3. 번들: initial JS/CSS와 전체 session 전송량, 파일별 gzip/Brotli 합,
   chunk/request/preload 수, route 전환과 cache hit. CSS bytes 감소만으로 채택하지 않음.
4. 의미: emitted CSS 순서, forward/reverse route 방문, SSR/hydration markup,
   class 문자열·unknown class·ref/as·prop 평가 순서, HMR edit/delete/error recovery.
5. 배포: ESM/CJS, Vite/esbuild, standalone/installed npm/strict PnP, subpath,
   multi-output/source map과 지원 adapter version.

기존 benchmark/contract harness를 확장하면 된다. 정확성 차이가 없고 대상
workload의 추가 이득과 비용이 측정된 후보부터 채택한다. 이 문서는 조사 결과이며,
후보 구현이나 기본값 변경은 포함하지 않는다.
