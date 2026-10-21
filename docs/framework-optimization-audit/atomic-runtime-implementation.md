# Atomic/runtime 감사 구현 대응

기준 커밋은 `c9298a76`이다. 원본 감사의 `33911861` 이후 완료된 compiler
최적화는 기존 구현으로 구분한다. C-A01·02·03·04·06을 적용하고, 사용자 선택에
따라 C-A05 native parser는 제외한다. 모든 신규 옵션은 기본 비활성이다.

사용법과 제한은 [atomic/runtime 옵션](../atomic-runtime-optimizations.md)에 정리한다.
`부분`은 공개 opt-in의 증명 가능한 범위만 구현했다는 뜻이며, 해당 프레임워크의
전체 기능이나 동일한 성능을 보장한다는 뜻이 아니다.

## 후보

| 후보  | 결과                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------- |
| C-A01 | scoped cx의 직접 호출·기존 조건 테이블 bake, 실제 runtime 재사용, 공유 payload 예산, CSS 연결 보존 |
| C-A02 | 실제 생성 변수의 primitive export 참조 artifact, 직접 참조 분석 재사용, producer CSS 재생 유지     |
| C-A03 | private owner 사이의 같은 파일 조건부 atom 공유; 충돌·공개/merge 관찰·파일 경계 fallback           |
| C-A04 | 기존 diagnostics에 최적화 결과와 fallback·reachability·cache 작성 원인 추가                        |
| C-A05 | 제외: native parser·resolver 의존성 추가 없음                                                      |
| C-A06 | 기존 JSX css 조건식의 제한된 boolean gate 및 실제 이름 기준 반복식 인수분해                        |

## StyleX — 27개

| ID     | 상태            | Mincho 대응                                                                 |
| ------ | --------------- | --------------------------------------------------------------------------- |
| SX-B01 | 기존            | 번들러 filter와 source preflight                                            |
| SX-B02 | 기존            | 제한된 AST 평가, source/구문 cache, 순환·예산 제한                          |
| SX-B03 | 부분 / C-A02    | 변수 이름을 바꾸지 않는 검증된 primitive 참조; mutable theme container 제외 |
| SX-B04 | 기존            | build-time extraction과 sidecar serialization                               |
| SX-B05 | 확장 / C-A03    | 같은 파일의 조건·layer를 포함한 private atom identity                       |
| SX-B06 | 부분 / C-A03    | 안전한 domain 안에서 중복 atom 제거; 일반 CSS 전역 재정렬 제외              |
| SX-B07 | 기존            | scoped cx의 numeric write ID와 serialized artifact                          |
| SX-B08 | 신규 / C-A01    | 실제 cx 구현으로 호출·테이블 항목을 빌드 시 계산                            |
| SX-B09 | 기존            | JSX/styled의 정적 속성 및 guard 제거 경로                                   |
| SX-B10 | 확장 / C-A01    | 불필요한 private factory/helper 제거; CSS effects 유지                      |
| SX-B11 | 기존            | 정적 스타일 추출과 동적 leaf 변수 분리                                      |
| SX-B12 | 부분            | 기존 정적 평가·theme 참조; 별도 defineConsts API 제외                       |
| SX-B13 | 부분            | 기존 cascade 순서 보존; StyleX 전역 priority sorting 제외                   |
| SX-B14 | 기존            | 번들러 CSS assets와 native URL 처리                                         |
| SX-B15 | 기존            | generation별 artifact/provider replay                                       |
| SX-B16 | 기존            | compiler/config/input fingerprint와 검증된 disk cache                       |
| SX-B17 | 기존            | 입력 snapshot·변경/삭제 무효화와 bounded workers                            |
| SX-B18 | 부분            | 환경별 cache/diagnostics; entry 전체 CSS 집계는 도입하지 않음               |
| SX-B19 | 확장 / C-A01·02 | 값 import를 제거해도 producer CSS import 유지                               |
| SX-R01 | 기존            | bounded scoped cx와 compiled recipe runtime                                 |
| SX-R02 | 기존            | dynamic scalar CSS variables; 값별 rule injection 없음                      |
| SX-R03 | 기존            | opt-in nonInheritingCssVars의 self-consumption 증명                         |
| SX-R04 | 기존            | theme vars·class 및 typed theme 계약                                        |
| SX-R05 | 제외            | runtime stylesheet injection 불필요                                         |
| SX-R06 | 제외            | 새 root/shadow stylesheet manager 범위 밖                                   |
| SX-R07 | 제외            | runtime constant rule update engine 범위 밖                                 |
| SX-R08 | 확장 / C-A01    | ESM/CJS·runtime subpath와 opt-in compiled cx PURE annotation                |

