import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

export const metadata = {
  title: 'Mincho.js',
  description: 'Natural CSS in TypeScript - A CSS-in-JS framework built on Vanilla Extract'
}

export default async function RootLayout({ children }) {
  const pageMap = await getPageMap()

  return (
    <html lang="en" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={
            <Navbar
              logo={<span style={{ fontWeight: 700 }}>Mincho.js</span>}
              projectLink="https://github.com/mincho-js/mincho"
            />
          }
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/mincho-js/mincho/tree/main/site"
          footer={<Footer>MIT {new Date().getFullYear()} © Mincho.js</Footer>}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
