# Mincho.js 문서 사이트 구축 요약

## 1. 문서 프레임워크 선택: Nextra vs Fumadocs

### 검토 배경
Mincho.js 라이브러리의 공식 문서 사이트를 구축하기 위해 두 가지 프레임워크를 검토했습니다.

### 후보 비교

| 항목 | Nextra 4 | Fumadocs |
|------|----------|----------|
| **기반** | Next.js | Next.js |
| **성숙도** | 2020년~, 안정적 | 2023년~, 비교적 신생 |
| **GitHub Stars** | ~12k | ~2k |
| **i18n 지원** | 내장 지원 | 내장 지원 |
| **테마** | nextra-theme-docs (완성도 높음) | 커스텀 필요 |
| **설정 복잡도** | 낮음 | 중간 |
| **커뮤니티** | 대규모 | 성장 중 |

### Nextra 선택 이유

1. **검증된 안정성**: Vercel 공식 문서, SWR, Turbo 등 대형 프로젝트에서 사용
2. **풍부한 생태계**: 플러그인, 테마, 예제가 풍부함
3. **i18n 기본 지원**: 영어/한국어 다국어 지원이 목표였으므로 중요
4. **낮은 학습 곡선**: MDX 기반으로 빠른 문서 작성 가능
5. **유사 프로젝트 참고**: vanilla-extract, emotion 등 CSS-in-JS 라이브러리들이 Nextra 또는 유사한 구조 사용

### Fumadocs를 선택하지 않은 이유

1. **React 19 강제 의존**: Fumadocs 15.x는 React 19를 요구하지만, monorepo 내 다른 패키지들이 React 18 기준
2. **호환성 이슈 발생**: 설치 시 peer dependency 충돌 다수 발생
3. **상대적으로 적은 레퍼런스**: 문제 발생 시 해결책 찾기 어려움

---

## 2. 직면한 문제들과 해결 과정

### 문제 1: Yarn pnpm linker와 Next.js 호환성 문제

#### 증상
```
Error: Invariant: Expected relative import to start with 'next/'
```

#### 원인
- Mincho monorepo는 `nodeLinker: pnpm` 설정 사용 중
- Yarn의 pnpm linker는 `.yarn/.store/` 디렉토리에 symlink 구조 생성
- Next.js의 내부 모듈 해석 로직이 이 symlink 구조에서 정상 작동하지 않음

#### 해결 방안 검토

**옵션 1: Yarn 유지 + nodeLinker를 node-modules로 변경**
- 장점: 변경 최소화, 즉시 적용 가능
- 단점: 디스크 공간 증가, pnpm linker의 엄격한 의존성 격리 상실

**옵션 2: pnpm으로 패키지 매니저 전환**
- 장점: vanilla-extract와 동일 환경, 디스크 효율
- 단점: 전체 마이그레이션 필요 (2-4시간 소요)

#### 선택한 해결책
**옵션 1 채택** - 단기적으로 문서 사이트 구축에 집중하기 위해

```yaml
# .yarnrc.yml
nodeLinker: node-modules  # pnpm에서 변경
```

#### 참고: 다른 프로젝트들의 설정
| 프로젝트 | 패키지 매니저 | nodeLinker |
|---------|-------------|------------|
| vanilla-extract | pnpm (네이티브) | - |
| emotion | Yarn | node-modules |
| mincho (변경 후) | Yarn 4 | node-modules |

---

### 문제 2: 루트 경로 404 에러

#### 증상
- `http://localhost:3000` 접속 시 404

#### 원인
- i18n 설정으로 인해 `/en`, `/ko` 경로만 유효
- 루트 페이지가 없음

#### 해결
`app/page.tsx` 추가하여 `/en`으로 리다이렉트:

```tsx
import { redirect } from "next/navigation";

export default function RootPage() {
  redirect("/en");
}
```

---

### 문제 3: _meta.ts 유효성 검사 실패

#### 증상
```
Error: Validation of "_meta" file has failed.
The field key "getting-started" in `_meta` file refers to a page that cannot be found
```

#### 원인
- `_meta.ts`에 "getting-started" 항목이 정의되어 있으나
- 실제 `getting-started.mdx` 파일이 존재하지 않음

#### 해결
`_meta.ts`에서 존재하지 않는 페이지 항목 제거:

