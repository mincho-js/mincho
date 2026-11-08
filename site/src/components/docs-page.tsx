import { generateStaticParamsFor, importPage } from "nextra/pages";
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
  // Nextra's imported page already applies the MDX wrapper with its metadata
  // and table of contents. Wrapping it again duplicates the entire docs shell.
  const { default: MDXContent } = await importPage(
    contentPath(locale, resolvedParams.mdxPath)
  );
  return <MDXContent params={resolvedParams} />;
}