## Griffel — 29개

| ID     | 상태         | Mincho 대응                                                     |
| ------ | ------------ | --------------------------------------------------------------- |
| GR-B01 | 기존         | 번들러 filter·preflight                                         |
| GR-B02 | 제외 / C-A05 | OXC parser/range editor 도입 안 함                              |
| GR-B03 | 부분         | 기존 AST evaluator와 fallback; native evaluator 교체 없음       |
| GR-B04 | 부분 / C-A02 | binding·producer·compiler 증명, 이름만으로 토큰 치환하지 않음   |
| GR-B05 | 기존         | sidecar 단위 평가와 선택적인 staticStyles 경로                  |
| GR-B06 | 기존         | opt-in closed dependency/member slicing                         |
| GR-B07 | 기존         | semantic dependency·구문·evaluation cache                       |
| GR-B08 | 진단 / C-A04 | 작성량/재사용을 관찰; owner replay의 일괄 제거 없음             |
| GR-B09 | 제외         | native resolver 대신 기존 bundler/PnP resolver 유지             |
| GR-B10 | 확장 / C-A03 | conflict write ID와 atom identity 분리 유지                     |
| GR-B11 | 부분 / C-A03 | 같은 파일의 중복만 공유; 전역 text dedupe/정렬 제외             |
| GR-B12 | 제외         | 별도 LTR/RTL 스타일 엔진 범위 밖                                |
| GR-B13 | 기존         | build-time authoring 평가와 compiled runtime artifact           |
| GR-B14 | 기존         | 별도 CSS asset 및 compiled runtime subpath                      |
| GR-B15 | 부분         | JS→CSS sidecar 연결; lazy CSS의 entry 강제 집계 제외            |
| GR-B16 | 기존         | CSS side effects·asset URL·library subpath 계약                 |
| GR-B17 | 확장 / C-A04 | AST/VM·CJS·export-star 및 후보별 결과 진단                      |
| GR-R01 | 부분         | 기존 compiled cx lazy indexes/cache; directional renderer 없음  |
| GR-R02 | 기존         | segment marker와 numeric write metadata                         |
| GR-R03 | 기존         | bounded tuple/write/fragment cache; unbounded sequence map 제외 |
| GR-R04 | 기존         | scalar/unknown-class fast paths와 token span merge              |
| GR-R05 | 부분         | 일반 CSS class와 opt-in compileClass; reset bucket API 제외     |
| GR-R06 | 제외         | renderer insertion cache 도입 안 함                             |
| GR-R07 | 제외         | browser insertRule engine 도입 안 함                            |
| GR-R08 | 제외         | runtime bucket stylesheet 관리 도입 안 함                       |
| GR-R09 | 부분         | static CSS asset SSR; runtime sheet serializer 불필요           |
| GR-R10 | 제외         | runtime injection hydration 불필요                              |
| GR-R11 | 제외         | useInsertionEffect renderer 불필요                              |
| GR-R12 | 기존         | production 출력·ESM/CJS·pure runtime exports                    |

## CSS Hooks — 9개

