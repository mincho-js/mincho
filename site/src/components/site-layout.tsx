import type { ReactNode } from "react";
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
import "nextra-theme-docs/style.css";

export function siteMetadata(locale: Locale) {
  const i18n = getI18n(locale);
  return {
    title: "Mincho.js",
    description: i18n._({
      id: "site.description",
      message:
        "Natural CSS in TypeScript - A CSS-in-JS framework built on Vanilla Extract"
    }),
    alternates: languageAlternates("/")
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
    <html lang={locale} suppressHydrationWarning>
      <Head />
      <body suppressHydrationWarning>
        <LinguiProvider locale={locale} messages={i18n.messages}>
          <Layout
            navbar={
              <Navbar
                logo={<span style={{ fontWeight: 700 }}>Mincho.js</span>}
                logoLink={localizedPath("/", locale)}
                projectLink="https://github.com/mincho-js/mincho"
              >
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
            footer={<Footer>MIT {new Date().getFullYear()} © Mincho.js</Footer>}
          >
            {children}
          </Layout>
        </LinguiProvider>
      </body>
    </html>
  );
}
