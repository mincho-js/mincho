# Compiler optimization 검증 기록

이 기록은 [compiler 구현 대응표](compiler-implementation.md)와
[옵션 안내](../compiler-optimizations.md)의 검증 근거다. 비교 기준은
`33911861`의 설치 패키지와 이번 변경을 적용한 설치 패키지다.

## 검증 조건

- Linux x64, Intel Core i5-8265U, 논리 CPU 8개, 메모리 15.3 GiB.
- 시간 비교는 npm 소비자의 ESM 빌드다. CJS/PnP 호환성은 설치 계약 검증에서 별도로 확인한다.
- Node 24.21.0, Vite 7.3.3, esbuild 0.27.7, Babel 7.29.0,
  vanilla-extract 1.20.1을 양쪽 설치본에 동일하게 사용한다.
- 기본값 결정용 실험과 최종 기본값 검증을 구분한다. 클래스 이름을 변경하는
  실험 옵션은 켜지 않는다.
- 각 round의 case 순서와 baseline/candidate 실행 순서를 교대한다.
- 빌드 시간 측정은 소스 테스트, 패키지 설치, Chromium 검증과 겹치지 않는다.
- 진단 계측 실행과 일반 시간 측정을 분리한다. 단일 진단 실행 시간은
  성능 개선 수치로 사용하지 않는다.

`styles-*`는 `rules({ base: ... })`, `shared-24`는 객체를 통째로 넘기는
공유 스타일을 사용한다. 이들은 새 리터럴 평가나 닫힌 데이터 그래프의
적용 대상이 아니므로 기존 처리 경로의 비용을 확인한다.
`vanilla-*`는 리터럴 `style(...)` 호출을 사용한다.
`tokens-members-24`는 다른 모듈의 `palette.brand.color`만 읽고 256개의
미사용 속성을 둬서 실제 속성 단위 의존성 분석을 확인한다.

## 기본값 결정용 실험

`dependencyGraph`와 `staticStyles`를 모두 켠 첫 구현을 5회씩 비교했다.
아래 값은 초기 빌드 시간의 중앙값(ms)이다. 양수 변화율은 느려졌다는 뜻이다.
지원하지 않는 입력의 사전 검사를 추가하기 전 결과이므로 최종 opt-in
구현의 성능 보장으로 사용하지 않는다.

| 번들러  | fixture             |   기준 | 두 옵션 활성 |   변화 |
| ------- | ------------------- | -----: | -----------: | -----: |
| esbuild | `styles-240`        | 5823.8 |       6496.9 | +11.6% |
| esbuild | `shared-24`         | 1072.7 |       1201.3 | +12.0% |
| esbuild | `vanilla-240`       | 3023.1 |       3316.1 |  +9.7% |
| esbuild | `tokens-members-24` | 1289.2 |       1473.0 | +14.3% |
| vite    | `styles-240`        | 6419.6 |       7031.6 |  +9.5% |
| vite    | `shared-24`         | 1277.6 |       1430.1 | +11.9% |
| vite    | `vanilla-240`       | 4667.2 |       4381.6 |  -6.1% |
| vite    | `tokens-members-24` | 1647.5 |       1976.0 | +19.9% |

8개 조합 모두 JS/CSS의 raw·gzip·Brotli 크기가 기준과 같았다. 이 실험은
native CSS 모드의 compiler 비용 비교이며 `dist-chunk` CSS 구조 최적화와
실험적 클래스 변경의 크기 효과를 측정한 것은 아니다.

Vite 리터럴 예제 외에는 초기 빌드의 일관된 개선을 확인하지 못했다.
따라서 두 옵션은 production/development 모두 기본 비활성으로 정했다.
기능과 명시적 `true` 지원은 유지하며, 프로젝트에서 측정한 뒤 선택한다.
문법 분석을 시작하기 전에 명확하게 지원 대상이 아닌 입력을 거르는
사전 검사도 추가해 opt-in 시 불필요한 작업을 줄인다.

캐시 오류 수정 후 `shared-24`의 반복 빌드 중앙값은 esbuild에서
187.3 → 187.9ms로 정상화됐다. 캐시 재사용 회귀가 남은 상태에서 기본값만
바꾼 것은 아니다. 원본 기록은
`.cache/compiler-audit-benchmark-verified/report.json`이다.