```ts
// content/en/docs/_meta.ts
export default {
  index: "Introduction"
  // "getting-started" 제거
};
```

---

### 문제 4: Hydration 에러

#### 증상
```
Error: Hydration failed because the initial UI does not match what was rendered on the server.
Expected server HTML to contain a matching <style> in <head>.
```

#### 원인
- `app/layout.tsx`와 `app/[lang]/layout.tsx` 둘 다 `<html>` 태그 포함
- 중복된 HTML 구조로 인한 서버/클라이언트 불일치

#### 해결
중복되는 `app/layout.tsx` 삭제. `[lang]/layout.tsx`가 이미 완전한 HTML 구조 제공.

---

## 3. 현재 프로젝트 구조

```
mincho/
├── .yarnrc.yml              # nodeLinker: node-modules
├── package.json             # workspaces에 "site" 추가
├── site/                    # 문서 사이트 (Nextra 4)
│   ├── app/
│   │   ├── page.tsx         # 루트 → /en 리다이렉트
│   │   └── [lang]/
│   │       ├── layout.tsx   # 메인 레이아웃
│   │       └── [[...mdxPath]]/
│   │           └── page.tsx # MDX 페이지 렌더링
│   ├── content/
│   │   ├── en/              # 영문 콘텐츠
│   │   │   ├── _meta.ts
│   │   │   ├── index.mdx
│   │   │   └── docs/
│   │   └── ko/              # 한국어 콘텐츠
│   │       ├── _meta.ts
│   │       ├── index.mdx
│   │       └── docs/
│   ├── next.config.mjs      # i18n: en, ko
│   ├── package.json
│   └── tsconfig.json
└── docs/
    └── PACKAGE_MANAGER_DECISION.md  # 패키지 매니저 결정 문서
```

---

## 4. 커밋 이력

```
858c224 Chore: setup documentation site with Nextra 4
  - /site 디렉토리 추가 (Nextra 4 + Next.js 14)
  - nodeLinker: pnpm → node-modules 변경
  - workspaces에 site 추가
  - i18n 설정 (en, ko)
```

---

## 5. TODO: 앞으로 해야 할 작업

### 즉시 해야 할 작업

- [ ] **현재 변경사항 커밋**: _meta.ts 수정, layout.tsx 삭제, page.tsx 추가
- [ ] **빌드 테스트**: `yarn workspace site build` 실행하여 프로덕션 빌드 확인

### 문서 콘텐츠 작성

- [ ] **Getting Started 문서 작성**
  - 설치 방법 (`npm install @mincho-js/css`)
  - 기본 사용법
  - Quick Start 예제

- [ ] **API Reference 작성**
  - CSS Literals API
  - Theme API
  - Utility Functions

- [ ] **한국어 번역**
  - 영문 문서 완성 후 한국어 번역 진행

### 사이트 개선

- [ ] **docsRepositoryBase 수정**: 현재 `peebles-io/mincho` → 실제 repo 경로로 변경
- [ ] **로고 추가**: Mincho.js 로고 이미지 적용
- [ ] **SEO 설정**: 메타데이터, OG 이미지 설정
- [ ] **검색 기능**: Algolia 또는 내장 검색 설정
- [ ] **다크 모드**: 테마 토글 기능 확인

### 배포

- [ ] **Vercel 배포 설정**
  - `site` 디렉토리를 루트로 설정
  - 환경 변수 설정 (필요시)

- [ ] **커스텀 도메인 연결** (선택)

### 장기 검토 사항

- [ ] **pnpm 전환 검토**: 팀 논의 후 결정
  - 별도 브랜치에서 마이그레이션 테스트
  - CI/CD, 스크립트 변경 사항 확인
  - 충분한 테스트 후 병합

---

## 6. 실행 방법

### 개발 서버 실행
```bash
cd site
yarn dev
# http://localhost:3000 접속
```

### 프로덕션 빌드
```bash
cd site
yarn build
yarn start
```

### 루트에서 실행
```bash
yarn workspace site dev
yarn workspace site build
```

---

## 7. 참고 자료

- [Nextra 공식 문서](https://nextra.site)
- [vanilla-extract 문서 사이트](https://vanilla-extract.style) - 참고용
- [emotion 문서 사이트](https://emotion.sh) - 참고용
- [Next.js i18n 문서](https://nextjs.org/docs/app/building-your-application/routing/internationalization)
