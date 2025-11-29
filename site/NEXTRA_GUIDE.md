# Nextra 4 문서 사이트 구성 가이드

> 이 가이드는 Mincho.js 문서 사이트 구축을 위한 Nextra 4 사용법을 정리한 것입니다.
> 공식 문서: https://nextra.site

---

## 1. 프로젝트 구조

```
site/
├── app/
│   └── [lang]/
│       ├── layout.tsx          # 메인 레이아웃 (Navbar, Footer, Sidebar)
│       └── [[...mdxPath]]/
│           └── page.tsx        # MDX 페이지 렌더링
├── content/
│   ├── en/                     # 영문 콘텐츠
│   │   ├── _meta.ts            # 사이드바 구성
│   │   ├── index.mdx           # 홈페이지
│   │   └── docs/
│   │       ├── _meta.ts
│   │       └── index.mdx
│   └── ko/                     # 한국어 콘텐츠
│       ├── _meta.ts
│       ├── index.mdx
│       └── docs/
├── mdx-components.tsx          # MDX 컴포넌트 커스터마이징
├── middleware.ts               # i18n 자동 리다이렉트 (선택)
├── next.config.mjs             # Next.js + Nextra 설정
├── package.json
└── tsconfig.json
```

---

## 2. 핵심 설정 파일

### 2.1 next.config.mjs

```javascript
import nextra from 'nextra'

const withNextra = nextra({
  // Nextra 옵션
  latex: true,              // LaTeX 수식 지원
  search: {
    codeblocks: true        // 코드 블록도 검색 대상에 포함
  },
  defaultShowCopyCode: true // 코드 블록에 복사 버튼 표시
})

export default withNextra({
  // Next.js 옵션
  i18n: {
    locales: ['en', 'ko'],
    defaultLocale: 'en'
  }
})
```

### 2.2 app/[lang]/layout.tsx

```tsx
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";

const navbar = (
  <Navbar
    logo={<strong>Mincho.js</strong>}
    projectLink="https://github.com/peebles-io/mincho"
  />
);

const footer = <Footer>MIT {new Date().getFullYear()} © Mincho.js</Footer>;

export default async function RootLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const pageMap = await getPageMap(lang);

  return (
    <html lang={lang} dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          footer={footer}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/mincho-js/mincho/tree/main/site"
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
```

### 2.3 mdx-components.tsx

```tsx
import { useMDXComponents as getDocsMDXComponents } from "nextra-theme-docs";

const docsComponents = getDocsMDXComponents();

export function useMDXComponents(components?: Record<string, unknown>) {
  return {
    ...docsComponents,
    ...components
  };
}
```

---

## 3. 콘텐츠 구성: _meta.ts

`_meta.ts` 파일은 사이드바의 페이지 순서, 제목, 표시 여부를 제어합니다.

### 3.1 기본 사용법

```typescript
// content/en/_meta.ts
export default {
  index: "Home",           // index.mdx의 사이드바 제목
  docs: "Documentation",   // docs/ 폴더의 제목
  about: "About"
}
```

### 3.2 페이지 타입 설정

```typescript
export default {
  // 일반 페이지 (사이드바에 표시)
  index: "Introduction",

  // 네비게이션 바에 표시되는 페이지
  frameworks: {
    title: "Frameworks",
    type: "page"
  },

  // 숨김 페이지 (URL로만 접근 가능)
  internal: {
    display: "hidden"
  },

  // 외부 링크
  github: {
    title: "GitHub",
    href: "https://github.com/mincho-js/mincho"
  },

  // 구분선
  "---": {
    type: "separator"
  },

  // 제목이 있는 구분선
  "###": {
    type: "separator",
    title: "Advanced"
  }
}
```

### 3.3 테마 옵션

```typescript
export default {
  "full-page": {
    title: "Full Width Page",
    theme: {
      layout: "full",          // 'default' | 'full'
      sidebar: false,          // 사이드바 숨기기
      toc: false,              // 목차 숨기기
      navbar: true,            // 네비게이션 바 표시
      typesetting: "article"   // 'default' | 'article' (더 넓은 본문)
    }
  }
}
```

### 3.4 드롭다운 메뉴

```typescript
export default {
  company: {
    title: "Company",
    type: "menu",
    items: {
      about: { title: "About Us", href: "/about" },
      team: { title: "Team", href: "/team" },
      careers: { title: "Careers", href: "https://careers.example.com" }
    }
  }
}
```

