import type { ReactNode } from "react";
import Link from "next/link";
import { GeistMono } from "geist/font/mono";
import type { PageMapItem } from "nextra";
import { Footer, LastUpdated, Layout, Navbar } from "nextra-theme-docs";
import { Head, Search } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { getI18n } from "../i18n/server";
import {
  languageAlternates,
  localizedPath,
  type Locale
} from "../i18n/routing";
import { LanguageSwitcher } from "./language-switcher";
import { LinguiProvider } from "./lingui-provider";
import { Brand } from "./brand";
import { basePath } from "../../site.config.mjs";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "nextra-theme-docs/style.css";
import "../styles/site.css";

export function siteMetadata(locale: Locale) {
  const i18n = getI18n(locale);
  return {
    title: "Mincho.js",
    description: i18n._({
      id: "site.description",
      message:
        "Natural CSS in TypeScript - A CSS-in-JS framework built on Vanilla Extract"
    }),
    alternates: languageAlternates("/"),
    icons: {
      icon: [
        { url: `${basePath}/favicon.ico`, sizes: "16x16 32x32 48x48" },
        { url: `${basePath}/favicon.svg`, type: "image/svg+xml", sizes: "any" }
      ],
      apple: { url: `${basePath}/apple-touch-icon.png`, sizes: "180x180" }
    }
  };
}

function koreanPageMap(items: PageMapItem[]): PageMapItem[] {
  return items.map((item) => {
    if (!("route" in item)) return item;
    return {
      ...item,
      route: item.route.replace(/^\/docs\/ko(?=\/|$)/, "/ko/docs"),
      ...("children" in item ? { children: koreanPageMap(item.children) } : {})
    };
  });
}

export async function SiteLayout({
  locale,
  children
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const i18n = getI18n(locale);
  const pageMap =
    locale === "ko"
      ? koreanPageMap(await getPageMap("/docs/ko"))
      : (await getPageMap("/docs")).filter(
          (item) => !("name" in item) || item.name !== "ko"
        );

  return (
    <html
      lang={locale}
      className={`mincho-site ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <Head
        color={{
          hue: 148,
          saturation: 62,
          lightness: { light: 32, dark: 65 }
        }}
        backgroundColor={{ light: "#f5f3e9", dark: "#151d17" }}
      />
      <body suppressHydrationWarning>
        <LinguiProvider locale={locale} messages={i18n.messages}>
          <Layout
            nextThemes={{ defaultTheme: "light" }}
            navbar={
              <Navbar
                className="mincho-navbar"
                logo={<Brand />}
                logoLink={localizedPath("/", locale)}
                projectLink="https://github.com/mincho-js/mincho"
              >
                <Link
                  className="mincho-nav-docs"
                  href={localizedPath("/docs", locale)}
                >
                  {i18n._({ id: "nav.docs", message: "Documentation" })}
                </Link>
                <LanguageSwitcher />
              </Navbar>
            }
            pageMap={pageMap}
            docsRepositoryBase="https://github.com/mincho-js/mincho/tree/main/site"
            editLink={i18n._({ id: "docs.edit", message: "Edit this page" })}
            feedback={{
              content: i18n._({
                id: "docs.feedback",
                message: "Question? Give us feedback"
              })
            }}
            toc={{
              title: i18n._({ id: "docs.onThisPage", message: "On This Page" }),
              backToTop: i18n._({
                id: "docs.backToTop",
                message: "Scroll to top"
              })
            }}
            themeSwitch={{
              dark: i18n._({ id: "theme.dark", message: "Dark" }),
              light: i18n._({ id: "theme.light", message: "Light" }),
              system: i18n._({ id: "theme.system", message: "System" })
            }}
            lastUpdated={
              <LastUpdated locale={locale}>
                {i18n._({ id: "docs.lastUpdated", message: "Last updated on" })}
              </LastUpdated>
            }
            search={
              <Search
                key={locale}
                placeholder={i18n._({
                  id: "search.placeholder",
                  message: "Search documentation…"
                })}
                aria-label={i18n._({
                  id: "search.label",
                  message: "Search documentation"
                })}
                emptyResult={i18n._({
                  id: "search.empty",
                  message: "No results found."
                })}
                errorText={i18n._({
                  id: "search.error",
                  message: "Failed to load search index."
                })}
                loading={i18n._({ id: "search.loading", message: "Loading…" })}
              />
            }
            footer={
              <Footer className="mincho-footer">
                <div className="mincho-footer-brand">
                  <Brand />
                  <p>
                    {i18n._({
                      id: "footer.tagline",
                      message: "A natural way to make the web."
                    })}
                  </p>
                </div>
                <div className="mincho-footer-links">
                  <Link href={localizedPath("/docs", locale)}>
                    {i18n._({ id: "nav.docs", message: "Documentation" })}
                  </Link>
                  <a href="https://github.com/mincho-js/mincho">GitHub ↗</a>
                  <span>© {new Date().getFullYear()} Mincho.js · MIT</span>
                </div>
              </Footer>
            }
          >
            {children}
          </Layout>
        </LinguiProvider>
      </body>
    </html>
  );
}
