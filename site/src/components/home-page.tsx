import Link from "next/link";
import { getI18n } from "../i18n/server";
import { localizedPath, type Locale } from "../i18n/routing";
import { ArrowIcon, BotanicalArt, SproutMark } from "./botanical-art";
import { CodeExample } from "./code-example";
import { CompareSection } from "./compare-section";
import { InstallCommand } from "./install-command";
import { WorkflowSection } from "./workflow-section";

export function HomePage({ locale }: { locale: Locale }) {
  const i18n = getI18n(locale);
  const features = [
    {
      number: "01",
      title: i18n._({
        id: "home.typed.title",
        message: "Typed from the first line"
      }),
      description: i18n._({
        id: "home.typed.body",
        message:
          "Let TypeScript guide your styles. Get autocomplete, useful errors, and familiar CSS properties, right in your editor."
      }),
      link: "/docs/literal",
      label: i18n._({ id: "home.typed.link", message: "Meet Literal CSS" })
    },
    {
      number: "02",
      title: i18n._({
        id: "home.static.title",
        message: "Static CSS at build time"
      }),
      description: i18n._({
        id: "home.static.body",
        message:
          "Write styles in TypeScript. Ship static CSS. Built on Vanilla Extract, Mincho does the styling work at build time."
      }),
      link: "/docs/getting-started",
      label: i18n._({ id: "home.static.link", message: "See how it works" })
    },
    {
      number: "03",
      title: i18n._({
        id: "home.system.title",
        message: "From one style to a design system"
      }),
      description: i18n._({
        id: "home.system.body",
        message:
          "Start with a single style. Grow into reusable rules, themes, and components that speak your design language."
      }),
      link: "/docs/define-rules",
      label: i18n._({ id: "home.system.link", message: "Explore design rules" })
    }
  ];

  return (
    <main id="nextra-skip-nav" className="mincho-home">
      <section className="mincho-hero" aria-labelledby="hero-title">
        <div className="mincho-hero-inner">
          <div className="mincho-hero-copy">
            <p className="mincho-eyebrow">
              <span className="mincho-small-star" aria-hidden="true">
                ✳
              </span>
              {i18n._({
                id: "home.tagline",
                message: "Natural CSS in TypeScript"
              })}
            </p>
            <h1 id="hero-title">
              <span>
                {i18n._({ id: "home.titleStart", message: "Let your" })}
              </span>
              <em>{i18n._({ id: "home.titleEnd", message: "styles grow" })}</em>
            </h1>
            <p className="mincho-hero-description">
              {i18n._({
                id: "home.description",
                message:
                  "A CSS-in-TypeScript framework built on Vanilla Extract. Write typed styles and ship static CSS."
              })}
            </p>
            <div className="mincho-hero-actions">
              <Link
                className="mincho-button mincho-button-citron"
                href={localizedPath("/docs/getting-started", locale)}
              >
                {i18n._({ id: "home.getStarted", message: "Get Started" })}
                <ArrowIcon />
              </Link>
              <Link className="mincho-text-link" href="#workflow">
                {i18n._({
                  id: "home.exploreFlow",
                  message: "Explore the workflow"
                })}
                <ArrowIcon diagonal />
              </Link>
            </div>
            <p className="mincho-hero-note">
              {i18n._({
                id: "home.note",
                message: "Open source under the MIT license"
              })}
            </p>
          </div>
          <div className="mincho-hero-visual">
            <BotanicalArt />
            <CodeExample />
          </div>
        </div>
      </section>

      <div className="mincho-foundations">
        <p>
          {i18n._({
            id: "home.foundation",
            message: "Built on"
          })}
        </p>
        <div>
          <span>TypeScript</span>
          <span>Vanilla Extract</span>
          <span>{i18n._({ id: "home.staticCss", message: "Static CSS" })}</span>
        </div>
      </div>

      <WorkflowSection locale={locale} />

      <CompareSection locale={locale} />

      <section className="mincho-features" aria-labelledby="features-title">
        <div className="mincho-section-heading">
          <p className="mincho-eyebrow">
            {i18n._({
              id: "home.featuresLabel",
              message: "Rooted in simplicity"
            })}
          </p>
          <h2 id="features-title">
            {i18n._({
              id: "home.featuresTitle",
              message: "Feels like CSS, grows with you"
            })}
          </h2>
        </div>
        <div className="mincho-feature-grid">
          {features.map((feature) => (
            <article className="mincho-feature" key={feature.number}>
              <span className="mincho-feature-number">{feature.number}</span>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
              <Link
                className="mincho-text-link"
                href={localizedPath(feature.link, locale)}
              >
                {feature.label}
                <ArrowIcon />
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="mincho-start" aria-labelledby="start-title">
        <div className="mincho-start-copy">
          <SproutMark />
          <h2 id="start-title">
            {i18n._({
              id: "home.startTitle",
              message: "Install Mincho and write your first style"
            })}
          </h2>
          <p>
            {i18n._({
              id: "home.startBody",
              message: "One command installs the packages for a Vite project."
            })}
          </p>
        </div>
        <div>
          <InstallCommand />
          <Link
            className="mincho-text-link"
            href={localizedPath("/docs/getting-started", locale)}
          >
            {i18n._({
              id: "home.setupGuide",
              message: "Follow the setup guide"
            })}
            <ArrowIcon />
          </Link>
        </div>
      </section>
    </main>
  );
}
