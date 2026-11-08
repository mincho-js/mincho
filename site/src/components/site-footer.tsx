import Link from "next/link";
import { ThemeSwitch } from "nextra-theme-docs";
import { getI18n } from "../i18n/server";
import { localizedPath, type Locale } from "../i18n/routing";
import { ArrowIcon } from "./botanical-art";
import { Brand } from "./brand";

export function SiteFooter({ locale }: { locale: Locale }) {
  const i18n = getI18n(locale);
  const groups = [
    {
      title: i18n._({ id: "footer.learn", message: "Start here" }),
      links: [
        {
          label: i18n._({ id: "footer.introduction", message: "Introduction" }),
          href: localizedPath("/docs", locale)
        },
        {
          label: i18n._({
            id: "footer.getStarted",
            message: "Getting started"
          }),
          href: localizedPath("/docs/getting-started", locale)
        },
        { label: "Literal CSS", href: localizedPath("/docs/literal", locale) }
      ]
    },
    {
      title: i18n._({ id: "footer.build", message: "Build with Mincho" }),
      links: [
        { label: "theme", href: localizedPath("/docs/theme", locale) },
        {
          label: "defineRules",
          href: localizedPath("/docs/define-rules", locale)
        },
        { label: "rules", href: localizedPath("/docs/rules", locale) },
        { label: "cx", href: localizedPath("/docs/classname", locale) }
      ]
    },
    {
      title: i18n._({ id: "footer.project", message: "Project" }),
      links: [
        { label: "GitHub", href: "https://github.com/mincho-js/mincho" },
        { label: "npm", href: "https://www.npmjs.com/package/@mincho-js/css" },
        {
          label: i18n._({ id: "footer.changelog", message: "Changelog" }),
          href: "https://github.com/mincho-js/mincho/blob/main/packages/css/CHANGELOG.md"
        }
      ]
    }
  ];

  return (
    <footer className="mincho-footer">
      <div className="mincho-footer-inner">
        <div className="mincho-footer-top">
          <div className="mincho-footer-brand">
            <Link href={localizedPath("/", locale)}>
              <Brand />
            </Link>
            <p>
              {i18n._({
                id: "footer.tagline",
                message: "A natural way to make the web."
              })}
            </p>
          </div>
          <nav
            className="mincho-footer-nav"
            aria-label={i18n._({
              id: "footer.navigation",
              message: "Footer navigation"
            })}
          >
            {groups.map((group) => (
              <div key={group.title} className="mincho-footer-group">
                <h2>{group.title}</h2>
                <ul>
                  {group.links.map((link) => (
                    <li key={link.href}>
                      {link.href.startsWith("https://") ? (
                        <a href={link.href}>
                          {link.label}
                          <ArrowIcon diagonal />
                        </a>
                      ) : (
                        <Link href={link.href}>{link.label}</Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="mincho-footer-bottom">
          <p className="mincho-footer-copyright">
            <span>© {new Date().getFullYear()} Mincho.js</span>
            <a href="https://github.com/mincho-js/mincho/blob/main/LICENSE">
              {i18n._({ id: "footer.license", message: "MIT license" })}
            </a>
          </p>
          <div className="mincho-footer-actions">
            <ThemeSwitch className="mincho-footer-theme" />
            <a className="mincho-footer-back-top" href="#top">
              {i18n._({ id: "footer.backToTop", message: "Back to top" })}
              <ArrowIcon />
            </a>
          </div>
        </div>
      </div>
      <svg
        className="mincho-footer-stripes"
        viewBox="0 0 100 200"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {Array.from({ length: 20 }, (_, index) => (
          <rect
            key={index}
            y={index * 10}
            width="100"
            height={5 - index * 0.25}
            fill="currentColor"
          />
        ))}
      </svg>
    </footer>
  );
}
