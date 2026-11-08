import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";
import { languageAlternates, type Locale } from "../i18n/routing";

export type DocsPageProps = { params: Promise<{ mdxPath?: string[] }> };

export async function docsStaticParams(locale: Locale) {
  const pages = await generateStaticParamsFor("mdxPath")();
  return pages
    .filter(({ mdxPath }) => (mdxPath[0] === "ko") === (locale === "ko"))
    .map(({ mdxPath }) => ({
      mdxPath: locale === "ko" ? mdxPath.slice(1) : mdxPath
    }));
}

function contentPath(locale: Locale, mdxPath: string[] = []) {
  return locale === "ko" ? ["ko", ...mdxPath] : mdxPath;
}

export async function docsMetadata(locale: Locale, { params }: DocsPageProps) {
  const { mdxPath = [] } = await params;
  const { metadata } = await importPage(contentPath(locale, mdxPath));
  return {
    ...metadata,
    alternates: languageAlternates(
      `/docs${mdxPath.length ? `/${mdxPath.join("/")}` : ""}`
    )
  };
}

export async function DocsPage({
  locale,
  params
}: DocsPageProps & { locale: Locale }) {
  const resolvedParams = await params;
  const { default: MDXContent, ...page } = await importPage(
    contentPath(locale, resolvedParams.mdxPath)
  );
  const content = <MDXContent params={resolvedParams} />;
  // Webpack dev imports raw MDX; the Rspack production loader already wraps it.
  // Apply the docs shell exactly once in either mode.
  if (process.env.NODE_ENV === "development") {
    const Wrapper = getMDXComponents().wrapper;
    if (Wrapper) {
      // Dev timestamps are compilation times, not commit dates. Omitting them
      // also avoids Nextra's LastUpdated rendering error during dev SSR.
      const metadata = { ...page.metadata, timestamp: undefined };
      return (
        <Wrapper {...page} metadata={metadata}>
          {content}
        </Wrapper>
      );
    }
  }
  return content;
}