| ID     | 상태         | Mincho 대응                                                           |
| ------ | ------------ | --------------------------------------------------------------------- |
| CH-B01 | 부분         | 기존 CSS/defineRules 타입; 새 conflict type engine 제외               |
| CH-B02 | 기존         | ESM/CJS·type exports·runtime subpath                                  |
| CH-R01 | 실험 / C-A06 | 요소별 CSS gate, inline private variables, listener/injection 없음    |
| CH-R02 | 부분 / C-A06 | 기존 createVar naming 재사용; 별도 selector hash API 없음             |
| CH-R03 | 실험 / C-A06 | 기존 완전한 조건식에서 fallback 표현식 생성; 새 boolean 작성 API 없음 |
| CH-R04 | 실험 / C-A06 | 반복식의 선언+참조 비용 감소 때만 factor; 32자 기준 미복제            |
| CH-R05 | 기존         | 기존 branch/nullish 처리 유지; 불완전 gate branch는 fallback          |
| CH-R06 | 기존         | 소비자 번들러의 CSS/JS minification                                   |
| CH-R07 | 부분         | 기존 vx/stringification 유지; gate의 동적 값은 현재 fallback          |

합계: StyleX 27 + Griffel 29 + CSS Hooks 9 = **65개**.

## 검증

- Babel 834개, CSS 526개(기존 skip 1개), integration 442개, esbuild 131개,
  Vite 240개 테스트를 검증했다. Vite의 신규 기본 옵션 기대값을 수정한 뒤 해당
  테스트를 다시 실행했다. 추가 진단 계측은 관련 20개 테스트로 재검증했다.
  Vite 가상 sidecar에서 정적 cx operand를 읽는 회귀 수정은 integration 42개 및
  Babel 5개 관련 테스트와 설치 패키지 fixture로 확인했다.
- release 빌드 15개 task, TypeScript 검사, 변경 패키지 ESLint, workspace 참조 검사,
  PnP doctor를 통과했다. 기존 compiler transport fixture의 `loader: "ts"`를
  Webpack loader로 오인한 doctor 진단에는 파일·구문·개수·만료일을 지정한 예외를 추가했다.
- 설치된 npm 및 strict Yarn PnP 소비자에서 ESM/CJS, worker, cache,
  SSR 및 기존 CSS 배포 계약을 검증했다. native esbuild root named import의
  전체 CSS 유지 제한과 subpath 최적화 계약은 유지한다.
- Chromium에서 SSR HTML, hydration, 반대 상태인 부모/자식, 상태 전환, 포커스,
  반복식 공유, 조건식/속성 평가 순서를 확인했다.

성능 비교는 기준 커밋 `c9298a76`의 독립 checkout에서 만든 설치 패키지를 사용한다.
[옵션별 5회 paired 측정](atomic-runtime-results.md)에는 신규 옵션을 모두 끈 경우,
각 옵션 단독 적용, 전체 적용을 분리한다. 측정 중에는 테스트·설치·빌드를 병행하지
않고, 진단 수집은 별도 실행한다. helper 제거와 절대 전송량, 브라우저 업데이트
비용은 서로 다른 지표이며 하나의 속도 개선 수치로 합산하지 않는다.

## 실측 결과

기준은 `c9298a76`, Node 24.21.0, esbuild 0.27.7, Vite 7.3.3,
Rollup 4.63.4, Babel 7.29.0, vanilla-extract 1.20.1, React 19.2.6이다.
옵션별 5회 교차 실행 120개 표본과 브라우저 20개 표본을 기록했다.
[옵션별 원자료](atomic-runtime-results.json), [크기·빌드 시간](atomic-runtime-results.md),
[기본 설정 원자료](atomic-runtime-default-results.json)에 버전과 전체 표본을 남겼다.

### 정적 cx와 옵션별 비용

두 bundler 모두 3개의 정적 호출을 계산하고 scoped runtime helper를 제거했다.
아래 초기화는 unminified 모듈의 1회 import, heap은 GC 이후 import 중 발생한
할당량 변화이며 retained heap 측정이 아니다.

| Bundler | cx gzip JS 감소 | 초기화 ms, 기준 → 적용 | 초기화 할당 KiB, 기준 → 적용 |
| ------- | --------------: | ---------------------: | ---------------------------: |
| esbuild |     4,056 bytes |          14.84 → 12.42 |                893.4 → 844.4 |
| vite    |     4,110 bytes |          16.63 → 14.24 |              1262.2 → 1145.7 |