## 최종 기본값 비교

최종 구현에서 `dependencyGraph`·`staticStyles`를 기본 비활성으로 두고,
동일한 8개 조합의 초기 빌드를 5회씩 다시 비교했다. 총 80개 빌드를 수행했고,
이 시간 측정은 다른 테스트·설치·브라우저 작업과 겹치지 않았다.
아래 값은 중앙값(ms)이며 양수 변화율은 느려졌다는 뜻이다.

| 번들러  | fixture             |   기준 | 최종 기본값 |  변화 |
| ------- | ------------------- | -----: | ----------: | ----: |
| esbuild | `styles-240`        | 5812.0 |      5982.8 | +2.9% |
| esbuild | `shared-24`         | 1094.2 |      1095.0 | +0.1% |
| esbuild | `vanilla-240`       | 3103.4 |      3151.1 | +1.5% |
| esbuild | `tokens-members-24` | 1380.2 |      1308.4 | -5.2% |
| vite    | `styles-240`        | 6442.8 |      6524.7 | +1.3% |
| vite    | `shared-24`         | 1297.4 |      1307.4 | +0.8% |
| vite    | `vanilla-240`       | 4695.8 |      4801.4 | +2.2% |
| vite    | `tokens-members-24` | 1682.8 |      1694.5 | +0.7% |

8개 조합 모두 JS/CSS raw·gzip·Brotli 크기와 CSS hash가 같았고,
esbuild의 실행 결과 hash도 같았다. 이 비교도 native CSS 모드이므로
`dist-chunk` 구조 최적화의 크기 효과를 나타내지 않는다.

7개 조합에서 초기 빌드가 0.1~2.9% 느려졌고, esbuild token-member 예제는
5.2% 빨라졌다. 해당 token 예제도 실행 간 편차가 크므로 보편적인 성능
향상이나 무회귀를 주장하지 않는다. 이번 결과로 두 컴파일 옵션을 기본
활성화할 근거는 얻지 못했다. 원본 기록에는 각 조합의 min/max·사분위수,
heap/RSS와 설치된 compiler hash도 포함돼 있다.

원본 기록은 `.cache/compiler-audit-benchmark-defaults/report.json`이다.

## 검증 중 발견해 수정한 문제

- 존재하지 않는 Babel 설정 파일의 fingerprint가 이미 추적되고 있는데도
  이를 미관찰 입력으로 판단해 컴파일 캐시를 저장하지 못했다. 설정 파일의
  생성·삭제 감시는 유지하면서 알려진 fingerprint를 캐시 검증에 반영한다.
- 실제 Babel sidecar는 `var`와 이미 선언한 클래스의 별칭을 생성했다.
  정적 평가의 지원 문법에 이 형태를 추가하되 중복 선언, 선행 참조,
  재할당과 알 수 없는 표현식은 계속 기존 경로로 처리한다.
- 소비자별 export metadata가 공유 CSS의 identity에 들어가 동일한 provider
  CSS를 중복 생성할 수 있었다. CSS identity와 owner별 metadata를 분리하고
  owner 교체·제거 시 참조 정보를 재계산한다.
- CSS IR의 `NaN`, `Infinity`, `null`, `undefined`를 JSON의 기본 직렬화만으로
  구분하면 캐시 충돌이나 잘못된 선언 병합이 가능했다. identity 인코딩을
  구분하고 비유한 숫자는 선언 병합 대상에서 제외한다.
- `+1e999`와 `-1e999`는 Babel AST에서 부호 연산과 비유한 숫자로 나타난다.
  정적 평가 결과를 JSON으로 기록하면 `null`이 되어 의미가 바뀌므로,
  직접 숫자와 부호가 있는 숫자 모두 비유한 값은 기존 컴파일 경로로 처리한다.

## 설치 패키지의 opt-in 경로 확인

최종 패키지에서 두 옵션을 명시적으로 켠 진단 실행도 수행했다.
`vanilla-24`는 `static-styles-compile`, `static-styles-evaluate`,
`static-styles-execute`가 각각 24회 발생했고 esbuild/VM 평가 호출은
발생하지 않았다. `tokens-members-24`는 `dependency-graph`와
`dependency-graph-scope-skip`이 각각 24회 발생했다. 양쪽 모두 기존
설치본과 CSS 및 실행 결과 hash가 같았다.