---

## 4. MDX 문서 작성

### 4.1 기본 마크다운

```mdx
# 제목 1
## 제목 2
### 제목 3

일반 텍스트 **굵게** *기울임* ~~취소선~~

- 목록 1
- 목록 2
  - 중첩 목록

1. 번호 목록
2. 두 번째

> 인용문

[링크](https://example.com)

![이미지](/images/example.png)
```

### 4.2 GFM (GitHub Flavored Markdown)

```mdx
<!-- 체크리스트 -->
- [x] 완료된 항목
- [ ] 미완료 항목

<!-- 테이블 -->
| 기능 | 상태 |
|------|------|
| CSS | 완료 |
| React | 진행중 |

<!-- 자동 링크 -->
https://nextra.site 는 자동으로 링크가 됩니다.
```

### 4.3 커스텀 제목 ID

```mdx
## Very Long Heading Title [#short-id]

위 제목은 `#short-id`로 앵커 링크됩니다.
```

---

## 5. 코드 블록 기능

### 5.1 구문 강조

````mdx
```javascript
const greeting = "Hello, Nextra!";
console.log(greeting);
```
````

### 5.2 라인 강조

````mdx
```javascript {1,4-5}
// 이 줄은 강조됩니다 (1번)
const x = 1;
const y = 2;
const z = 3; // 강조 (4번)
const w = 4; // 강조 (5번)
```
````

### 5.3 특정 단어 강조

````mdx
```javascript /useState/
import { useState } from 'react';
const [count, setCount] = useState(0);
```
````

### 5.4 파일명 표시

````mdx
```typescript filename="utils/helper.ts"
export function helper() {
  return "Hello";
}
```
````

### 5.5 라인 번호

````mdx
```typescript showLineNumbers
const line1 = 1;
const line2 = 2;
const line3 = 3;
```
````

### 5.6 복사 버튼

````mdx
```bash copy
npm install @mincho-js/css
```
````

---

## 6. 내장 컴포넌트

### 6.1 Callout (알림 박스)

```mdx
import { Callout } from 'nextra/components'

<Callout>
  기본 알림입니다.
</Callout>

<Callout type="info">
  정보성 알림입니다.
</Callout>

<Callout type="warning">
  경고 알림입니다.
</Callout>

<Callout type="error">
  에러/위험 알림입니다.
</Callout>

<Callout type="important">
  중요한 알림입니다.
</Callout>

<Callout emoji="🚀">
  커스텀 이모지 알림입니다.
</Callout>
```

**타입별 기본 아이콘:**
- `default`: 팁 아이콘
- `info`: 정보 아이콘
- `warning`: 경고 아이콘
- `error`: 위험 아이콘
- `important`: 중요 아이콘

### 6.2 Tabs (탭)

```mdx
import { Tabs } from 'nextra/components'

<Tabs items={['npm', 'yarn', 'pnpm']}>
  <Tabs.Tab>
    ```bash
    npm install @mincho-js/css
    ```
  </Tabs.Tab>
  <Tabs.Tab>
    ```bash
    yarn add @mincho-js/css
    ```
  </Tabs.Tab>
  <Tabs.Tab>
    ```bash
    pnpm add @mincho-js/css
    ```
  </Tabs.Tab>
</Tabs>
```

**주요 옵션:**
- `items`: 탭 이름 배열
- `defaultIndex`: 기본 선택 탭 (0부터 시작)
- `storageKey`: localStorage에 선택 상태 저장

### 6.3 Steps (단계)

```mdx
import { Steps } from 'nextra/components'

<Steps>
### 패키지 설치

먼저 패키지를 설치합니다.

```bash
npm install @mincho-js/css
```

### 설정 파일 생성

프로젝트 루트에 설정 파일을 생성합니다.

### 사용 시작

이제 스타일을 작성할 수 있습니다.
</Steps>
```

### 6.4 Cards (카드)

```mdx
import { Cards } from 'nextra/components'

<Cards>
  <Cards.Card
    icon={<span>📚</span>}
    title="Getting Started"
    href="/docs/getting-started"
  />
  <Cards.Card
    icon={<span>🔧</span>}
    title="API Reference"
    href="/docs/api"
    arrow
  />