- `symbolicTokens`: 이 작은 cold fixture의 빌드는 esbuild +16.2%, Vite +5.1%였다.
  CSS 값 변경 시 참조 분석을 재사용하는 동작은 별도 cache 테스트로 확인했으며,
  이 cold 측정에서 빌드 속도 향상은 관찰되지 않았다.
- 조건부 atom 공유: 같은 파일의 중복 선언은 합쳐졌지만 두 owner만 있는 fixture에서는
  gzip CSS가 esbuild 17 bytes, Vite 16 bytes 늘었다. 이름과 조건 wrapper 비용도 고려해야 한다.
- boolean gate 단독: gzip CSS는 각각 53/43 bytes, 두 SSR 결과의 gzip HTML은
  38/26 bytes 늘었다. 작은 조건식에 무조건 적용할 최적화는 아니다.
- 브라우저는 `all`과 기준 `off`의 비교다. 200회 업데이트 중앙값은 esbuild
  32.5 → 44.5 ms, Vite 31.5 → 42.1 ms로 늘었다. React·DOM·style 계산을 포함하며,
  gate 단독 CPU 비용이나 CSS 엔진만의 시간으로 해석하지 않는다.
- atomic fixture는 직렬화 artifact를 만들기 위한 `extractCalls` bridge와 남아 있는
  authoring `defineRules` 호출을 포함한다. 따라서 절대 JS 크기는 일반 앱의 예상치가 아니다.
  이 fixture의 `off`에서도 compiler 경로 코드가 번들에 남아 minified JS가 837 bytes
  늘었지만, 아래 별도 프로덕션 기본 설정 fixture의 JS·CSS 크기와 결과 해시는 모두 같았다.
- 시간은 이 환경의 관측치다. 모든 스위치를 끄는 기존 기본값을 유지한다.

### 기본 설정 회귀 확인

기존 compilation fixture도 각 조합을 5회 비교했다. 아래 수치는 중앙값(ms)이며
Vite dev는 transform graph 측정으로 브라우저 HMR 지연 시간이 아니다.

| 조합                   |                      최초 |               변경 없음 |               leaf 변경 |             shared 변경 |
| ---------------------- | ------------------------: | ----------------------: | ----------------------: | ----------------------: |
| esbuild/esm/styles-24  |   961.68 → 963.66 (+0.2%) | 171.35 → 171.64 (+0.2%) | 242.49 → 240.24 (-0.9%) |                       — |
| esbuild/esm/shared-24  | 1068.75 → 1084.15 (+1.4%) | 177.60 → 181.58 (+2.2%) | 234.08 → 235.78 (+0.7%) | 409.91 → 416.73 (+1.7%) |
| vite/esm/styles-24     | 1123.15 → 1153.06 (+2.7%) |                       — |                       — |                       — |
| vite/esm/shared-24     | 1263.43 → 1291.35 (+2.2%) |                       — |                       — |                       — |
| vite-dev/esm/styles-24 | 1153.28 → 1175.07 (+1.9%) |    0.42 → 0.28 (-33.3%) |   39.27 → 39.73 (+1.2%) |                       — |
| vite-dev/esm/shared-24 | 1286.61 → 1293.71 (+0.6%) |    0.42 → 0.34 (-19.5%) |   39.77 → 41.21 (+3.6%) |                       — |

최초 빌드 중앙값 변화는 +0.2~+2.7%였다. 프로덕션 4개 조합은 JS·CSS의
raw/gzip/Brotli 크기와 기록된 결과 해시가 같았고, 개발 모드는 최종 asset 크기를
보고하지 않는다. 1ms 미만인 변경 없는 Vite dev 수치의 상대 백분율을 큰 속도
향상으로 해석하지 않는다. 전체 옵션을 켠 cold 비용이나 실험 옵션의 크기 증가는
이 기본 설정 회귀 표와 별도로 판단해야 한다.