이 실행은 기능 적용 여부와 자원 카운터를 확인하기 위한 것으로,
설치 계약 검증과 동시에 수행했다. 시간을 성능 비교에 사용하지 않는다.
원본 기록은 `.cache/compiler-audit-proof-final-defaults/report.json`이다.

## 실험적 클래스 옵션

설치 소비자의 작은 fixture에서 측정한 minified CSS다. 같은 파일의 중복과
다른 파일의 cascade 영역을 함께 포함한다.

| 옵션                       | CSS rule 수 | CSS raw bytes |
| -------------------------- | ----------: | ------------: |
| 기본값 또는 두 옵션 비활성 |           7 |           158 |
| `globalAtomicClasses`      |           5 |           243 |
| `compileClass`             |           3 |           102 |
| 두 옵션 활성               |           3 |           169 |

공유 이름은 35자이고 기존 fixture의 scoped 이름은 9자다. 따라서 rule 수가
줄어도 작은 선언에서는 총 CSS가 커질 수 있다. 두 옵션을 기본 비활성으로
유지하는 이유다. 큰 JS 감소에는 private `defineRules` owner와 그 authoring
runtime의 제거도 포함되므로 이를 이름 공유만의 효과로 해석하지 않는다.
동일 스타일의 원래 atom과 compound를 이중으로 출력하는 구조는 아니다.

## 보존한 한계

- 다른 파일의 임의 atom을 전역 CSS로 옮기지 않는다. 파일별 cascade 영역을
  지키며 선택적 이름 공유도 같은 원본 파일 안으로 제한한다.
- `shareAtoms`는 기존 native chunk의 안전한 공통 module prefix 공유를
  자동으로 선택한다. 임의 rule 단위의 전역 공유 기능은 아니다.
- `light-dark()` 변환과 일반 scoped `cx` table의 문자열 bake는 구현하지
  않았다. single-importer chunk 병합은 native bundler 정책을 사용한다.
- 동적으로 구성한 CSSOM 접근이나 외부 스크립트까지 변수 관찰 여부를 증명할
  수는 없다. 이런 코드가 생성된 변수를 관찰하면 `pruneGenerated: false`를
  사용한다.
- native esbuild의 루트 named import CSS 제거 제약은 유지한다. 선택적
  라이브러리 CSS가 필요하면 subpath import를 사용한다.

## 재현 방법

기준 revision과 변경 revision을 별도 checkout에서 `yarn build:release`로
빌드한 뒤, 현재 `scripts/benchmark-compilation.mjs`의
`--pack=<빌드한 저장소> --candidate=<새 소비자 디렉터리>`로 각각 설치한다.
동일한 스크립트를 사용해야 두 소비자의 Babel/vanilla-extract 버전도 일치한다.
기존 소비자 디렉터리를 덮어쓰지 않는다.

최종 기본값 비교 명령은 다음과 같다. 비교 중에는 다른 빌드·테스트·브라우저를
실행하지 않는다. `--first-only`는 초기 빌드만 측정한다.

```sh
mise exec -- yarn benchmark:compilation \
  --baseline=/var/tmp/mincho-compiler-baseline-33911861 \
  --candidate=/var/tmp/mincho-compiler-candidate-final-defaults-0924 \
  --baseline-label=33911861 \
  --candidate-label=compiler-optimizations-defaults \
  --cases=styles-240,shared-24,vanilla-240,tokens-members-24 \
  --rounds=5 --formats=esm --bundlers=esbuild,vite --first-only \
  --output=.cache/compiler-audit-benchmark-defaults
```

opt-in 진단은 같은 설치본에
`--candidate-options='{"optimize":{"dependencyGraph":true,"staticStyles":true}}'`
와 `--diagnostics --resources`를 추가하고, 별도 output 디렉터리를 지정한다.
실행한 작은 proof는 `--cases=vanilla-24,tokens-members-24 --bundlers=esbuild
--rounds=1 --first-only`를 사용했다. 반복·수정 빌드까지 보려면
`--first-only`를 제거한다.
