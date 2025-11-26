import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import type { ReactNode } from "react";
import "nextra-theme-docs/style.css";

export const metadata = {
  title: "Mincho.js",
  description: "Mincho.js Documentation"
};

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
  children: ReactNode;
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
          docsRepositoryBase="https://github.com/peebles-io/mincho/tree/main/apps/docs"
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