</Cards>
```

**주요 옵션:**
- `icon`: 카드 아이콘
- `title`: 카드 제목
- `href`: 링크
- `arrow`: 화살표 표시

### 6.5 FileTree (파일 트리)

```mdx
import { FileTree } from 'nextra/components'

<FileTree>
  <FileTree.Folder name="src" defaultOpen>
    <FileTree.File name="index.ts" />
    <FileTree.Folder name="components">
      <FileTree.File name="Button.tsx" />
      <FileTree.File name="Card.tsx" />
    </FileTree.Folder>
    <FileTree.Folder name="styles">
      <FileTree.File name="theme.css.ts" />
    </FileTree.Folder>
  </FileTree.Folder>
  <FileTree.File name="package.json" />
</FileTree>
```

---

## 7. i18n (국제화)

### 7.1 설정

```javascript
// next.config.mjs
export default withNextra({
  i18n: {
    locales: ['en', 'ko'],
    defaultLocale: 'en'
  }
})
```

### 7.2 콘텐츠 구조

```
content/
├── en/
│   ├── _meta.ts
│   ├── index.mdx
│   └── docs/
│       └── index.mdx
└── ko/
    ├── _meta.ts        # 한국어 메뉴명
    ├── index.mdx       # 한국어 홈
    └── docs/
        └── index.mdx   # 한국어 문서
```

### 7.3 자동 리다이렉트 (선택)

```typescript
// middleware.ts
export { middleware } from 'nextra/locales'
```

이 미들웨어는 브라우저 언어 설정을 감지하여 자동으로 해당 언어로 리다이렉트합니다.

---

## 8. 검색 기능 (Pagefind)

### 8.1 설치

```bash
npm install -D pagefind
```

### 8.2 빌드 스크립트 추가

```json
// package.json
{
  "scripts": {
    "build": "next build",
    "postbuild": "pagefind --site .next/server/app --output-path public/_pagefind"
  }
}
```

### 8.3 .gitignore에 추가

```
_pagefind/
```

---

## 9. 정적 내보내기 (Static Export)

GitHub Pages 등에 배포할 때 사용합니다.

```javascript
// next.config.mjs
export default withNextra({
  output: 'export',
  images: {
    unoptimized: true
  }
})
```

```json
// package.json
{
  "scripts": {
    "postbuild": "pagefind --site .next/server/app --output-path out/_pagefind"
  }
}
```

---

## 10. 문서 작성 모범 사례

### 10.1 파일 명명 규칙

- 파일명은 URL 경로가 됩니다: `getting-started.mdx` → `/docs/getting-started`
- 소문자와 하이픈 사용 권장
- `index.mdx`는 폴더의 기본 페이지

### 10.2 제목 구조

```mdx
# 페이지 제목 (H1은 페이지당 1개만)

## 주요 섹션 (H2)

### 하위 섹션 (H3)

#### 세부 항목 (H4)
```

### 10.3 코드 예제 작성

```mdx
import { Tabs, Callout } from 'nextra/components'

## 설치

<Tabs items={['npm', 'yarn', 'pnpm']}>
  <Tabs.Tab>
    ```bash copy
    npm install @mincho-js/css
    ```
  </Tabs.Tab>
  ...
</Tabs>

<Callout type="info">
  React 18 이상이 필요합니다.
</Callout>

## 기본 사용법

```typescript filename="styles.css.ts" {3-5}
import { css } from '@mincho-js/css';

export const button = css({
  backgroundColor: 'blue',
  color: 'white'
});
```
```

### 10.4 링크 작성

```mdx
<!-- 내부 링크 (상대 경로) -->
[시작하기](/docs/getting-started)
[API 문서](./api-reference)

<!-- 외부 링크 -->
[GitHub](https://github.com/mincho-js/mincho)
```

---

## 11. 참고 자료

- **Nextra 공식 문서**: https://nextra.site
- **Nextra GitHub**: https://github.com/shuding/nextra
- **MDX 문서**: https://mdxjs.com
- **Next.js 문서**: https://nextjs.org/docs

---

## 12. 현재 site/ 세팅 상태

- [x] Nextra 4 + Next.js 15 설치
- [x] i18n 설정 (en, ko)
- [x] 기본 레이아웃 구성
- [x] 콘텐츠 디렉토리 구조
- [ ] 검색 기능 (Pagefind)
- [ ] 실제 문서 콘텐츠 작성
- [ ] 커스텀 스타일링
- [ ] 배포 설정
