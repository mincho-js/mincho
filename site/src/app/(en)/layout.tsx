import type { ReactNode } from "react";
import { SiteLayout, siteMetadata } from "../../components/site-layout";

export const generateMetadata = () => siteMetadata("en");

export default function EnglishLayout({ children }: { children: ReactNode }) {
  return <SiteLayout locale="en">{children}</SiteLayout>;
}
